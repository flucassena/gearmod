import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationRepository } from './conversations'
import { AppDatabase } from './database'
import { ExecutionService } from './executions'
import { BoardRepository, ProfileRepository, ProjectRepository } from './projects'
import { seedProfiles } from './test-helpers'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const git = { validate: async () => undefined, branches: async () => ['dev'], inspect: async (localPath: string) => ({ localPath, name: 'p', repositories: [] }) }

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-exec-')); roots.push(root)
  const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
  const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
  const projects = new ProjectRepository(database, git), board = new BoardRepository(database, projects), conversations = new ConversationRepository(database)
  const profile = profiles.list()[0]!
  const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev', profileIds: [profile.id] })
  const columns = board.get(project.id).columns
  const card = board.create({ projectId: project.id, columnId: columns[0]!.id, title: 'Executar', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
  const started: Array<{ chatId: string; prompt: string; planning: boolean; notice?: string }> = []
  const orchestrator = { start(input: { chatId: string; prompt: string; planning: boolean; notice?: string }) { started.push(input); const run = conversations.createRun({ cardId: card.id, chatId: input.chatId, profileId: String(database.db.prepare('SELECT profile_id FROM chats WHERE id = ?').pluck().get(input.chatId) ?? profile.id) }); conversations.updateRun(run.id, 'running', null); return { ...run, status: 'running' as const } } }
  return { database, board, conversations, projects, profile, profiles: profiles.list(), project, columns, card, started, service: new ExecutionService(board, conversations, orchestrator) }
}

describe('ExecutionService', () => {
  it('a failed run (e.g. agent without a token) leaves the card "failed" with the reason, and picking another agent restarts the stage chat', async () => {
    const { database, board, conversations, profile, profiles, projects, project, card, started, service } = await setup()
    const other = profiles.find((item) => item.id !== profile.id)!
    projects.setProfiles(project.id, [profile.id, other.id])
    board.documents.write(card.id, 'plano', '## Plano\nFazer')
    const first = service.start(card.id, { profileId: profile.id, model: null, effort: null, mode: 'auto' })
    conversations.updateRun(first.id, 'failed', 'Not logged in')
    expect(board.card(card.id).run).toMatchObject({ state: 'failed', error: 'Not logged in', purpose: 'execution' })
    expect(() => service.start(card.id, { profileId: other.id, model: null, effort: null, mode: 'auto' })).toThrow()
    service.start(card.id, { profileId: other.id, model: null, effort: null, mode: 'auto' }, 'execution', undefined, true)
    const chats = conversations.listChats(board.card(card.id).projectId, card.id).filter((chat) => chat.purpose === 'execution')
    expect(chats).toHaveLength(1); expect(chats[0]!.profileId).toBe(other.id); expect(started[1]!.chatId).toBe(chats[0]!.id)
    database.close()
  })
  it('continuing a card with no stage chat says so with its own code, so the screen can ask for the agent', async () => {
    const { database, card, service } = await setup()
    expect(() => service.resume(card.id, 'test')).toThrow(/^\[\[nothing-to-continue\]\]/)
    database.close()
  })
  it('Iniciar approves the plan, moves the card to Doing and reuses one execution chat per card', async () => {
    const { database, board, conversations, profile, columns, card, started, service } = await setup()
    board.documents.write(card.id, 'plano', '## Plano\nFazer')
    const run = service.start(card.id, { profileId: profile.id, model: null, effort: null, mode: 'auto' })
    expect(run.status).toBe('running')
    expect(board.card(card.id).columnId).toBe(columns[1]!.id)
    expect(conversations.listPlans(card.id)[0]).toMatchObject({ status: 'approved', contentMd: '## Plano\nFazer' })
    expect(started[0]).toMatchObject({ planning: false }); expect(started[0]!.prompt).toBe('Use the gearmod-implement skill to implement this card.'); expect(started[0]!.notice).toBe('▶ Usando a skill gearmod-implement')
    expect(board.card(card.id).run).toMatchObject({ state: 'running', runId: run.id })
    expect(() => service.start(card.id, { profileId: profile.id, model: null, effort: null, mode: 'auto' })).toThrow('já tem um agente')
    conversations.updateRun(run.id, 'interrupted', 'Interrompido pelo usuário')
    expect(board.card(card.id).run.state).toBe('paused')
    service.resume(card.id)
    expect(conversations.listChats(board.card(card.id).projectId, card.id).filter((chat) => chat.purpose === 'execution')).toHaveLength(1)
    expect(started[1]!.chatId).toBe(started[0]!.chatId); expect(started[1]!.prompt).toContain('gearmod-implement'); expect(started[1]!.prompt).toContain('where it left off')
    database.close()
  })

  it('short flow: a single agent, no plan approval and no test step', async () => {
    const { database, board, conversations, profile, card, started, service } = await setup()
    database.db.prepare("UPDATE cards SET workflow = 'light' WHERE id = ?").run(card.id)
    board.update({ cardId: card.id, type: 'improvement', title: 'Trocar texto', description: 'Trocar "Salvar" por "Gravar" no botão', priority: 'low', acceptanceCriteria: [] })
    expect(board.card(card.id).hasPlan).toBe(true)
    expect(() => service.start(card.id, { profileId: profile.id, model: null, effort: null, mode: 'auto' }, 'test')).toThrow('não tem etapa de teste')
    service.start(card.id, { profileId: profile.id, model: null, effort: null, mode: 'auto' })
    expect(conversations.listPlans(card.id)).toHaveLength(0)
    expect(started[0]!.prompt).toBe('Use the gearmod-small skill to do this card in the short workflow from start to finish.'); expect(started[0]!.notice).toBe('▶ Usando a skill gearmod-small')
    database.close()
  })

  it('short flow: Start carries on in the planning chat instead of opening another one', async () => {
    const { database, board, conversations, profile, card, started, service } = await setup()
    database.db.prepare("UPDATE cards SET workflow = 'light' WHERE id = ?").run(card.id)
    const planning = conversations.createChat({ projectId: board.card(card.id).projectId, cardId: card.id, purpose: 'planning', profileId: profile.id })
    service.start(card.id, { profileId: profile.id, model: null, effort: null, mode: 'auto' })
    const chats = conversations.listChats(board.card(card.id).projectId, card.id)
    expect(chats).toHaveLength(1)
    expect(chats[0]).toMatchObject({ id: planning.id, purpose: 'execution' })
    expect(started[0]!.chatId).toBe(planning.id)
    database.close()
  })

  it('does not resume a card that never ran', async () => {
    const { database, card, service } = await setup()
    expect(() => service.resume(card.id)).toThrow('ainda não tem execução')
    database.close()
  })
})

describe('test step and chat reset', () => {
  it('runs the test step in its own chat, locks the agent per chat and resumes the right one', async () => {
    const { database, board, conversations, profiles, columns, card, started, service } = await setup()
    const [codex, claude] = [profiles[0]!, profiles[1]!]
    const exec = service.start(card.id, { profileId: codex.id, model: null, effort: null, mode: 'auto' })
    conversations.updateRun(exec.id, 'completed', null)
    const testRun = service.start(card.id, { profileId: codex.id, model: null, effort: null, mode: 'auto' }, 'test')
    expect(started[1]!.prompt).toBe('Use the gearmod-test skill to test this card.'); expect(started[0]!.chatId).not.toBe(started[1]!.chatId)
    expect(board.card(card.id).run).toMatchObject({ state: 'running', purpose: 'test', runId: testRun.id })
    expect(board.card(card.id).columnId).toBe(columns.find((column) => column.semanticState === 'test')!.id)
    conversations.updateRun(testRun.id, 'interrupted', 'x')
    expect(() => service.start(card.id, { profileId: claude.id, model: null, effort: null, mode: 'accept_edits' }, 'test')).toThrow('reinicia o chat')
    service.resume(card.id, 'execution'); expect(started[2]!.chatId).toBe(started[0]!.chatId)
    database.close()
  })

  it('resets one chat without touching the others and refuses while an agent is working', async () => {
    const { database, board, conversations, profiles, project, card, service } = await setup()
    const profile = profiles[0]!
    const planning = conversations.createChat({ projectId: project.id, cardId: card.id, purpose: 'planning', profileId: profile.id })
    conversations.addMessage({ chatId: planning.id, role: 'user', body: 'oi', status: 'complete' })
    const run = service.start(card.id, { profileId: profile.id, model: null, effort: null, mode: 'auto' })
    const execChat = conversations.listChats(project.id, card.id).find((chat) => chat.purpose === 'execution')!
    expect(() => conversations.resetChat(execChat.id)).toThrow('Pare o agente')
    conversations.updateRun(run.id, 'interrupted', 'x')
    conversations.resetChat(execChat.id)
    expect(conversations.listChats(project.id, card.id).map((chat) => chat.purpose)).toEqual(['planning'])
    expect(conversations.listMessages(planning.id)).toHaveLength(1)
    expect(board.card(card.id).run.state).toBe('idle')
    expect(() => conversations.resetChat(execChat.id)).toThrow('não encontrado')
    database.close()
  })
})

describe('chat skill', () => {
  it('stores a chosen skill per chat and clears it', async () => {
    const { database, conversations, project, profile, card } = await setup()
    const chat = conversations.createChat({ projectId: project.id, cardId: card.id, purpose: 'planning', profileId: profile.id, skill: { name: 'tdd', path: '/x/tdd' } })
    expect(chat.skill).toEqual({ name: 'tdd', path: '/x/tdd' })
    expect(conversations.context(chat.id).chat.skill?.name).toBe('tdd')
    expect(conversations.setSkill(chat.id, null).skill).toBeNull()
    expect(conversations.projectOf(chat.id)).toBe(project.id)
    database.close()
  })
})

describe('card run state', () => {
  it('highlights a finished run until the user views it and counts activity per project', async () => {
    const { database, board, conversations, projects, project, profile, card } = await setup()
    const chat = conversations.createChat({ projectId: project.id, cardId: card.id, purpose: 'execution', profileId: profile.id })
    expect(board.card(card.id).run.state).toBe('idle')
    const run = conversations.createRun({ cardId: card.id, chatId: chat.id, profileId: profile.id })
    conversations.updateRun(run.id, 'running', null)
    expect(projects.get(project.id).activity).toEqual({ running: 1, finished: 0 })
    conversations.updateRun(run.id, 'completed', null)
    expect(board.card(card.id).run.state).toBe('finished'); expect(projects.get(project.id).activity).toEqual({ running: 0, finished: 1 })
    expect(board.markViewed(card.id).run.state).toBe('idle'); expect(projects.get(project.id).activity).toEqual({ running: 0, finished: 0 })
    const planning = conversations.createChat({ projectId: project.id, cardId: card.id, purpose: 'planning', profileId: profile.id })
    const planningRun = conversations.createRun({ cardId: card.id, chatId: planning.id, profileId: profile.id })
    conversations.updateRun(planningRun.id, 'running', null)
    expect(board.card(card.id).run.state).toBe('planning')
    database.close()
  })
})
