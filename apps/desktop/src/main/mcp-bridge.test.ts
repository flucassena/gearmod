import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentContextService } from './agent-context'
import { AgentWriteback, titleFromPrompt } from './agent-writeback'
import { AppDatabase } from './database'
import { extractDocuments, McpBridge, type CardChange } from './mcp-bridge'
import { BoardRepository, ProjectRepository } from './projects'
import { SettingsRepository } from './settings'
import { AgentConfigRepository } from './agent-config'
import { CollaborationService, type FollowUp } from './collaboration'
import { ConversationRepository } from './conversations'
import { ProfileRepository } from './projects'
import { seedProfiles } from './test-helpers'
import { ApprovalService } from './approvals'
import { PolicyEngine } from './policy'
import { CardHistoryService } from './history'
import { defaultWorkflowConfig } from '@gearmod/contracts'

const roots: string[] = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const git = { validate: async () => undefined, branches: async () => ['dev'], inspect: async (localPath: string) => ({ localPath, name: 'p', repositories: [] }) }
const serverScript = join(__dirname, '..', '..', 'resources', 'gearmod-mcp', 'server.mjs')

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-mcp-')); roots.push(root)
  const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
  const projects = new ProjectRepository(database, git), board = new BoardRepository(database, projects)
  const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev' })
  const columns = board.get(project.id).columns
  const card = board.create({ projectId: project.id, columnId: columns[0]!.id, title: 'MCP', description: 'Resumo', type: 'task', priority: 'medium', acceptanceCriteria: [] })
  const context = new AgentContextService(board, new SettingsRepository(database), null)
  const bridge = new McpBridge({ board, context, serverScript, runtime: process.execPath }); await bridge.listen()
  closers.push(async () => { await bridge.close(); database.close() })
  return { board, bridge, card, columns, project, database, projects, root }
}

/** Minimal MCP client that talks to the real stdio server, like Claude and Codex do. */
function mcpClient(endpoint: { command: string; args: string[]; env: Record<string, string> }) {
  const child = spawn(endpoint.command, endpoint.args, { env: { ...process.env, ...endpoint.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['pipe', 'pipe', 'pipe'] })
  closers.push(async () => { child.kill() })
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  createInterface({ input: child.stdout }).on('line', (line) => { const message = JSON.parse(line) as { id: number }; pending.get(message.id)?.(message as unknown as Record<string, unknown>) })
  let id = 0
  const request = (method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolve) => { id += 1; pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`) })
  const call = async (name: string, args: unknown) => { const reply = await request('tools/call', { name, arguments: args }); return (reply.result as { content: Array<{ text: string }>; isError: boolean }) }
  return { request, call }
}

describe('GearMod MCP server', () => {
  it('does not write parallel documents or finish Spec Kit planning through MCP or markers', async () => {
    const { board, card, database, root } = await setup()
    const history = new CardHistoryService(database, root)
    history.selectWorkflow(card.id, 'sdd', { actor: 'user' }, '', 'user', 'speckit')
    const context = new AgentContextService(board, new SettingsRepository(database), null)
    const bridge = new McpBridge({ board, context, serverScript, runtime: process.execPath, history })
    await bridge.listen(); closers.push(() => bridge.close())
    const client = mcpClient(bridge.register('run-speckit', card.id, () => undefined, { id: 'chat', purpose: 'planning' }))
    expect((await client.call('gearmod_write_document', { tipo: 'especificacao', markdown: '# Spec' })).isError).toBe(true)
    expect((await client.call('gearmod_finish_planning', {})).isError).toBe(true)
    new AgentWriteback(board, bridge).finish({ runId: 'run-speckit', cardId: card.id, planning: true, completed: true, text: '<!-- gearmod:documento tipo=especificacao -->\n# Paralelo\n<!-- /gearmod:documento -->\n<!-- gearmod:planejamento-concluido -->', publish: () => undefined })
    expect(board.documents.read(card.id, 'especificacao')).toBe('')
    expect(board.card(card.id).hasPlan).toBe(false)
  })
  it('proposes the Constitution without writing before approval', async () => {
    const { board, card, project, database } = await setup()
    const approvals = new ApprovalService(database)
    const context = new AgentContextService(board, new SettingsRepository(database), null)
    const bridge = new McpBridge({ board, context, serverScript, runtime: process.execPath, conversations: { projectOf: () => project.id, convertToPlanning: () => undefined }, approvals,
      sddResolver: { constitution: async () => ({ path: '.gearmod/constitution.md', content: 'antes', blobSha: 'abc', baseBlobSha: 'abc', headBlobSha: 'abc', state: 'in-sync', method: 'native', via: 'ref' }), locate: async () => ({ repo: 'repo', rootAbs: 'repo', ref: 'main', via: 'ref', sourceId: project.id, method: 'native', worktreeBranch: null }) } })
    await bridge.listen(); closers.push(() => bridge.close())
    const client = mcpClient(bridge.register('run-proposal', card.id, () => undefined, { id: 'chat', purpose: 'constitution' }))
    const result = await client.call('gearmod_write_constitution', { markdown: 'depois\n' })
    expect(result.isError).toBe(false)
    expect(result.content[0]!.text).toContain('has not been changed yet')
    expect(approvals.list(card.id)[0]).toMatchObject({ kind: 'constitution-apply', status: 'requested', payload: { before: 'antes', content: 'depois\n', expectBlobSha: 'abc' } })
  })
  it('lists the tools and lets the agent read, write, check tasks and move the card with the run token', async () => {
    const { board, bridge, card, columns } = await setup()
    const changes: CardChange[] = []
    const client = mcpClient(bridge.register('run-1', card.id, (change) => changes.push(change)))
    const init = await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('gearmod')
    const listed = await client.request('tools/list')
    // Without a code index in the bridge, the gearmod_code_* tools do not appear (see code-index/mcp-code-tools.test.ts).
    // S14: run-1 is 'execution' (register() default); tools/list returns only that role's tools, not the 23 of the whole catalog.
    expect((listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(['gearmod_read_skill', 'gearmod_card_context', 'gearmod_write_document', 'gearmod_mark_task', 'gearmod_update_card', 'gearmod_propose_change', 'gearmod_ask_planner', 'gearmod_read_constitution', 'gearmod_propose_constitution', 'gearmod_move_card', 'gearmod_request_commit', 'gearmod_record_understanding', 'gearmod_record_exploration', 'gearmod_assess_complexity', 'gearmod_choose_workflow', 'gearmod_set_repositories', 'gearmod_record_decision'])

    expect((await client.call('gearmod_card_context', {})).content[0]!.text).toContain('"titulo": "MCP"')
    const bad = await client.call('gearmod_write_document', { tipo: 'tasks', markdown: 'sem itens' })
    expect(bad.isError).toBe(true); expect(bad.content[0]!.text).toContain('T001')
    expect((await client.call('gearmod_write_document', { tipo: 'tasks', markdown: '## Tasks\n- [ ] T001 Primeira\n  - [ ] Critério' })).isError).toBe(false)
    expect(board.documents.get(card.id).tasks.updatedBy).toBe('agent')
    expect((await client.call('gearmod_mark_task', { linha: 2, feito: true })).isError).toBe(false)
    expect(board.card(card.id).tasks).toEqual({ done: 1, total: 1 })
    expect((await client.call('gearmod_update_card', { titulo: 'Novo título', prioridade: 'urgent' })).isError).toBe(false)
    expect(board.card(card.id)).toMatchObject({ title: 'Novo título', priority: 'urgent', type: 'task', description: 'Resumo' })
    expect((await client.call('gearmod_update_card', { tipo: 'invalido' })).isError).toBe(true)
    // Type comes from the project's list (id or name); the error lists the valid ones and reminds that the short flow is not a type.
    const minor = await client.call('gearmod_update_card', { tipo: 'minor' })
    expect(minor.isError).toBe(true); expect(JSON.stringify(minor.content)).toContain('feature (Feature), bug (Bug), improvement (Improvement)'); expect(JSON.stringify(minor.content)).toContain('fluxo light')
    expect((await client.call('gearmod_update_card', { tipo: 'Improvement' })).isError).toBe(false)
    expect(board.card(card.id).type).toBe('improvement')
    board.update({ cardId: card.id, type: 'task', title: 'Novo título', description: 'Resumo', priority: 'urgent', acceptanceCriteria: [] })
    const moved = await client.call('gearmod_move_card', { coluna: 'Doing', quando: 'agora' })
    expect(moved.content[0]!.text).toContain('Doing'); expect(board.card(card.id).columnId).toBe(columns[1]!.id)
    const refused = await client.call('gearmod_move_card', { coluna: 'Done', quando: 'agora' })
    expect(refused.isError).toBe(true); expect(refused.content[0]!.text).toContain('Testes automatizados')
    expect(changes.map((change) => change.type)).toEqual(['document', 'task', 'card', 'card', 'moved'])
    await client.call('gearmod_move_card', { coluna: 'test', quando: 'ao_terminar' })
    expect(bridge.finish('run-1')).toEqual({ written: ['tasks'], pendingMove: columns[2]!.id })
  })

  it('B2: the Constitution chat lists gearmod_create_card, which the skill tells it to call', async () => {
    const { bridge } = await setup()
    const client = mcpClient(bridge.register('run-const', null, () => undefined, { id: 'chat-c', purpose: 'constitution' }))
    await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    const names = (await client.request('tools/list').then((reply) => (reply.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)))
    expect(names).toContain('gearmod_create_card'); expect(names).toContain('gearmod_write_constitution')
  })

  it('S14: each role sees only its own tools; the planner sees neither request_commit nor test_checklist', async () => {
    const { bridge, card } = await setup()
    const client = mcpClient(bridge.register('run-plan', card.id, () => undefined, { id: 'chat-1', purpose: 'planning' }))
    await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    const names = (await client.request('tools/list').then((reply) => (reply.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)))
    expect(names).toContain('gearmod_finish_planning'); expect(names).toContain('gearmod_answer_question')
    expect(names).not.toContain('gearmod_request_commit'); expect(names).not.toContain('gearmod_test_checklist'); expect(names).not.toContain('gearmod_create_card')
    expect(names.length).toBeLessThan(23)
    // The list is not the only barrier: even outside it, the app's handle() refuses with the right notice (it decides, not the filter).
    const refused = await client.call('gearmod_request_commit', { mensagem: 'x' })
    expect(refused.isError).toBe(true)
  })

  it('S11: a PolicyEngine deny rule blocks moving and choosing a flow before any approval request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-mcp-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const projects = new ProjectRepository(database, git), board = new BoardRepository(database, projects)
    const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev' })
    const columns = board.get(project.id).columns
    const card = board.create({ projectId: project.id, columnId: columns[0]!.id, title: 'MCP', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    const context = new AgentContextService(board, new SettingsRepository(database), null)
    const history = new CardHistoryService(database, root)
    history.setConfig(project.id, { ...defaultWorkflowConfig, policy: { rules: [{ action: 'move', decision: 'deny' }, { action: 'choose-workflow', decision: 'deny' }] } })
    const approvals = new ApprovalService(database), policy = new PolicyEngine(database)
    const bridge = new McpBridge({ board, context, serverScript, runtime: process.execPath, approvals, policy, history }); await bridge.listen()
    closers.push(async () => { await bridge.close(); database.close() })
    const client = mcpClient(bridge.register('run-1', card.id, () => undefined))
    await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    const moved = await client.call('gearmod_move_card', { coluna: 'Doing', quando: 'agora' })
    expect(moved.isError).toBe(true); expect(moved.content[0]!.text).toContain('policy')
    // B9: "when finishing" also respects the policy
    const later = await client.call('gearmod_move_card', { coluna: 'Doing', quando: 'ao_terminar' })
    expect(later.isError).toBe(true); expect(later.content[0]!.text).toContain('policy')
    expect(board.card(card.id).columnId).toBe(columns[0]!.id)
    expect(approvals.list(card.id)).toHaveLength(0)
    const events = database.db.prepare("SELECT json FROM card_events WHERE card_id = ? AND type = 'policy.decided'").all(card.id) as Array<{ json: string }>
    expect(events.map((event) => JSON.parse(event.json))).toContainEqual({ action: 'move', decision: 'deny' })
  })

  it('S9: an explicit ask rule does not allow it alone: the move becomes an approval request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-mcp-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const projects = new ProjectRepository(database, git), board = new BoardRepository(database, projects)
    const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev' })
    const columns = board.get(project.id).columns
    const card = board.create({ projectId: project.id, columnId: columns[0]!.id, title: 'MCP', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    const context = new AgentContextService(board, new SettingsRepository(database), null)
    const history = new CardHistoryService(database, root)
    history.setConfig(project.id, { ...defaultWorkflowConfig, policy: { rules: [{ action: 'move', decision: 'ask' }] } })
    const approvals = new ApprovalService(database), policy = new PolicyEngine(database)
    const bridge = new McpBridge({ board, context, serverScript, runtime: process.execPath, approvals, policy, history }); await bridge.listen()
    closers.push(async () => { await bridge.close(); database.close() })
    const client = mcpClient(bridge.register('run-1', card.id, () => undefined))
    await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    const moved = await client.call('gearmod_move_card', { coluna: 'Doing', quando: 'agora' })
    expect(moved.isError).toBeFalsy(); expect(moved.content[0]!.text).toContain('awaiting')
    expect(board.card(card.id).columnId).toBe(columns[0]!.id)
    expect(approvals.list(card.id)).toHaveLength(1)
    const events = database.db.prepare("SELECT json FROM card_events WHERE card_id = ? AND type = 'policy.decided'").all(card.id) as Array<{ json: string }>
    expect(events.map((event) => JSON.parse(event.json))).toContainEqual({ action: 'move', decision: 'ask' })
  })

  it('S05 behind the flag: an immediate move becomes a pending request, applied only after approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-mcp-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const projects = new ProjectRepository(database, git), board = new BoardRepository(database, projects)
    const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev' })
    const columns = board.get(project.id).columns
    const card = board.create({ projectId: project.id, columnId: columns[0]!.id, title: 'MCP', description: 'Resumo', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    const context = new AgentContextService(board, new SettingsRepository(database), null)
    const approvals = new ApprovalService(database)
    const bridge = new McpBridge({ board, context, serverScript, runtime: process.execPath, approvals, agentMoveApproval: true }); await bridge.listen()
    closers.push(async () => { await bridge.close(); database.close() })
    const client = mcpClient(bridge.register('run-1', card.id, () => undefined))
    await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    const reply = await client.call('gearmod_move_card', { coluna: 'Doing', quando: 'agora' })
    expect(reply.isError).toBe(false); expect(reply.content[0]!.text).toContain("awaiting the user's approval")
    expect(board.card(card.id).columnId).toBe(columns[0]!.id)
    const pending = approvals.list(card.id).find((item) => item.kind === 'agent-move' && item.status === 'requested')!
    approvals.decide(pending.id, true)
    board.move(card.id, pending.payload.columnId as string, null, 'agent')
    expect(board.card(card.id).columnId).toBe(columns[1]!.id)
  })

  it('rejects calls with an unknown token or after the run finished', async () => {
    const { bridge, card } = await setup()
    const endpoint = bridge.register('run-2', card.id, () => undefined)
    bridge.finish('run-2')
    const client = mcpClient(endpoint)
    const answer = await client.call('gearmod_card_context', {})
    expect(answer.isError).toBe(true); expect(answer.content[0]!.text).toContain('already ended')
  })
})

describe('card title', () => {
  it('derives a short title from the first request', () => {
    expect(titleFromPrompt('quero criar um guia de instalação do agente. Mostrar passo a passo')).toBe('Quero criar um guia de instalação do agente')
    expect(titleFromPrompt('## Planeje **isto**\n\n```js\ncodigo\n```')).toBe('Planeje isto')
    expect(titleFromPrompt('a'.repeat(30) + ' ' + 'b'.repeat(30) + ' ' + 'c'.repeat(30)).endsWith('…')).toBe(true)
    expect(titleFromPrompt('   ')).toBe('')
  })

  it('names an untitled card after the first planning turn when the agent did not, and leaves named cards alone', async () => {
    const { board, bridge, card, project, columns } = await setup()
    const writeback = new AgentWriteback(board, bridge)
    const blank = board.create({ projectId: project.id, columnId: columns[0]!.id, title: '', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    writeback.begin('run-t', blank.id, () => undefined)
    const events: string[] = []
    writeback.finish({ runId: 'run-t', cardId: blank.id, planning: true, completed: true, text: 'ok', prompt: 'Quero planejar o painel de uso. Com Codex e Claude', publish: (type) => events.push(type) })
    expect(board.card(blank.id).title).toBe('Quero planejar o painel de uso'); expect(events).toContain('gearmod/card-updated')
    writeback.begin('run-n', card.id, () => undefined)
    writeback.finish({ runId: 'run-n', cardId: card.id, planning: true, completed: true, text: 'ok', prompt: 'Outro pedido qualquer', publish: () => undefined })
    expect(board.card(card.id).title).toBe('MCP')
  })
})

describe('Plano B and writeback', () => {
  it('extracts documents between markers', () => {
    const text = 'Pronto.\n<!-- gearmod:documento tipo=especificacao -->\n## Especificação\nTexto\n<!-- /gearmod:documento -->\n<!-- gearmod:documento tipo=invalido -->x<!-- /gearmod:documento -->'
    expect(extractDocuments(text)).toEqual([{ kind: 'especificacao', markdown: '## Especificação\nTexto' }])
  })

  it('applies marker documents, reports invalid Tasks and applies the deferred move after the run', async () => {
    const { board, bridge, card, columns } = await setup()
    const writeback = new AgentWriteback(board, bridge), events: string[] = []
    const endpoint = writeback.begin('run-3', card.id, (type) => events.push(type))
    const client = mcpClient(endpoint)
    await client.call('gearmod_move_card', { coluna: 'To do', quando: 'ao_terminar' })
    const outcome = writeback.finish({ runId: 'run-3', cardId: card.id, planning: true, completed: true, publish: (type) => events.push(type), text: '<!-- gearmod:documento tipo=plano -->\n## Plano\nFazer\n<!-- /gearmod:documento -->\n<!-- gearmod:documento tipo=tasks -->\nsem itens\n<!-- /gearmod:documento -->' })
    expect(board.documents.read(card.id, 'plano')).toBe('## Plano\nFazer')
    expect(outcome.wroteDocuments).toBe(true); expect(outcome.notices[0]).toContain('tasks não foi gravado')
    expect(board.card(card.id).columnId).toBe(columns[0]!.id)
    expect(events).toContain('gearmod/card-updated')
    const another = writeback.begin('run-4', card.id, () => undefined)
    expect(another.env.GEARMOD_TOKEN).not.toBe(endpoint.env.GEARMOD_TOKEN)
    expect(board.card(card.id).hasPlan).toBe(false)
    expect((await mcpClient(another).call('gearmod_finish_planning', {})).isError).toBe(true)
  })
})

describe('collaboration tools', () => {
  it('lets the developer ask and propose, the planner answer and escalate, and refuses the wrong role', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-mcp-collab-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
    const projects = new ProjectRepository(database, git), board = new BoardRepository(database, projects), conversations = new ConversationRepository(database)
    const profile = profiles.list()[0]!
    const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev', profileIds: [profile.id] })
    const card = board.create({ projectId: project.id, columnId: board.get(project.id).columns[1]!.id, title: 'C', description: '', type: 'task', priority: 'low', acceptanceCriteria: [] })
    const dev = conversations.createChat({ projectId: project.id, cardId: card.id, purpose: 'execution', profileId: profile.id })
    const planning = conversations.createChat({ projectId: project.id, cardId: card.id, purpose: 'planning', profileId: profile.id })
    const started: FollowUp[] = []
    const collab = new CollaborationService(database, board, conversations, new AgentConfigRepository(database, board, profiles)); collab.setStarter((action) => { started.push(action) })
    const bridge = new McpBridge({ board, context: new AgentContextService(board, new SettingsRepository(database), null), serverScript, runtime: process.execPath, collab }); await bridge.listen()
    closers.push(async () => { await bridge.close(); database.close() })
    const developer = mcpClient(bridge.register('r-dev', card.id, () => undefined, { id: dev.id, purpose: 'execution' }))
    expect((await developer.call('gearmod_ask_planner', { pergunta: 'Qual lib de datas?' })).content[0]!.text).toContain('D001')
    expect((await developer.call('gearmod_propose_change', { titulo: 'Cache', o_que_muda: 'Adicionar cache', motivo: 'Lento' })).content[0]!.text).toContain('M001')
    expect((await developer.call('gearmod_propose_change', { titulo: 'só título' })).isError).toBe(true)
    expect((await developer.call('gearmod_answer_question', { numero: 1, resposta: 'x' })).isError).toBe(true)
    expect((await developer.call('gearmod_write_document', { tipo: 'duvidas', markdown: 'x' })).isError).toBe(true)
    expect(board.card(card.id).pending).toEqual({ changes: 1, questions: 0, commits: 0, toSend: 0, testFailures: 0 })
    collab.afterRun({ cardId: card.id, chatId: dev.id, purpose: 'execution', status: 'completed' })
    const planner = mcpClient(bridge.register('r-plan', card.id, () => undefined, { id: planning.id, purpose: 'planning' }))
    expect((await planner.call('gearmod_ask_planner', { pergunta: 'eu?' })).isError).toBe(true)
    expect((await planner.call('gearmod_propose_change', { titulo: 'a', o_que_muda: 'b', motivo: 'c' })).isError).toBe(true)
    expect((await planner.call('gearmod_answer_question', { numero: 1, resposta: 'Use date-fns.' })).isError).toBe(false)
    expect((await planner.call('gearmod_ask_user', { numero: 1, pergunta: 'x' })).isError).toBe(true)
    collab.afterRun({ cardId: card.id, chatId: planning.id, purpose: 'planning', status: 'completed' })
    expect(started.map((action) => action.chatId)).toEqual([planning.id, dev.id]); expect(started[1]!.prompt).toContain('Use date-fns.')
  })

  it('agent commit: only implementation asks, the rule stays with the GitManager and the card is notified', async () => {
    const { board, card, project, database, projects } = await setup()
    const conversations = new ConversationRepository(database), profiles = new ProfileRepository(database, tmpdir()); seedProfiles(profiles)
    const profile = profiles.list()[0]!.id
    projects.setProfiles(project.id, [profile])
    const dev = conversations.createChat({ projectId: project.id, cardId: card.id, purpose: 'execution', profileId: profile }), plan = conversations.createChat({ projectId: project.id, cardId: card.id, purpose: 'planning', profileId: profile })
    const asked: Array<Record<string, unknown>> = [], changes: CardChange[] = []
    const bridge = new McpBridge({ board, context: new AgentContextService(board, new SettingsRepository(database), null), serverScript, runtime: process.execPath, git: { agentCommit: async (input) => { asked.push(input); if (input.message === 'recusa') throw new Error('Commit do agente desligado na branch main'); return { rule: 'ask', text: 'Pedido de commit registrado.' } } } }); await bridge.listen()
    closers.push(async () => { await bridge.close() })
    const developer = mcpClient(bridge.register('r-dev', card.id, (change) => changes.push(change), { id: dev.id, purpose: 'execution' }))
    const ok = await developer.call('gearmod_request_commit', { mensagem: 'Cria a tela', arquivos: ['a.txt'], repositorio: 'repo' })
    expect(ok).toMatchObject({ isError: false }); expect(ok.content[0]!.text).toContain('Pedido de commit registrado')
    expect(asked).toEqual([{ cardId: card.id, chatId: dev.id, message: 'Cria a tela', files: ['a.txt'], repo: 'repo' }]); expect(changes).toEqual([{ type: 'commit' }])
    expect((await developer.call('gearmod_request_commit', { mensagem: 'recusa' }))).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('desligado') }] })
    expect((await developer.call('gearmod_request_commit', {})).isError).toBe(true)
    expect((await developer.call('gearmod_request_commit', { mensagem: 'x', arquivos: 'a.txt' })).isError).toBe(true)
    const planner = mcpClient(bridge.register('r-plan', card.id, () => undefined, { id: plan.id, purpose: 'planning' }))
    expect((await planner.call('gearmod_request_commit', { mensagem: 'x' })).content[0]!.text).toContain('developer')
    expect(asked).toHaveLength(2)
  })
})
