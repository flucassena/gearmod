import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentConfigRepository } from './agent-config'
import { ChecklistRepository, blockedChecklistItems, failedChecklistItems } from './checklists'
import { CollaborationService, type FollowUp } from './collaboration'
import { ConversationRepository } from './conversations'
import { AppDatabase } from './database'
import { BoardRepository, ProfileRepository, ProjectRepository } from './projects'
import { seedProfiles } from './test-helpers'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const git = { validate: async () => undefined, branches: async () => ['dev'], inspect: async (localPath: string) => ({ localPath, name: 'p', repositories: [] }) }

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-collab-')); roots.push(root)
  const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
  const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
  const projects = new ProjectRepository(database, git), board = new BoardRepository(database, projects), conversations = new ConversationRepository(database)
  const [codex, claude] = profiles.list()
  const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev', profileIds: [claude!.id, codex!.id] })
  const card = board.create({ projectId: project.id, columnId: board.get(project.id).columns[2]!.id, title: 'Card', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
  const planning = conversations.createChat({ projectId: project.id, cardId: card.id, purpose: 'planning', profileId: claude!.id })
  const dev = conversations.createChat({ projectId: project.id, cardId: card.id, purpose: 'execution', profileId: codex!.id })
  const tester = conversations.createChat({ projectId: project.id, cardId: card.id, purpose: 'test', profileId: codex!.id })
  const started: FollowUp[] = []
  const checklists = new ChecklistRepository(database)
  const collab = new CollaborationService(database, board, conversations, new AgentConfigRepository(database, board, profiles), undefined, checklists)
  collab.setStarter((action) => { started.push(action) })
  return { database, board, collab, card, planning, dev, tester, started, conversations, checklists }
}

describe('questions between steps', () => {
  it('sends a developer question to the planner after the dev run ends and resumes the dev with the answer', async () => {
    const { database, board, collab, card, planning, dev, started } = await setup()
    const question = collab.askQuestion({ cardId: card.id, chatId: dev.id, purpose: 'execution', question: 'Qual formato de data usar?' })
    expect(question).toMatchObject({ number: 1, status: 'open' })
    expect(board.documents.read(card.id, 'duvidas')).toContain('D001 · aberta'); expect(started).toHaveLength(0)
    collab.afterRun({ cardId: card.id, chatId: dev.id, purpose: 'execution', status: 'completed' })
    expect(started).toHaveLength(1); expect(started[0]).toMatchObject({ chatId: planning.id, planning: true }); expect(started[0]!.prompt).toContain('D001 (developer): Qual formato de data usar?')
    expect(collab.list(card.id).questions[0]!.status).toBe('planner')
    collab.answerFromPlanner(card.id, 1, 'Use ISO 8601.')
    collab.afterRun({ cardId: card.id, chatId: planning.id, purpose: 'planning', status: 'completed' })
    expect(started).toHaveLength(2); expect(started[1]).toMatchObject({ chatId: dev.id, planning: false }); expect(started[1]!.prompt).toContain('Answer (planner): Use ISO 8601.')
    expect(board.documents.read(card.id, 'duvidas')).toContain('respondida')
    collab.afterRun({ cardId: card.id, chatId: planning.id, purpose: 'planning', status: 'completed' })
    expect(started).toHaveLength(2)
    database.close()
  })

  it('escalates to the user when the planner asks, and resumes the tester after the user answers', async () => {
    const { database, collab, card, planning, tester, started } = await setup()
    collab.askQuestion({ cardId: card.id, chatId: tester.id, purpose: 'test', question: 'Posso apagar os dados de teste?' })
    collab.afterRun({ cardId: card.id, chatId: tester.id, purpose: 'test', status: 'completed' })
    collab.escalateToUser(card.id, 1, 'O usuário autoriza apagar os dados de teste?')
    collab.afterRun({ cardId: card.id, chatId: planning.id, purpose: 'planning', status: 'completed' })
    expect(started).toHaveLength(1)
    expect(collab.counts(card.id)).toEqual({ changes: 0, questions: 1, toSend: 0 })
    const [item] = collab.list(card.id).questions
    collab.answerByUser(item!.id, 'Pode, só no banco de teste.')
    expect(started).toHaveLength(2); expect(started[1]).toMatchObject({ chatId: tester.id, planning: false }); expect(started[1]!.prompt).toContain('Answer (user): Pode, só no banco de teste.')
    expect(collab.counts(card.id).questions).toBe(0)
    expect(() => collab.answerByUser(item!.id, 'de novo')).toThrow('não está esperando')
    database.close()
  })

  it('retries an unanswered question once and then sends it to the user', async () => {
    const { database, collab, card, planning, dev, started } = await setup()
    collab.askQuestion({ cardId: card.id, chatId: dev.id, purpose: 'execution', question: 'Dúvida?' })
    collab.afterRun({ cardId: card.id, chatId: dev.id, purpose: 'execution', status: 'completed' })
    collab.afterRun({ cardId: card.id, chatId: planning.id, purpose: 'planning', status: 'completed' })
    expect(started).toHaveLength(2); expect(started[1]!.prompt).toContain('not answered the questions')
    collab.afterRun({ cardId: card.id, chatId: planning.id, purpose: 'planning', status: 'completed' })
    expect(started).toHaveLength(2)
    expect(collab.list(card.id).questions[0]).toMatchObject({ status: 'user', userQuestion: 'Dúvida?' })
    database.close()
  })

  it('does not chain anything when the run did not complete and refuses planner self-questions', async () => {
    const { database, collab, card, planning, dev, started } = await setup()
    collab.askQuestion({ cardId: card.id, chatId: dev.id, purpose: 'execution', question: 'x?' })
    collab.afterRun({ cardId: card.id, chatId: dev.id, purpose: 'execution', status: 'interrupted' })
    expect(started).toHaveLength(0)
    expect(() => collab.askQuestion({ cardId: card.id, chatId: planning.id, purpose: 'planning', question: 'eu?' })).toThrow('does not ask itself')
    expect(() => collab.answerFromPlanner(card.id, 9, 'x')).toThrow('não encontrada')
    database.close()
  })
})

describe('changes awaiting authorization', () => {
  it('accept: the planner updates the documents, then the author resumes', async () => {
    const { database, board, collab, card, planning, dev, started } = await setup()
    const change = collab.proposeChange({ cardId: card.id, chatId: dev.id, purpose: 'execution', title: 'Cache de consultas', details: 'Adicionar cache em memória', reason: 'A tela fica lenta' })
    expect(change).toMatchObject({ number: 1, status: 'pending' }); expect(collab.counts(card.id).changes).toBe(1)
    expect(board.documents.read(card.id, 'mudancas')).toContain('M001 · Cache de consultas · aguardando sua autorização')
    collab.decideChange(change.id, 'accept')
    expect(started).toHaveLength(1); expect(started[0]).toMatchObject({ chatId: planning.id, planning: true }); expect(started[0]!.prompt).toContain('AUTHORIZED')
    expect(collab.counts(card.id).changes).toBe(0)
    collab.afterRun({ cardId: card.id, chatId: planning.id, purpose: 'planning', status: 'completed' })
    expect(started).toHaveLength(2); expect(started[1]).toMatchObject({ chatId: dev.id, planning: false }); expect(started[1]!.prompt).toContain('AUTHORIZED')
    expect(collab.list(card.id).changes[0]!.status).toBe('applied')
    expect(() => collab.decideChange(change.id, 'accept')).toThrow('já foi decidida')
    database.close()
  })

  it('reject goes straight back to the author; suggest needs a note and goes through the planner', async () => {
    const { database, collab, card, planning, dev, tester, started } = await setup()
    const first = collab.proposeChange({ cardId: card.id, chatId: tester.id, purpose: 'test', title: 'Teste extra', details: 'Cobrir X', reason: 'Risco' })
    collab.decideChange(first.id, 'reject', 'Fora do escopo')
    expect(started).toHaveLength(1); expect(started[0]).toMatchObject({ chatId: tester.id, planning: false }); expect(started[0]!.prompt).toContain('REJECTED'); expect(started[0]!.prompt).toContain('Fora do escopo')
    const second = collab.proposeChange({ cardId: card.id, chatId: tester.id, purpose: 'test', title: 'Outro', details: 'Y', reason: 'Z' })
    expect(() => collab.decideChange(second.id, 'suggest')).toThrow('sua visão')
    collab.decideChange(second.id, 'suggest', 'Prefiro cobrir só o caso principal')
    expect(started[1]).toMatchObject({ chatId: planning.id, planning: true }); expect(started[1]!.prompt).toContain('Prefiro cobrir só o caso principal')
    collab.afterRun({ cardId: card.id, chatId: planning.id, purpose: 'planning', status: 'completed' })
    // The tester's proposal is implemented by the developer, not sent back to the test chat.
    expect(started[2]).toMatchObject({ chatId: dev.id, planning: false }); expect(started[2]!.prompt).toContain('different view'); expect(started[2]!.prompt).toContain('proposed by the tester')
    expect(() => collab.proposeChange({ cardId: card.id, chatId: planning.id, purpose: 'planning', title: 'a', details: 'b', reason: 'c' })).toThrow('developer and the tester')
    database.close()
  })

  it("accepted tester proposal goes to the developer, both after the planner and from the send button", async () => {
    const { database, collab, card, planning, dev, tester, started } = await setup()
    const change = collab.proposeChange({ cardId: card.id, chatId: tester.id, purpose: 'test', title: 'Teste de borda', details: 'Cobrir lista vazia', reason: 'Não coberto' })
    collab.decideChange(change.id, 'accept')
    collab.afterRun({ cardId: card.id, chatId: planning.id, purpose: 'planning', status: 'completed' })
    expect(started[1]).toMatchObject({ chatId: dev.id, planning: false }); expect(started[1]!.prompt).toContain('Implement it according to the updated documents')
    collab.sendChange(change.id)
    expect(started[2]).toMatchObject({ chatId: dev.id }); expect(started.some((item) => item.chatId === tester.id)).toBe(false)
    database.close()
  })

  it('without an implementation chat, the accepted tester proposal stays to send', async () => {
    const { database, board, collab, card: first, planning: firstPlanning, tester: firstTester, started, conversations } = await setup()
    // Another card with only planning and test chats (no implementation yet).
    const card = board.create({ projectId: first.projectId, columnId: first.columnId, title: 'Sem dev', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    const planning = conversations.createChat({ projectId: card.projectId, cardId: card.id, purpose: 'planning', profileId: firstPlanning.profileId })
    const tester = conversations.createChat({ projectId: card.projectId, cardId: card.id, purpose: 'test', profileId: firstTester.profileId })
    const change = collab.proposeChange({ cardId: card.id, chatId: tester.id, purpose: 'test', title: 'X', details: 'Y', reason: 'Z' })
    collab.decideChange(change.id, 'accept')
    collab.afterRun({ cardId: card.id, chatId: planning.id, purpose: 'planning', status: 'completed' })
    expect(started).toHaveLength(1); expect(collab.counts(card.id).toSend).toBe(1)
    database.close()
  })
})

describe('test failures to the developer', () => {
  it('does not treat a pending/unverifiable note as a failure', () => {
    const md = '- [ ] Validação visual — pendente: sem Playwright CLI, precisa de teste manual\n- [ ] CA02 — pending: needs a browser\n- [ ] CA03 — falhou: erro no perfil\n'
    expect(failedChecklistItems(md)).toEqual(['CA03 — falhou: erro no perfil'])
    expect(blockedChecklistItems(md)).toEqual(['Validação visual — pendente: sem Playwright CLI, precisa de teste manual', 'CA02 — pending: needs a browser'])
  })

  it('picks only unchecked items with a failure note, in any language', () => {
    expect(failedChecklistItems('- [x] Lint passou\n- [ ] CA01 botão aparece — falhou: não aparece no perfil admin\n- [ ] CA02 ainda não verificado\n  - [ ] sub — failed: timeout\n- [x] CA03 — falhou: corrigido\n')).toEqual(['CA01 botão aparece — falhou: não aparece no perfil admin', 'sub — failed: timeout'])
    expect(failedChecklistItems('')).toEqual([])
  })

  it('sends the failures to the implementation chat and refuses when there are none', async () => {
    const { database, collab, card, dev, started, checklists } = await setup()
    checklists.write(card.id, '- [x] Testes passam\n- [ ] Lint\n')
    expect(() => collab.sendTestFailures(card.id)).toThrow()
    checklists.write(card.id, '- [x] Testes passam\n- [ ] CA01 exporta CSV — falhou: separador errado\n')
    collab.sendTestFailures(card.id)
    expect(started).toHaveLength(1); expect(started[0]).toMatchObject({ chatId: dev.id, planning: false })
    expect(started[0]!.prompt).toContain('- CA01 exporta CSV — falhou: separador errado'); expect(started[0]!.prompt).not.toContain('Testes passam')
    database.close()
  })
})
