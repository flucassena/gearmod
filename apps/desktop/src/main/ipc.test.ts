import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackupService } from './backup'
import { AppDatabase } from './database'
import { registerIpc, type IpcMainLike } from './ipc'
import { NoteRepository } from './repository'
import { SettingsRepository } from './settings'

class FakeIpc implements IpcMainLike {
  handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
  handle(channel: string, listener: (event: unknown, input: unknown) => unknown): void { this.handlers.set(channel, listener) }
  removeHandler(channel: string): void { this.handlers.delete(channel) }
  async invoke(channel: string, input?: unknown): Promise<unknown> { return this.handlers.get(channel)?.({}, input) }
}

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('validated IPC', () => {
  it('accepts declared input and rejects extra or malformed fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-ipc-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const ipc = new FakeIpc()
    const notes = new NoteRepository(database)
    const unavailable = {} as never
    const projectId = '123e4567-e89b-42d3-a456-426614174000'
    const chooseDirectory = vi.fn(async () => null)
    const projects = { get: vi.fn(() => ({ localPath: root })) } as never
    const artifactDir = join(root, 'card-123e4567'), deleteCard = vi.fn(() => true), trashItem = vi.fn(async (_path: string) => undefined)
    const board = { card: vi.fn(), delete: deleteCard } as never, history = { artifactsDir: () => artifactDir } as never
    registerIpc(ipc, { database, notes, settings: new SettingsRepository(database), backups: new BackupService(root, '0.1.0'), profiles: unavailable, gitManager: unavailable, pullRequests: unavailable, gitAccounts: unavailable, projects, board, git: unavailable, agentProbes: unavailable, conversations: unavailable, orchestrator: unavailable, worktrees: unavailable, quality: unavailable, executions: unavailable, agentConfigs: unavailable, skills: unavailable, constitution: unavailable, checklists: unavailable, voice: unavailable, usage: unavailable, collab: unavailable, history, playwright: unavailable, fileWatch: unavailable, specTools: unavailable, speckit: unavailable, mcp: unavailable, toolUpdates: unavailable, approvals: unavailable, sddResolver: unavailable, sddWriter: unavailable, openPath: async () => undefined, trashItem, terminals: unavailable, openWindow: () => undefined, placeWindow: () => undefined, openExternal: async () => undefined, chooseSkillSource: async () => null, saveTextFile: async () => ({ saved: false, path: null }), chooseDirectory, chooseFiles: async () => [], appVersion: '0.1.0', dataDir: root, updates: {} as never, about: async () => ({}) as never, reopen: async () => { await database.open() } })
    await ipc.invoke('projects:choose-directory', { projectId })
    expect(chooseDirectory).toHaveBeenLastCalledWith(root)
    await ipc.invoke('projects:choose-directory')
    expect(chooseDirectory).toHaveBeenLastCalledWith(undefined)
    const created = await ipc.invoke('notes:create', { body: 'nota válida' }) as { body: string }
    expect(created.body).toBe('nota válida')
    await expect(ipc.invoke('notes:create', { body: '', unexpected: true })).rejects.toThrow()
    await expect(ipc.invoke('notes:delete', { id: '../../db.sqlite' })).rejects.toThrow()
    mkdirSync(artifactDir); writeFileSync(join(artifactDir, 'history.jsonl'), 'histórico')
    await ipc.invoke('cards:delete', { cardId: projectId })
    expect(trashItem).not.toHaveBeenCalled()
    await ipc.invoke('cards:delete', { cardId: projectId, deleteArtifacts: true })
    expect(trashItem).toHaveBeenCalledWith(artifactDir)
    trashItem.mockRejectedValueOnce(new Error('Lixeira indisponível'))
    await expect(ipc.invoke('cards:delete', { cardId: projectId, deleteArtifacts: true })).rejects.toThrow('Lixeira indisponível')
    expect(deleteCard).toHaveBeenCalledTimes(2)
    database.close()
  })

  it('runs the agent login and update in an app terminal and returns its id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-ipc-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const ipc = new FakeIpc(), unavailable = {} as never, profileId = '123e4567-e89b-42d3-a456-426614174000'
    const plan = { file: 'codex.exe', args: ['login'], env: {}, cwd: root, title: 'Codex' }
    const updatePlan = vi.fn(() => plan), agentProbes = { loginPlan: vi.fn(() => plan), updatePlan } as never, run = vi.fn(() => 'term-1'), terminals = { run } as never
    registerIpc(ipc, { database, notes: new NoteRepository(database), settings: new SettingsRepository(database), backups: new BackupService(root, '0.1.0'), profiles: unavailable, gitManager: unavailable, pullRequests: unavailable, gitAccounts: unavailable, projects: unavailable, board: unavailable, git: unavailable, agentProbes, conversations: unavailable, orchestrator: unavailable, worktrees: unavailable, quality: unavailable, executions: unavailable, agentConfigs: unavailable, skills: unavailable, constitution: unavailable, checklists: unavailable, voice: unavailable, usage: unavailable, collab: unavailable, history: unavailable, playwright: unavailable, fileWatch: unavailable, specTools: unavailable, speckit: unavailable, mcp: unavailable, toolUpdates: unavailable, approvals: unavailable, sddResolver: unavailable, sddWriter: unavailable, openPath: async () => undefined, trashItem: async () => undefined, terminals, openWindow: () => undefined, placeWindow: () => undefined, openExternal: async () => undefined, chooseSkillSource: async () => null, saveTextFile: async () => ({ saved: false, path: null }), chooseDirectory: async () => null, chooseFiles: async () => [], appVersion: '0.1.0', dataDir: root, updates: {} as never, about: async () => ({}) as never, reopen: async () => { await database.open() } })
    await expect(ipc.invoke('profiles:login-terminal', { profileId })).resolves.toEqual({ id: 'term-1' })
    expect(run).toHaveBeenCalledWith(plan)
    await expect(ipc.invoke('profiles:login-terminal', { profileId: 'not-a-uuid' })).rejects.toThrow()
    await expect(ipc.invoke('profiles:login-terminal', { profileId, extra: 1 })).rejects.toThrow()
    await expect(ipc.invoke('profiles:update-terminal', { provider: 'codex' })).resolves.toEqual({ id: 'term-1' })
    expect(updatePlan).toHaveBeenCalledWith('codex')
    await expect(ipc.invoke('profiles:update-terminal', { provider: 'outro' })).rejects.toThrow()
    database.close()
  })
})

