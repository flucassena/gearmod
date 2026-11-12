import { watch, existsSync, type FSWatcher } from 'node:fs'
import { resolve, sep } from 'node:path'

type Emit = (eventType: string, payload: Record<string, unknown>) => void
interface Watched { watcher: FSWatcher | null; timer: NodeJS.Timeout | null }

/**
 * Watches files open on the screens to report when the agent (or another program) changes them on disk. One `fs.watch` per file,
 * not per folder; each screen has its own `watchId` and the new list replaces the previous one. Files written by swapping (`rename`) are followed:
 * the watcher is rebuilt if the file is still there, or it reports `deleted` if it is gone.
 */
export class FileWatchService {
  private readonly groups = new Map<string, Map<string, Watched>>()
  constructor(private readonly emit: Emit, private readonly delay = 200) {}

  watch(watchId: string, paths: string[]): void {
    const wanted = new Set(paths), group = this.groups.get(watchId) ?? new Map<string, Watched>()
    for (const [path, item] of group) if (!wanted.has(path)) { this.stop(item); group.delete(path) }
    for (const path of wanted) if (!group.has(path)) { const item: Watched = { watcher: null, timer: null }; group.set(path, item); this.start(path, item) }
    if (group.size) this.groups.set(watchId, group); else this.groups.delete(watchId)
  }

  /**
   * Lets go of every watched file inside a folder that is about to be moved or deleted: on Windows an open watcher inside a folder keeps it from being
   * renamed or removed. A screen that still shows one of those files starts watching it again the next time it sends its list. Returns how many were released.
   */
  release(folder: string): number {
    const key = (value: string): string => { const full = resolve(value); return process.platform === 'win32' ? full.toLowerCase() : full }
    const base = key(folder)
    let released = 0
    for (const [id, group] of this.groups) {
      for (const [path, item] of group) { const at = key(path); if (at === base || at.startsWith(base + sep)) { this.stop(item); group.delete(path); released++ } }
      if (!group.size) this.groups.delete(id)
    }
    return released
  }

  dispose(): void { for (const group of this.groups.values()) for (const item of group.values()) this.stop(item); this.groups.clear() }

  private start(path: string, item: Watched): void {
    try { item.watcher = watch(path, { persistent: false }, (type) => this.changed(path, item, type)); item.watcher.on('error', () => this.changed(path, item, 'rename')) } catch { item.watcher = null }
  }

  private stop(item: Watched): void { if (item.timer) clearTimeout(item.timer); item.timer = null; item.watcher?.close(); item.watcher = null }

  private changed(path: string, item: Watched, type: string): void {
    if (item.timer) clearTimeout(item.timer)
    item.timer = setTimeout(() => {
      item.timer = null
      if (type === 'rename') { item.watcher?.close(); item.watcher = null; if (existsSync(path)) this.start(path, item) }
      const deleted = !existsSync(path)
      this.emit('gearmod/file-changed', deleted ? { path, deleted: true } : { path })
    }, this.delay)
  }
}
