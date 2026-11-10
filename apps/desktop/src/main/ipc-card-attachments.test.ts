import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackupService } from './backup'
import { AppDatabase } from './database'
import { registerIpc, type IpcMainLike } from './ipc'
import { BoardRepository, ProfileRepository, ProjectRepository } from './projects'
import { NoteRepository } from './repository'
import { SettingsRepository } from './settings'
import { seedProfiles } from './test-helpers'

class FakeIpc implements IpcMainLike {
  handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
  handle(channel: string, listener: (event: unknown, input: unknown) => unknown): void { this.handlers.set(channel, listener) }
  removeHandler(channel: string): void { this.handlers.delete(channel) }
  async invoke(channel: string, input?: unknown): Promise<unknown> { return this.handlers.get(channel)?.({}, input) }
}

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const git = { validate: async () => undefined, branches: async () => ['dev'], inspect: async (localPath: string) => ({ localPath, name: 'p', repositories: [] }) }

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-ipc-att-')); roots.push(root)
  const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
  const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
  const projects = new ProjectRepository(database, git)
  const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev', profileIds: [profiles.list()[0]!.id] })
  const board = new BoardRepository(database, projects)
  const columns = board.get(project.id).columns
  const card = (state: string) => board.create({ projectId: project.id, columnId: columns.find((column) => column.semanticState === state)!.id, title: 'C', description: '', type: 'task', priority: 'low', acceptanceCriteria: [] })
  const trashItem = vi.fn(async (_path: string) => undefined)
  const ipc = new FakeIpc(), unavailable = {} as never
  const history = { artifactsDir: () => join(root, 'artifacts') } as never
  registerIpc(ipc, { database, notes: new NoteRepository(database), settings: new SettingsRepository(database), backups: new BackupService(root, '0.1.0'), profiles: unavailable, gitManager: unavailable, pullRequests: unavailable, gitAccounts: unavailable, projects, board, git: unavailable, agentProbes: unavailable, conversations: unavailable, orchestrator: unavailable, worktrees: unavailable, quality: unavailable, executions: unavailable, agentConfigs: unavailable, skills: unavailable, constitution: unavailable, checklists: unavailable, voice: unavailable, usage: unavailable, collab: unavailable, history, playwright: unavailable, fileWatch: unavailable, specTools: unavailable, speckit: unavailable, mcp: unavailable, toolUpdates: unavailable, approvals: unavailable, sddResolver: unavailable, sddWriter: unavailable, openPath: async () => undefined, trashItem, terminals: unavailable, openWindow: () => undefined, placeWindow: () => undefined, openExternal: async () => undefined, chooseSkillSource: async () => null, saveTextFile: async () => ({ saved: false, path: null }), chooseDirectory: async () => null, chooseFiles: async () => [], appVersion: '0.1.0', dataDir: root, updates: {} as never, storage: {} as never, about: async () => ({}) as never, reopen: async () => { await database.open() } })
  return { root, database, ipc, card, trashItem }
}

describe('card attachment channels', () => {
  it('rejects invalid input', async () => {
    const { database, ipc, card } = await setup()
    const c = card('todo')
    await expect(ipc.invoke('cards:attachments-add', { cardId: c.id, paths: Array.from({ length: 21 }, (_, i) => `/x/${i}`) })).rejects.toThrow()
    await expect(ipc.invoke('cards:attachments-add', { cardId: c.id, paths: [], extra: 1 })).rejects.toThrow()
    await expect(ipc.invoke('cards:attachments-remove', { cardId: c.id, ids: [] })).rejects.toThrow()
    await expect(ipc.invoke('cards:attachments-remove', { cardId: c.id, ids: Array.from({ length: 501 }, () => '123e4567-e89b-42d3-a456-426614174000') })).rejects.toThrow()
    await expect(ipc.invoke('cards:attachments-add-pasted', { cardId: c.id, name: 'a', base64: 'a'.repeat(40_000_001) })).rejects.toThrow()
    database.close()
  })

  it('adds, lists, removes through the trash and refuses attachments of another card', async () => {
    const { root, database, ipc, card, trashItem } = await setup()
    const c = card('todo'), other = card('todo')
    const ok = join(root, 'ok.txt'); await writeFile(ok, 'ok'); await mkdir(join(root, 'dir'))
    const result = await ipc.invoke('cards:attachments-add', { cardId: c.id, paths: [ok, join(root, 'dir'), join(root, 'nada.txt')] }) as { added: { id: string; path: string }[]; failed: { name: string }[] }
    expect(result.added).toHaveLength(1); expect(result.failed.map((item) => item.name)).toEqual(['dir', 'nada.txt'])
    const pasted = await ipc.invoke('cards:attachments-add-pasted', { cardId: other.id, name: 'p.png', base64: Buffer.from('x').toString('base64') }) as { id: string }
    expect(await ipc.invoke('cards:attachments', { cardId: c.id })).toHaveLength(1)
    const refused = await ipc.invoke('cards:attachments-remove', { cardId: c.id, ids: [pasted.id] }) as { removed: string[]; failed: { id: string }[] }
    expect(refused.removed).toEqual([]); expect(refused.failed[0]!.id).toBe(pasted.id); expect(trashItem).not.toHaveBeenCalled()
    const removed = await ipc.invoke('cards:attachments-remove', { cardId: c.id, ids: [result.added[0]!.id] }) as { removed: string[] }
    expect(removed.removed).toHaveLength(1); expect(trashItem).toHaveBeenCalledWith(result.added[0]!.path)
    expect(existsSync(ok)).toBe(true)
    database.close()
  })

  it('cards:delete sends the card attachments folder to the trash and Done cleanup ignores other cards', async () => {
    const { root, database, ipc, card, trashItem } = await setup()
    const done = card('done'), doing = card('doing')
    const file = join(root, 'f.txt'); await writeFile(file, 'f'); await writeFile(join(root, 'g.txt'), 'gg')
    await ipc.invoke('cards:attachments-add', { cardId: done.id, paths: [file] })
    await ipc.invoke('cards:attachments-add', { cardId: doing.id, paths: [join(root, 'g.txt')] })
    expect(await ipc.invoke('storage:card-attachments-done')).toEqual({ cards: 1, files: 1, bytes: 1 })
    expect(await ipc.invoke('storage:clear-card-attachments-done')).toEqual({ cards: 1, files: 1, bytes: 1, failed: 0 })
    expect(trashItem).toHaveBeenCalledTimes(1)
    expect(await ipc.invoke('cards:attachments', { cardId: doing.id })).toHaveLength(1)
    trashItem.mockClear()
    await ipc.invoke('cards:delete', { cardId: doing.id })
    expect(trashItem).toHaveBeenCalledWith(join(root, 'attachments', 'cards', doing.id))
    database.close()
  })
})
