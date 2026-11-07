import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { StorageEntry, StorageKind, StorageSnapshot } from '@gearmod/contracts'
import { tm } from './i18n'

export interface StorageDirs {
  /** The app's data folder (database, backups, attachments, worktrees, whisper). */
  dataDir: string
  /** Where the app puts the tools it installs (Playwright CLI, browsers, portable Node). */
  toolsDir: string
  /** Where the update installers are downloaded. */
  updatesDir: string
}

/** Size of a folder, counting file sizes. Stops after `budgetMs` and says so (`partial`), since a worktree full of dependencies can have a lot of files. */
export async function folderSize(path: string, budgetMs = 15_000): Promise<{ bytes: number; partial: boolean }> {
  const deadline = Date.now() + budgetMs
  let bytes = 0, partial = false
  const walk = async (dir: string): Promise<void> => {
    if (Date.now() > deadline) { partial = true; return }
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    const folders: string[] = []
    await Promise.all(entries.map(async (entry) => {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) return  // a link is not space of its own, and following it could leave the folder
      if (entry.isDirectory()) folders.push(full)
      else try { bytes += (await stat(full)).size } catch { /* gone meanwhile */ }
    }))
    for (const folder of folders) await walk(folder)
  }
  try {
    const info = await stat(path)
    if (info.isDirectory()) await walk(path); else bytes = info.size
  } catch { return { bytes: 0, partial: false } }
  return { bytes, partial }
}

type Candidate = { id: string; kind: StorageKind; name: string; path: string; removable: boolean }

/**
 * What the app keeps on disk and how much space it takes, with removal only for what can safely come back (tools and models are downloaded again when needed;
 * old backups and update installers are not needed). The renderer only ever sends an id: it is checked against the current list, never used as a path.
 */
export class StorageService {
  constructor(private readonly dirs: StorageDirs) {}

  private async children(dir: string): Promise<string[]> {
    try { return (await readdir(dir)).sort() } catch { return [] }
  }

  private async candidates(): Promise<Candidate[]> {
    const { dataDir, toolsDir, updatesDir } = this.dirs
    const found: Candidate[] = []
    const add = (kind: StorageKind, key: string, path: string, removable: boolean): void => { if (existsSync(path)) found.push({ id: `${kind}:${key}`, kind, name: key, path, removable }) }
    for (const version of await this.children(join(toolsDir, 'playwright-cli'))) add('playwright-version', version, join(toolsDir, 'playwright-cli', version), true)
    add('playwright-browsers', 'playwright-browsers', join(toolsDir, 'playwright-browsers'), true)
    add('node', 'node', join(toolsDir, 'node'), true)
    for (const file of await this.children(join(dataDir, 'whisper', 'models'))) add('voice-model', file, join(dataDir, 'whisper', 'models', file), true)
    add('voice-engine', 'bin', join(dataDir, 'whisper', 'bin'), false)
    for (const backup of await this.children(join(dataDir, 'backups'))) add('backup', backup, join(dataDir, 'backups', backup), true)
    for (const item of await this.children(updatesDir)) add('update-download', item, join(updatesDir, item), true)
    add('worktrees', 'wt', join(dataDir, 'wt'), false)
    add('attachments', 'attachments', join(dataDir, 'attachments'), false)
    add('database', 'gearmod.sqlite', join(dataDir, 'gearmod.sqlite'), false)
    return found
  }

  async list(): Promise<StorageSnapshot> {
    const sized = await Promise.all((await this.candidates()).map(async (item): Promise<StorageEntry> => ({ ...item, ...(await folderSize(item.path)) })))
    return { entries: sized, totalBytes: sized.reduce((sum, item) => sum + item.bytes, 0) }
  }

  async remove(id: string): Promise<StorageSnapshot> {
    const target = (await this.candidates()).find((item) => item.id === id)
    if (!target || !target.removable) throw new Error(tm().storage.cannotRemove)
    // Belt and braces: whatever the list says, only something inside the folders the app owns is ever deleted.
    const inside = [this.dirs.dataDir, this.dirs.toolsDir, this.dirs.updatesDir].some((root) => resolve(target.path).toLowerCase().startsWith(resolve(root).toLowerCase() + sep))
    if (!inside) throw new Error(tm().storage.cannotRemove)
    await rm(target.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    if (existsSync(target.path)) throw new Error(tm().storage.locked(target.name))
    return this.list()
  }
}
