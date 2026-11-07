import { AgentOrchestrator } from './orchestrator'
import type { AgentAdapter } from './adapters'
import type { WorktreeService } from './worktrees'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentContextService } from './agent-context'
import { ConversationRepository } from './conversations'
import { AppDatabase } from './database'
import { McpBridge } from './mcp-bridge'
import { latestSchemaVersion, migrations } from './migrations'
import { BoardRepository, ProfileRepository, ProjectRepository } from './projects'
import { SettingsRepository } from './settings'
import { seedProfiles } from './test-helpers'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const git = { validate: async () => undefined, branches: async () => ['dev'], inspect: async (localPath: string) => ({ localPath, name: 'p', repositories: [] }) }

describe('free chat', () => {
  it.each(['allow', 'deny', 'cancel', 'shutdown'] as const)('routes permission to its originating free-chat run and handles %s', async (decision) => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-permission-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
    const projects = new ProjectRepository(database, git), profile = profiles.list()[0]!
    const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev', profileIds: [profile.id] })
    const conversations = new ConversationRepository(database)
    const chat = conversations.createChat({ projectId: project.id, cardId: null, purpose: 'free', profileId: profile.id })
    let allowed: boolean | undefined
    const adapter: AgentAdapter = { async run(options) {
      allowed = await options.requestPermission!('Write', { file: 'a.txt' })
      return { sessionId: 's', turnId: 'u', text: allowed ? 'approved' : 'denied', status: options.signal?.aborted ? 'interrupted' : 'completed', error: null }
    } }
    const events: string[] = []
    const orchestrator = new AgentOrchestrator(conversations, { claude: adapter, codex: adapter, gemini: adapter }, (event) => events.push(event.eventType), {} as WorktreeService)
    const run = orchestrator.start({ chatId: chat.id, prompt: 'x', planning: false })
    const request = orchestrator.permissions.list(chat.id)[0]!
    expect(request).toMatchObject({ runId: run.id, chatId: chat.id, provider: profile.provider, kind: 'Write' })
    if (decision === 'cancel') orchestrator.cancel(run.id)
    else if (decision === 'shutdown') orchestrator.shutdown()
    else expect(orchestrator.permissions.decide(run.id, request.id, decision === 'allow')).toBe(true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(allowed).toBe(decision === 'allow')
    expect(orchestrator.permissions.list(chat.id)).toEqual([])
    expect(orchestrator.permissions.decide(run.id, request.id, true)).toBe(false)
    if (decision !== 'shutdown') expect(events).toContain('gearmod/run-completed')
    database.close()
  })

  it('runs without a card, then becomes the planning chat of the card it creates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-free-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
    const projects = new ProjectRepository(database, git), board = new BoardRepository(database, projects)
    const profile = profiles.list()[0]!
    const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev', profileIds: [profile.id] })
    const conversations = new ConversationRepository(database)
    const bridge = new McpBridge({ board, context: new AgentContextService(board, new SettingsRepository(database), join(__dirname, '..', '..', 'resources', 'gearmod-plugin')), serverScript: 'x', conversations })
    const call = (token: string, tool: string, args: Record<string, unknown>) => (bridge as unknown as { handle(token: string, tool: string, args: Record<string, unknown>): { ok: boolean; text?: string; error?: string } }).handle(token, tool, args)

    expect(() => conversations.createChat({ projectId: project.id, cardId: null, purpose: 'planning', profileId: profile.id })).toThrow('precisa de um card')
    const chat = conversations.createChat({ projectId: project.id, cardId: null, purpose: 'free', profileId: profile.id })
    expect(chat).toMatchObject({ purpose: 'free', cardId: null, busy: false, title: null })
    conversations.setTitleIfEmpty(chat.id, 'Como separar dados e tela'); conversations.setTitleIfEmpty(chat.id, 'outro')
    const run = conversations.createRun({ cardId: null, chatId: chat.id, profileId: profile.id })
    conversations.updateRun(run.id, 'running', null)
    expect(conversations.listChats(project.id)[0]).toMatchObject({ title: 'Como separar dados e tela', busy: true })
    expect(conversations.context(chat.id).cardId).toBeNull()

    const changes: unknown[] = []
    const token = bridge.register(run.id, null, (change) => changes.push(change), { id: chat.id, purpose: 'free' }).env.GEARMOD_TOKEN!
    expect(call(token, 'gearmod_read_skill', { nome: 'gearmod-discovery' })).toMatchObject({ ok: true, text: expect.stringContaining('# Request discovery (GearMod)') })
    expect(call(token, 'gearmod_read_skill', { nome: 'skill-inexistente' })).toMatchObject({ ok: false })
    expect(call(token, 'gearmod_write_document', { tipo: 'plano', markdown: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('gearmod_create_card') })
    expect(call(token, 'gearmod_create_card', { titulo: ' ' })).toMatchObject({ ok: false })

    const created = call(token, 'gearmod_create_card', { titulo: 'Separar dados e tela', tipo: 'improvement', prioridade: 'high', resumo: 'Ideia nascida no chat' })
    expect(created.ok).toBe(true)
    const card = board.get(project.id).cards.find((item) => item.title === 'Separar dados e tela')!
    expect(card).toMatchObject({ type: 'improvement', priority: 'high' })
    expect(board.get(project.id).columns.find((column) => column.id === card.columnId)?.semanticState).toBe('todo')
    expect(conversations.listChats(project.id, card.id)[0]).toMatchObject({ id: chat.id, purpose: 'planning', cardId: card.id })
    expect(database.db.prepare('SELECT card_id AS cardId FROM runs WHERE id = ?').get(run.id)).toEqual({ cardId: card.id })
    expect(changes).toContainEqual({ type: 'converted', cardId: card.id, chatId: chat.id })
    // After the conversion the same run already acts as the card's planning.
    expect(call(token, 'gearmod_write_document', { tipo: 'especificacao', markdown: '## Spec' })).toMatchObject({ ok: true })
    expect(board.documents.read(card.id, 'especificacao')).toBe('## Spec')
    expect(call(token, 'gearmod_create_card', { titulo: 'Outro' })).toMatchObject({ ok: false, error: expect.stringContaining('already has a card') })
    database.close()
  })

  it('keeps run events and test runs when upgrading a v14 database (runs is rebuilt in v15)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-v15-')); roots.push(root)
    const path = join(root, 'db.sqlite')
    const old = new AppDatabase(path, '0.1.0', migrations.filter((item) => item.version <= 14)); await old.open()
    const profile = { id: 'profile-1' }
    old.db.prepare("INSERT INTO agent_profiles(id, provider, label, scope, color, config_dir, enabled, created_at, updated_at) VALUES ('profile-1', 'codex', 'Codex', 'Pessoal', '#fff', ?, 1, ?, ?)").run(root, new Date().toISOString(), new Date().toISOString())
    // Old database built with plain SQL: the current repositories read columns that v14 does not have yet.
    const now = new Date().toISOString(), project = { id: 'project-1' }, card = { id: 'card-1' }
    old.db.prepare("INSERT INTO projects(id, name, local_path, base_branch, created_at, updated_at) VALUES ('project-1', 'P', ?, 'dev', ?, ?)").run(root, now, now)
    old.db.prepare("INSERT INTO board_columns(id, project_id, label, sort_order, semantic_state) VALUES ('col-1', 'project-1', 'Backlog', 0, 'backlog')").run()
    old.db.prepare("INSERT INTO cards(id, project_id, column_id, type, title, priority, order_key, created_at, updated_at) VALUES ('card-1', 'project-1', 'col-1', 'task', 'Antigo', 'medium', 1, ?, ?)").run(now, now)
    old.db.prepare('INSERT INTO chats(id, project_id, card_id, purpose, provider, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('chat-1', project.id, card.id, 'execution', 'codex', profile.id, now, now)
    old.db.prepare("INSERT INTO runs(id, card_id, chat_id, profile_id, status, started_at) VALUES ('run-1', ?, 'chat-1', ?, 'completed', ?)").run(card.id, profile.id, now)
    old.db.prepare("INSERT INTO run_events(id, run_id, seq, event_type, payload_json_sanitized, created_at) VALUES ('ev-1', 'run-1', 0, 'x', '{}', ?)").run(now)
    old.db.prepare("INSERT INTO test_runs(id, card_id, run_id, command, status, summary, started_at) VALUES ('t-1', ?, 'run-1', 'npm test', 'passed', '', ?)").run(card.id, now)
    old.close()

    const upgraded = new AppDatabase(path, '0.1.0'); await upgraded.open()
    expect(upgraded.schemaVersion()).toBe(latestSchemaVersion)
    expect(upgraded.db.prepare('SELECT COUNT(*) AS n FROM run_events').get()).toEqual({ n: 1 })
    expect(upgraded.db.prepare("SELECT run_id AS runId FROM test_runs WHERE id = 't-1'").get()).toEqual({ runId: 'run-1' })
    expect(upgraded.db.prepare("SELECT card_id AS cardId FROM runs WHERE id = 'run-1'").get()).toEqual({ cardId: card.id })
    expect(upgraded.db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(upgraded.db.pragma('foreign_key_check')).toEqual([])
    upgraded.close()
  })
})
