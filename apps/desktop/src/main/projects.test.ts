import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationRepository } from './conversations'
import { AppDatabase } from './database'
import { migrations } from './migrations'
import { BoardRepository, ProfileRepository, ProjectRepository } from './projects'
import { seedProfiles } from './test-helpers'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-projects-')); roots.push(root)
  const database = new AppDatabase(join(root, 'data.sqlite'), '0.1.0'); await database.open()
  const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
  const git = {
    validate: async () => undefined,
    branches: async () => ['dev', 'main'],
    inspect: async (localPath: string) => ({ localPath, name: localPath.split(/[\\/]/).at(-1) || 'project', repositories: [{ localPath, name: 'repo', currentBranch: 'dev', branches: ['dev', 'main'] }] })
  }
  const projects = new ProjectRepository(database, git)
  const board = new BoardRepository(database, projects)
  return { root, database, profiles, projects, board }
}

describe('project board', () => {
  it('creates a project with five stable semantic columns and available profiles', async () => {
    const { root, database, profiles, projects, board } = await setup()
    const project = await projects.create({ name: 'Produto', localPath: root, baseBranch: 'dev', profileIds: profiles.list().map((item) => item.id) })
    const state = board.get(project.id)
    expect(state.columns.map((column) => column.semanticState)).toEqual(['todo', 'doing', 'test', 'done'])
    expect(project.allowedProfileIds).toHaveLength(2)
    expect(profiles.list()).toHaveLength(2)
    database.close()
  })

  it('persists card fields, criteria, ordering, transitions and archive state', async () => {
    const { root, database, projects, board } = await setup()
    const project = await projects.create({ name: 'Produto', localPath: root, baseBranch: 'dev' })
    const state = board.get(project.id), todo = state.columns[1]!, doing = state.columns[2]!
    const card = board.create({ projectId: project.id, columnId: todo.id, title: 'Fluxo real', description: 'Persistir tudo', type: 'feature', priority: 'high', acceptanceCriteria: [{ body: 'Reabre igual', checked: false }] })
    expect(card.acceptanceCriteria[0]?.body).toBe('Reabre igual')
    expect(board.move(card.id, doing.id, null).columnId).toBe(doing.id)
    expect(database.db.prepare('SELECT COUNT(*) AS value FROM column_history WHERE card_id = ?').get(card.id)).toEqual({ value: 1 })
    expect(board.archive(card.id).archivedAt).not.toBeNull()
    database.close()

    const reopened = new AppDatabase(join(root, 'data.sqlite'), '0.1.0'); await reopened.open()
    const git = {
      validate: async () => undefined,
      branches: async () => ['dev'],
      inspect: async (localPath: string) => ({ localPath, name: 'project', repositories: [{ localPath, name: 'repo', currentBranch: 'dev', branches: ['dev'] }] })
    }
    const reopenedProjects = new ProjectRepository(reopened, git)
    const restored = new BoardRepository(reopened, reopenedProjects).card(card.id)
    expect(restored.title).toBe('Fluxo real'); expect(restored.columnId).toBe(doing.id); expect(restored.archivedAt).not.toBeNull()
    reopened.close()
  })

  it('enforces project profile allowlists and column ownership', async () => {
    const { root, database, profiles, projects, board } = await setup()
    const first = await projects.create({ name: 'A', localPath: `${root}-a`, baseBranch: 'dev' })
    const second = await projects.create({ name: 'B', localPath: `${root}-b`, baseBranch: 'dev' })
    const oneProfile = profiles.list()[0]!
    expect(projects.setProfiles(first.id, [oneProfile.id]).allowedProfileIds).toEqual([oneProfile.id])
    expect(() => projects.setProfiles(first.id, ['20000000-0000-4000-8000-000000000099'])).toThrow('Perfil desconhecido')
    expect(() => board.create({ projectId: first.id, columnId: board.get(second.id).columns[0]!.id, title: 'Inválido', description: '', type: 'task', priority: 'low', acceptanceCriteria: [] })).toThrow('não pertence')
    database.close()
  })

  it('uses the repository folder name and current branch when they are omitted', async () => {
    const { root, database, projects } = await setup()
    const project = await projects.create({ localPath: root })
    expect(project.name).toBe(root.split(/[\\/]/).at(-1))
    expect(project.baseBranch).toBe('dev')
    database.close()
  })

  it('orders cards by priority, adopts the priority of the card it is dropped before and deletes cards', async () => {
    const { root, database, projects, board } = await setup()
    const project = await projects.create({ name: 'Ordem', localPath: root, baseBranch: 'dev' })
    const column = board.get(project.id).columns[1]!
    const make = (title: string, priority: string) => board.create({ projectId: project.id, columnId: column.id, title, description: '', type: 'task', priority, acceptanceCriteria: [] })
    const low = make('baixa', 'low'), urgent = make('urgente', 'urgent'), mediumA = make('media A', 'medium'), mediumB = make('media B', 'medium')
    const titles = () => board.get(project.id).cards.map((card) => card.title)
    expect(titles()).toEqual(['urgente', 'media A', 'media B', 'baixa'])
    expect(board.move(mediumB.id, column.id, mediumA.id).priority).toBe('medium')
    expect(titles()).toEqual(['urgente', 'media B', 'media A', 'baixa'])
    const adopted = board.move(low.id, column.id, urgent.id)
    expect(adopted.priority).toBe('urgent')
    expect(titles()).toEqual(['baixa', 'urgente', 'media B', 'media A'])
    expect(board.delete(urgent.id)).toBe(true)
    expect(titles()).not.toContain('urgente')
    database.close()
  })

  it('merges the Backlog column into To do: cards go to the end, history follows and the column goes away', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-backlog-')); roots.push(root)
    const path = join(root, 'data.sqlite')
    const old = new AppDatabase(path, '0.1.0', migrations.slice(0, 44)); await old.open()
    const now = '2026-01-01T00:00:00.000Z', project = '41000000-0000-4000-8000-000000000001'
    old.db.prepare(`INSERT INTO projects(id, name, local_path, base_branch, created_at, updated_at) VALUES (?, 'P', ?, 'dev', ?, ?)`).run(project, root, now, now)
    const ids: Record<string, string> = {}
    ;[['Backlog', 'backlog'], ['To do', 'todo'], ['Doing', 'doing'], ['Test', 'test'], ['Done', 'done']].forEach(([label, state], index) => {
      ids[state!] = `41000000-0000-4000-8000-00000000010${index}`
      old.db.prepare('INSERT INTO board_columns(id, project_id, label, sort_order, semantic_state, is_default) VALUES (?, ?, ?, ?, ?, ?)').run(ids[state!], project, label, index, state, state === 'backlog' ? 1 : 0)
    })
    const card = (id: string, column: string, order: number): void => { old.db.prepare(`INSERT INTO cards(id, project_id, column_id, type, title, description, priority, order_key, created_at, updated_at) VALUES (?, ?, ?, 'task', ?, '', 'medium', ?, ?, ?)`).run(id, project, column, id, order, now, now) }
    card('41000000-0000-4000-8000-000000000201', ids.todo!, 1024); card('41000000-0000-4000-8000-000000000202', ids.backlog!, 1024); card('41000000-0000-4000-8000-000000000203', ids.backlog!, 2048)
    old.db.prepare(`INSERT INTO column_history(id, card_id, from_column_id, to_column_id, changed_at, actor, reason) VALUES ('41000000-0000-4000-8000-000000000300', '41000000-0000-4000-8000-000000000202', ?, ?, ?, 'user', 'kanban-move')`).run(ids.backlog, ids.doing, now)
    old.close()

    const upgraded = new AppDatabase(path, '0.1.0'); await upgraded.open()
    const columns = upgraded.db.prepare('SELECT label, semantic_state AS state, sort_order AS sortOrder, is_default AS isDefault FROM board_columns WHERE project_id = ? ORDER BY sort_order').all(project)
    expect(columns).toEqual([{ label: 'To do', state: 'todo', sortOrder: 0, isDefault: 1 }, { label: 'Doing', state: 'doing', sortOrder: 1, isDefault: 0 }, { label: 'Test', state: 'test', sortOrder: 2, isDefault: 0 }, { label: 'Done', state: 'done', sortOrder: 3, isDefault: 0 }])
    const cards = upgraded.db.prepare('SELECT id, column_id AS columnId FROM cards WHERE project_id = ? ORDER BY order_key').all(project) as Array<{ id: string; columnId: string }>
    expect(cards.map((item) => item.id.slice(-3))).toEqual(['201', '202', '203'])  // the Backlog cards come after the ones that were already in To do
    expect(cards.every((item) => item.columnId === ids.todo)).toBe(true)
    expect(upgraded.db.prepare('SELECT from_column_id AS fromId FROM column_history').get()).toEqual({ fromId: ids.todo })
    upgraded.close()
  })

  it('migrates MR columns to Test keeping history, and merges Backlog into To do', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-mr-')); roots.push(root)
    const path = join(root, 'data.sqlite')
    const old = new AppDatabase(path, '0.1.0', migrations.slice(0, 5)); await old.open()
    const now = '2026-01-01T00:00:00.000Z', project = '40000000-0000-4000-8000-000000000001'
    old.db.prepare(`INSERT INTO projects(id, name, local_path, base_branch, created_at, updated_at) VALUES (?, 'P', ?, 'dev', ?, ?)`).run(project, root, now, now)
    const ids: Record<string, string> = {}
    ;[['To Do', 'todo'], ['Doing', 'doing'], ['Test', 'test'], ['MR', 'mr'], ['Done', 'done']].forEach(([label, state], index) => {
      ids[state!] = `40000000-0000-4000-8000-00000000010${index}`
      old.db.prepare('INSERT INTO board_columns(id, project_id, label, sort_order, semantic_state, is_default) VALUES (?, ?, ?, ?, ?, 1)').run(ids[state!], project, label, index, state)
    })
    const card = '40000000-0000-4000-8000-000000000200'
    old.db.prepare(`INSERT INTO cards(id, project_id, column_id, type, title, description, priority, order_key, created_at, updated_at) VALUES (?, ?, ?, 'task', 'Em revisão', '', 'medium', 1, ?, ?)`).run(card, project, ids.mr, now, now)
    old.db.prepare(`INSERT INTO column_history(id, card_id, from_column_id, to_column_id, changed_at, actor, reason) VALUES ('40000000-0000-4000-8000-000000000300', ?, ?, ?, ?, 'user', 'kanban-move')`).run(card, ids.test, ids.mr, now)
    old.close()

    const upgraded = new AppDatabase(path, '0.1.0'); await upgraded.open()
    const git = { validate: async () => undefined, branches: async () => ['dev'], inspect: async (localPath: string) => ({ localPath, name: 'p', repositories: [] }) }
    const board = new BoardRepository(upgraded, new ProjectRepository(upgraded, git)).get(project)
    expect(board.columns.map((column) => column.semanticState)).toEqual(['todo', 'doing', 'test', 'done'])
    expect(board.columns.find((column) => column.semanticState === 'todo')?.label).toBe('To do')
    expect(board.cards[0]?.columnId).toBe(ids.test)
    expect(upgraded.db.prepare('SELECT COUNT(*) AS value FROM column_history WHERE card_id = ?').get(card)).toEqual({ value: 2 })
    expect(upgraded.db.prepare(`SELECT reason FROM column_history WHERE actor = 'system'`).get()).toEqual({ reason: 'migration-mr-to-test' })
    upgraded.close()
  })

  it('archives an agent that has history instead of failing, and refuses while it is running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-profile-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
    const projects = new ProjectRepository(database, { validate: async () => undefined, inspect: async (localPath: string) => ({ localPath, name: 'P', repositories: [] }) } as never)
    const [used, clean] = profiles.list()
    const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev', profileIds: [used!.id, clean!.id] })
    const conversations = new ConversationRepository(database)
    const chat = conversations.createChat({ projectId: project.id, cardId: null, purpose: 'free', profileId: used!.id })
    const run = conversations.createRun({ cardId: null, chatId: chat.id, profileId: used!.id })
    conversations.updateRun(run.id, 'running', null)
    expect(() => profiles.delete(used!.id)).toThrow('está executando')
    conversations.updateRun(run.id, 'completed', null)
    expect(profiles.delete(used!.id)).toEqual({ deleted: true, archived: true })
    expect(profiles.list().map((item) => item.id)).toEqual([clean!.id])
    expect(profiles.removed().map((item) => [item.id, item.enabled])).toEqual([[used!.id, false]])
    expect(() => conversations.createChat({ projectId: project.id, cardId: null, purpose: 'free', profileId: used!.id })).toThrow('não permitido')
    expect(conversations.context(chat.id).profile.enabled).toBe(false)
    expect(profiles.delete(clean!.id)).toEqual({ deleted: true, archived: false })
    database.close()
  })
})

describe('ProfileRepository (S16 — new login required per profile)', () => {
  const roots: string[] = [], databases: AppDatabase[] = []
  afterEach(async () => { while (databases.length) databases.pop()!.close(); while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }) })

  it('never reads the CLI default folder, even with a session already logged in on the test machine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-s16-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open(); databases.push(database)
    const defaultCodexHome = join(root, '.codex'), defaultClaudeHome = join(root, '.claude')
    await mkdir(defaultCodexHome, { recursive: true }); await mkdir(defaultClaudeHome, { recursive: true })
    await writeFile(join(defaultCodexHome, 'auth.json'), '{"logged":"in"}')
    await writeFile(join(defaultClaudeHome, 'credentials.json'), '{"logged":"in"}')
    const profiles = new ProfileRepository(database, root)
    const codex = profiles.create({ provider: 'codex', label: 'Codex', scope: 'x' })
    const claude = profiles.create({ provider: 'claude', label: 'Claude', scope: 'x' })
    expect(codex.configDir).not.toBe(defaultCodexHome); expect(claude.configDir).not.toBe(defaultClaudeHome)
    expect(codex.configDir.startsWith(join(root, '.gearmod', 'profiles'))).toBe(true)
    expect(claude.configDir.startsWith(join(root, '.gearmod', 'profiles'))).toBe(true)
    expect(existsSync(join(codex.configDir, 'auth.json'))).toBe(false)
    expect(existsSync(join(claude.configDir, 'credentials.json'))).toBe(false)
  })

  it('each new profile gets its own isolated folder, even two from the same provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-s16-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open(); databases.push(database)
    const profiles = new ProfileRepository(database, root)
    const first = profiles.create({ provider: 'claude', label: 'Claude 1', scope: 'x' })
    const second = profiles.create({ provider: 'claude', label: 'Claude 2', scope: 'x' })
    expect(first.configDir).not.toBe(second.configDir)
  })
  it('Antigravity (gemini provider): only one profile, since the CLI keeps one Google account per computer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-antigravity-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root)
    const first = profiles.create({ provider: 'gemini', label: 'Antigravity', scope: 'x' })
    expect(profiles.list().some((item) => item.id === first.id)).toBe(true)
    expect(() => profiles.create({ provider: 'gemini', label: 'Outro', scope: 'x' })).toThrow(/Antigravity/)
    // After removing it (no history), a new one can be created.
    profiles.delete(first.id)
    expect(profiles.create({ provider: 'gemini', label: 'Novo', scope: 'x' }).provider).toBe('gemini')
    database.close()
  })

  it('disabling an agent takes it out of the lists and enabling it brings it back as it was', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-disable-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root)
    const agent = profiles.create({ provider: 'claude', label: 'Claudinho', scope: 'x' })
    expect(profiles.setEnabled(agent.id, false).enabled).toBe(false)
    expect(profiles.list().map((item) => item.id)).not.toContain(agent.id)
    expect(profiles.disabled().map((item) => item.label)).toEqual(['Claudinho'])
    expect(profiles.removed().map((item) => item.id)).toContain(agent.id)
    expect(() => profiles.get(agent.id)).toThrow()
    expect(profiles.setEnabled(agent.id, true)).toMatchObject({ id: agent.id, label: 'Claudinho', enabled: true })
    expect(profiles.disabled()).toEqual([])
    // A disabled Antigravity still counts as the only one: enable it instead of creating another.
    const gemini = profiles.create({ provider: 'gemini', label: 'Antigravity', scope: 'x' }); profiles.setEnabled(gemini.id, false)
    expect(() => profiles.create({ provider: 'gemini', label: 'Outro', scope: 'x' })).toThrow(/Antigravity/)
    database.close()
  })
})
