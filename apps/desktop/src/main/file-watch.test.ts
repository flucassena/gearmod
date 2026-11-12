import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileWatchService } from './file-watch'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

/** Waits for up to `count` events (or 2 s) and returns what arrived. */
const collect = (events: Array<Record<string, unknown>>, count: number): Promise<void> => new Promise((resolve) => { const started = Date.now(); const timer = setInterval(() => { if (events.length >= count || Date.now() - started > 2000) { clearInterval(timer); resolve() } }, 20) })

describe('FileWatchService', () => {
  it('notifies when the file changes, is replaced by a rename and is deleted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gearmod-watch-')); dirs.push(dir)
    const file = join(dir, 'a.txt'); await writeFile(file, 'um')
    const events: Array<Record<string, unknown>> = [], service = new FileWatchService((_type, payload) => events.push(payload), 40)
    service.watch('janela', [file])
    await writeFile(file, 'dois'); await collect(events, 1)
    expect(events[0]).toEqual({ path: file })
    // The agent often writes to a temp file and swaps it in: the watcher has to follow the new file.
    await writeFile(join(dir, 'novo.tmp'), 'tres'); await rename(join(dir, 'novo.tmp'), file); await collect(events, 2)
    expect(events.length).toBeGreaterThanOrEqual(2)
    const before = events.length
    await writeFile(file, 'quatro'); await collect(events, before + 1)
    expect(events.length).toBeGreaterThan(before)
    await unlink(file); await collect(events, events.length + 1)
    expect(events.at(-1)).toEqual({ path: file, deleted: true })
    service.dispose()
  })
  it('an empty list stops watching', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gearmod-watch-')); dirs.push(dir)
    const file = join(dir, 'b.txt'); await writeFile(file, 'x')
    const events: Array<Record<string, unknown>> = [], service = new FileWatchService((_type, payload) => events.push(payload), 30)
    service.watch('janela', [file]); service.watch('janela', [])
    await writeFile(file, 'y'); await new Promise((resolve) => setTimeout(resolve, 200))
    expect(events).toEqual([])
    service.dispose()
  })
  it('release lets go of the watched files inside a folder so the folder can be moved (Windows keeps a folder with an open watcher in place)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gearmod-watch-')); dirs.push(dir)
    const inside = join(dir, 'worktree', 'src'), other = join(dir, 'other')
    await mkdir(inside, { recursive: true }); await mkdir(other)
    const a = join(inside, 'a.txt'), b = join(other, 'b.txt'); await writeFile(a, 'um'); await writeFile(b, 'um')
    const events: Array<Record<string, unknown>> = [], service = new FileWatchService((_type, payload) => events.push(payload), 40)
    service.watch('janela', [a, b])
    expect(service.release(join(dir, 'worktree'))).toBe(1)
    // Released: the folder moves, a change inside it is no longer reported, and the file outside is still watched.
    await rename(join(dir, 'worktree'), join(dir, 'trash'))
    await writeFile(b, 'dois'); await collect(events, 1)
    expect(events).toEqual([{ path: b }])
    expect(service.release(join(dir, 'worktree'))).toBe(0)
    service.dispose()
  })
})
