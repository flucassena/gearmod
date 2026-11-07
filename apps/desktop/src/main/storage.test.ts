import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StorageService, folderSize } from './storage'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))) })

async function setup(): Promise<{ root: string; data: string; tools: string; updates: string; storage: StorageService }> {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-storage-')); roots.push(root)
  const data = join(root, 'data'), tools = join(data, 'tools'), updates = join(root, 'tmp', 'gearmod-update')
  const file = async (path: string, size: number): Promise<void> => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, Buffer.alloc(size, 1)) }
  await file(join(tools, 'playwright-cli', '0.1.22', 'a.bin'), 1000); await file(join(tools, 'playwright-cli', '0.1.23', 'sub', 'b.bin'), 2500)
  await file(join(tools, 'playwright-browsers', 'chromium-1', 'c.bin'), 4000)
  await file(join(data, 'whisper', 'models', 'small.bin'), 3000); await file(join(data, 'whisper', 'bin', 'whisper.exe'), 500)
  await file(join(data, 'backups', 'b1', 'manifest.json'), 200)
  await file(join(updates, 'GearMod-Setup-0.2.0-x64.exe'), 700)
  await file(join(data, 'wt', 'abc', 'x.txt'), 90); await file(join(data, 'gearmod.sqlite'), 60)
  return { root, data, tools, updates, storage: new StorageService({ dataDir: data, toolsDir: tools, updatesDir: updates }) }
}

describe('folderSize', () => {
  it('adds the size of the files in a folder and its subfolders', async () => {
    const { tools } = await setup()
    expect(await folderSize(join(tools, 'playwright-cli', '0.1.23'))).toEqual({ bytes: 2500, partial: false })
    expect(await folderSize(join(tools, 'nowhere'))).toEqual({ bytes: 0, partial: false })
  })
})

describe('StorageService', () => {
  it('lists what the app keeps, with sizes, and says what can be removed', async () => {
    const { storage } = await setup()
    const list = await storage.list()
    const byId = new Map(list.entries.map((item) => [item.id, item]))
    expect(byId.get('playwright-version:0.1.22')).toMatchObject({ kind: 'playwright-version', bytes: 1000, removable: true })
    expect(byId.get('playwright-version:0.1.23')).toMatchObject({ bytes: 2500, removable: true })
    expect(byId.get('playwright-browsers:playwright-browsers')).toMatchObject({ bytes: 4000, removable: true })
    expect(byId.get('voice-model:small.bin')).toMatchObject({ bytes: 3000, removable: true })
    expect(byId.get('backup:b1')).toMatchObject({ bytes: 200, removable: true })
    expect(byId.get('update-download:GearMod-Setup-0.2.0-x64.exe')).toMatchObject({ bytes: 700, removable: true })
    expect(byId.get('voice-engine:bin')).toMatchObject({ removable: false })
    expect(byId.get('worktrees:wt')).toMatchObject({ bytes: 90, removable: false })
    expect(byId.get('database:gearmod.sqlite')).toMatchObject({ bytes: 60, removable: false })
    expect(list.totalBytes).toBe(1000 + 2500 + 4000 + 3000 + 500 + 200 + 700 + 90 + 60)
  })

  it('removes an old version and gives back the updated list', async () => {
    const { storage, tools } = await setup()
    const after = await storage.remove('playwright-version:0.1.22')
    expect(existsSync(join(tools, 'playwright-cli', '0.1.22'))).toBe(false)
    expect(existsSync(join(tools, 'playwright-cli', '0.1.23'))).toBe(true)
    expect(after.entries.some((item) => item.id === 'playwright-version:0.1.22')).toBe(false)
  })

  it('refuses ids that are not in the list, paths, and items that are only informative', async () => {
    const { storage, data, root } = await setup()
    await expect(storage.remove('backup:nope')).rejects.toThrow()
    await expect(storage.remove('backup:../../..')).rejects.toThrow()
    await expect(storage.remove(join(root, 'data'))).rejects.toThrow()
    await expect(storage.remove('worktrees:wt')).rejects.toThrow()
    await expect(storage.remove('database:gearmod.sqlite')).rejects.toThrow()
    expect(existsSync(join(data, 'wt', 'abc', 'x.txt'))).toBe(true)
  })
})
