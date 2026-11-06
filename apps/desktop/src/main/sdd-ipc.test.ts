import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { CardHistoryService } from './history'
import { registerIpc, type IpcMainLike } from './ipc'
import { BoardRepository, GitService, ProfileRepository, ProjectRepository } from './projects'
import { seedProfiles } from './test-helpers'
import { WorktreeService } from './worktrees'
import { SddResolver } from './sdd/sdd-resolver'
import { SddWriter } from './sdd/sdd-writer'
import { ConstitutionRepository } from './constitution'
import { ApprovalService } from './approvals'

class FakeIpc implements IpcMainLike {
  handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
  handle(channel: string, listener: (event: unknown, input: unknown) => unknown): void { this.handlers.set(channel, listener) }
  removeHandler(channel: string): void { this.handlers.delete(channel) }
  async invoke(channel: string, input?: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`Canal desconhecido: ${channel}`)
    return handler({}, input)
  }
}

const exec = promisify(execFile), roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))) })
const git = (dir: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> => exec('git', ['-C', dir, ...args])
const unavailable = {} as never

describe('file-first SDD IPC (G10)', () => {
  it('sdd:config-get/set, sdd:locate and constitution:read/write end to end, with contract validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-sddipc-')); roots.push(root)
    const repo = join(root, 'repo'), data = join(root, 'data')
    await exec('git', ['init', '-b', 'main', repo])
    await git(repo, 'config', 'user.email', 'test@example.invalid'); await git(repo, 'config', 'user.name', 'GearMod Test')
    await mkdir(join(repo, '.gearmod'), { recursive: true }); await writeFile(join(repo, '.gearmod', 'constitution.md'), 'versão inicial')
    await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'inicial')
    const database = new AppDatabase(join(data, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
    const projects = new ProjectRepository(database, new GitService()), project = await projects.create({ localPath: repo })
    const board = new BoardRepository(database, projects), column = board.get(project.id).columns[0]!
    const card = board.create({ projectId: project.id, columnId: column.id, title: 'Card', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    const history = new CardHistoryService(database, data)
    const worktrees = new WorktreeService(database, data)
    const sddResolver = new SddResolver(history, board, projects, worktrees)
    const sddWriter = new SddWriter(worktrees)
    const ipc = new FakeIpc()
    registerIpc(ipc, {
      database, backups: unavailable, notes: unavailable, settings: unavailable, profiles, projects, board, git: unavailable,
      chooseDirectory: async () => null, chooseFiles: async () => [], agentProbes: unavailable, conversations: unavailable,
      orchestrator: unavailable, worktrees, quality: unavailable, executions: unavailable, agentConfigs: unavailable, skills: unavailable,
      constitution: new ConstitutionRepository(database), checklists: unavailable, voice: unavailable, usage: unavailable, collab: unavailable,
      gitManager: unavailable, pullRequests: unavailable, gitAccounts: unavailable, history, playwright: unavailable, fileWatch: unavailable, specTools: unavailable, speckit: unavailable, mcp: unavailable, toolUpdates: unavailable,
      approvals: new ApprovalService(database), sddResolver, sddWriter, openPath: async () => undefined, terminals: unavailable,
      openWindow: () => undefined, placeWindow: () => undefined, openExternal: async () => undefined, chooseSkillSource: async () => null,
      saveTextFile: async () => ({ saved: false, path: null }), appVersion: '0.1.0', dataDir: data, updates: {} as never, about: async () => ({}) as never, reopen: async () => { await database.open() }
    })

    const config = await ipc.invoke('sdd:config-get', { projectId: project.id })
    expect(config).toMatchObject({ method: 'native', sourceId: null })

    const location = await ipc.invoke('sdd:locate', { projectId: project.id, cardId: null })
    expect(location).toMatchObject({ via: 'ref', ref: 'main' })

    const read = await ipc.invoke('constitution:read', { projectId: project.id, cardId: null })
    expect(read).toMatchObject({ content: 'versão inicial', via: 'ref' })

    const preview = await ipc.invoke('sdd:detect-constitutions', { projectId: project.id })
    expect(preview).toMatchObject({ kind: 'existing', candidates: { db: null, native: { content: 'versão inicial', sha256: expect.any(String) }, speckit: null } })

    // Without a card, the write is refused (the contract requires cardId; .strict() does not even let it through without it).
    await expect(ipc.invoke('constitution:write', { projectId: project.id, content: 'x', expectBlobSha: null })).rejects.toThrow()

    await worktrees.prepare(card.id)
    const written = await ipc.invoke('constitution:write', { projectId: project.id, cardId: card.id, content: 'versão nova, pelo card', expectBlobSha: (read as { blobSha: string }).blobSha })
    expect(written).toMatchObject({ content: 'versão nova, pelo card', via: 'worktree' })

    const details = await ipc.invoke('constitution:card-details', { projectId: project.id, cardId: card.id })
    expect(details).toMatchObject({ baseRef: 'main', baseContent: 'versão inicial', view: { content: 'versão nova, pelo card' } })
    const approvals = new ApprovalService(database)
    const current = written as { blobSha: string; path: string; content: string }
    const sourceId = (location as { sourceId: string }).sourceId
    const proposal = approvals.request({ kind: 'constitution-apply', subjectRef: current.path, requestedActor: 'agent', projectId: project.id, cardId: card.id, payload: { sourceId, path: current.path, before: current.content, content: 'proposta aprovada', expectBlobSha: current.blobSha } })
    expect((await ipc.invoke('constitution:read', { projectId: project.id, cardId: card.id }) as { content: string }).content).toBe(current.content)
    const decided = await ipc.invoke('approvals:decide', { id: proposal.id, approve: true })
    expect(decided).toMatchObject({ status: 'approved', consumedAt: expect.any(String) })
    expect((await ipc.invoke('constitution:read', { projectId: project.id, cardId: card.id }) as { content: string }).content).toBe('proposta aprovada')
    await expect(ipc.invoke('approvals:apply-constitution', { id: proposal.id })).rejects.toThrow()
    const stale = approvals.request({ kind: 'constitution-apply', subjectRef: current.path, requestedActor: 'agent', projectId: project.id, cardId: card.id, payload: { sourceId, path: current.path, before: current.content, content: 'não sobrescrever', expectBlobSha: current.blobSha } })
    await expect(ipc.invoke('approvals:decide', { id: stale.id, approve: true })).rejects.toThrow()
    expect((await ipc.invoke('constitution:read', { projectId: project.id, cardId: card.id }) as { content: string }).content).toBe('proposta aprovada')

    // The main copy did not change: the write went only to the card's worktree.
    expect((await git(repo, 'show', 'HEAD:.gearmod/constitution.md')).stdout).toBe('versão inicial')

    database.close()
  })
})
