import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAdapter, AgentRunOptions } from './adapters'
import { ConversationRepository } from './conversations'
import { AppDatabase } from './database'
import { AgentOrchestrator } from './orchestrator'
import { BoardRepository, ProfileRepository, ProjectRepository } from './projects'
import { seedProfiles } from './test-helpers'
import type { WorktreeService } from './worktrees'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const git = { validate: async () => undefined, branches: async () => ['dev'], inspect: async (localPath: string) => ({ localPath, name: 'p', repositories: [] }) }

describe('chat attachments', () => {
  it('puts the paths in the request, discards the ones that do not exist and passes the list to the agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-attach-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
    const profile = profiles.list()[0]!
    const project = await new ProjectRepository(database, git).create({ name: 'P', localPath: root, baseBranch: 'dev', profileIds: [profile.id] })
    const conversations = new ConversationRepository(database)
    const chat = conversations.createChat({ projectId: project.id, cardId: null, purpose: 'free', profileId: profile.id })
    const file = join(root, 'requisitos.md'); await writeFile(file, '# Requisitos')
    const calls: AgentRunOptions[] = []
    const fake: AgentAdapter = { run: async (options) => { calls.push(options); return { sessionId: 's', turnId: null, text: 'li', status: 'completed', error: null } } } as AgentAdapter
    const orchestrator = new AgentOrchestrator(conversations, { codex: fake, claude: fake, gemini: fake }, () => undefined, {} as WorktreeService, 1)

    expect(() => orchestrator.start({ chatId: chat.id, prompt: 'oi', planning: true, attachments: [join(root, 'nao-existe.txt')] })).toThrow('Nenhum dos arquivos')
    orchestrator.start({ chatId: chat.id, prompt: 'Resuma', planning: true, attachments: [file, join(root, 'nao-existe.txt'), file] })
    for (let i = 0; i < 50 && !calls.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))

    expect(calls[0]!.attachments).toEqual([file])
    expect(calls[0]!.prompt).toContain(`- ${file}`)
    expect(conversations.listMessages(chat.id).find((message) => message.role === 'user')!.body).toContain('Arquivos anexados')
    // Wait for the orchestrator to write the end of the run before closing the database.
    for (let i = 0; i < 50 && !conversations.listMessages(chat.id).some((message) => message.role === 'assistant'); i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    await new Promise((resolve) => setTimeout(resolve, 20))
    database.close()
  })

  it('registers the files of a card chat message in the card attachments, but not those of a free chat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-attach-card-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
    const profile = profiles.list()[0]!
    const projects = new ProjectRepository(database, git)
    const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev', profileIds: [profile.id] })
    const board = new BoardRepository(database, projects)
    const card = board.create({ projectId: project.id, columnId: board.get(project.id).columns[0]!.id, title: 'C', description: '', type: 'task', priority: 'low', acceptanceCriteria: [] })
    const conversations = new ConversationRepository(database)
    const cardChat = conversations.createChat({ projectId: project.id, cardId: card.id, purpose: 'planning', profileId: profile.id })
    const freeChat = conversations.createChat({ projectId: project.id, cardId: null, purpose: 'free', profileId: profile.id })
    const file = join(root, 'a.md'); await writeFile(file, '# A')
    const calls: unknown[][] = []
    const fake = { run: async () => ({ sessionId: 's', turnId: null, text: 'ok', status: 'completed', error: null }) } as unknown as AgentAdapter
    const repo = { addFromPath: async (...args: unknown[]) => { calls.push(args); throw new Error('copia lenta e falha') } }
    const orchestrator = new AgentOrchestrator(conversations, { codex: fake, claude: fake, gemini: fake }, () => undefined, {} as WorktreeService, 2, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, repo)
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const run = orchestrator.start({ chatId: cardChat.id, prompt: 'oi', planning: true, attachments: [file] })
    orchestrator.start({ chatId: freeChat.id, prompt: 'oi', planning: true, attachments: [file] })
    expect(run.id).toBeTruthy()
    for (let i = 0; i < 50 && !calls.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toEqual([[card.id, file, 'chat', expect.any(String)]])
    for (let i = 0; i < 100 && conversations.listMessages(cardChat.id).filter((message) => message.role === 'assistant').length < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    await new Promise((resolve) => setTimeout(resolve, 50))
    quiet.mockRestore(); database.close()
  })
})
