import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cardHistorySchema, complexityLevel, defaultComplexityLimits, defaultComplexityWeights, defaultWorkflowConfig, recommendedWorkflow, weightedTotal, type DimensionScores } from '@gearmod/contracts'
import { AgentContextService } from './agent-context'
import { AppDatabase } from './database'
import { CardHistoryService, readArtifactHistory, readHead, redact } from './history'
import { McpBridge } from './mcp-bridge'
import { BoardRepository, ProjectRepository } from './projects'
import { SettingsRepository } from './settings'
import { exportPlanArtifacts } from './workflows'
import { ApprovalService } from './approvals'
import { PolicyEngine } from './policy'

const roots: string[] = []
const closers: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of closers.splice(0)) await close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const low: DimensionScores = { escopo: 1, acoplamento: 0, incerteza: 1, risco: 0, novidade: 0, validacao: 1 }
const high: DimensionScores = { escopo: 3, acoplamento: 2, incerteza: 2, risco: 2, novidade: 1, validacao: 2 }

/** Fake Git repository with only the files that `readHead` reads (HEAD and the branch ref). */
function fakeRepo(path: string, hash: string): void {
  mkdirSync(join(path, '.git', 'refs', 'heads'), { recursive: true })
  writeFileSync(join(path, '.git', 'HEAD'), 'ref: refs/heads/main\n'); writeFileSync(join(path, '.git', 'refs', 'heads', 'main'), `${hash}\n`)
}

async function setup(repos: string[] = ['frontend']) {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-history-')); roots.push(root)
  for (const [index, name] of repos.entries()) fakeRepo(join(root, name), String(index + 1).repeat(40))
  const git = { validate: async () => undefined, branches: async () => ['main'], inspect: async (localPath: string) => ({ localPath, name: 'workspace', repositories: repos.map((name) => ({ localPath: join(root, name), name, currentBranch: 'main', branches: ['main'] })) }) }
  const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open(); closers.push(() => database.close())
  const projects = new ProjectRepository(database, git), board = new BoardRepository(database, projects)
  const project = await projects.create({ name: 'Workspace', localPath: root, baseBranch: 'main' })
  const card = board.create({ projectId: project.id, columnId: board.get(project.id).columns[1]!.id, title: 'Notificações push', description: '', type: 'feature', priority: 'medium', acceptanceCriteria: [] })
  const history = new CardHistoryService(database, join(root, 'data'))
  return { root, database, projects, board, project, card, history }
}

const assess = (history: CardHistoryService, cardId: string, scores: DimensionScores, extra: Partial<Parameters<CardHistoryService['assess']>[0]> = {}) =>
  history.assess({ cardId, scores, justifications: { escopo: 'Só o app' }, confidence: 'medium', preliminary: false, criticalRisks: [], evidence: [{ kind: 'file', ref: 'src/push.ts', detail: '', line: 3, commit: null }], trigger: 'initial', reason: 'Discovery', source: { actor: 'agent' }, ...extra })

describe('Complexity Engine', () => {
  it('sums scores × weights, classifies by the thresholds and never leaves maximum risk in the short flow', () => {
    expect(weightedTotal({ escopo: 3, acoplamento: 3, incerteza: 3, risco: 3, novidade: 3, validacao: 3 }, defaultComplexityWeights)).toBe(33)
    expect(complexityLevel(7, defaultComplexityLimits)).toBe('simple')
    expect(complexityLevel(8, defaultComplexityLimits)).toBe('medium')
    expect(complexityLevel(16, defaultComplexityLimits)).toBe('medium')
    expect(complexityLevel(17, defaultComplexityLimits)).toBe('complex')
    expect(recommendedWorkflow('simple', low)).toBe('light')
    expect(recommendedWorkflow('simple', { ...low, risco: 3 })).toBe('spec')
    expect(recommendedWorkflow('complex', high)).toBe('sdd')
  })

  it('keeps the limits each assessment was scored with, even after the project limits change', async () => {
    const { history, card, project } = await setup()
    const first = assess(history, card.id, high).assessment
    expect(first.limits).toEqual(defaultComplexityLimits)
    history.setConfig(project.id, { ...defaultWorkflowConfig, limits: { simpleMax: 9, mediumMax: 30 } })
    const saved = history.history(card.id).assessments[0]!
    expect(saved.limits).toEqual(defaultComplexityLimits)
    expect(saved.level).toBe(first.level)
  })

  it('versions evaluations without overwriting, refuses repetition and stores a user correction as a new version', async () => {
    const { history, card, board } = await setup()
    const first = assess(history, card.id, low, { preliminary: true, confidence: 'low' }).assessment
    expect(first).toMatchObject({ version: 1, total: 5, level: 'simple', workflow: 'light', preliminary: true, trigger: 'initial' })
    expect(first.codeVersion).toContain('frontend@111111111111')
    expect(first.evidence[0]!.commit).toContain('frontend@')
    expect(() => assess(history, card.id, low, { preliminary: true, confidence: 'low' })).toThrow(/já tem essas notas/)
    const second = assess(history, card.id, high, { trigger: 'new-dependency', reason: 'Backend precisa de fila' })
    expect(second.assessment).toMatchObject({ version: 2, total: 23, level: 'complex', trigger: 'new-dependency', supersedesId: first.id })
    expect(second.previous?.id).toBe(first.id)
    const contested = history.contest(card.id, { ...high, escopo: 1 }, 'O backend já tem o endpoint')
    expect(contested).toMatchObject({ version: 3, actor: 'user', trigger: 'user-correction', confidence: 'high' })
    expect(contested.justifications.escopo).toContain('Corrigido pelo usuário')
    expect(history.assessments(card.id).map((item) => item.total)).toEqual([5, 23, 19])
    expect(board.card(card.id).complexity).toMatchObject({ total: 19, level: 'complex', delta: -4, version: 3 })
    expect(history.events(card.id).map((event) => event.type)).toEqual(['assessment.created', 'assessment.revised', 'assessment.contested'])
  })

  it('preserves the full text of each critical risk', async () => {
    const { history, card } = await setup()
    const risks = ['Primeiro risco', 'Segundo risco', 'Terceiro risco']
    assess(history, card.id, low, { criticalRisks: risks })
    expect(history.latest(card.id)?.criticalRisks).toEqual(risks)
  })

  it('records the chosen flow even when different from the recommended one and replaces the previous choice', async () => {
    const { history, card } = await setup()
    assess(history, card.id, high)
    history.selectWorkflow(card.id, 'spec', { actor: 'user' }, 'Prefiro spec leve')
    history.selectWorkflow(card.id, 'sdd', { actor: 'user' })
    const decisions = history.decisions(card.id)
    expect(decisions.map((item) => [item.number, item.status, item.actor])).toEqual([[1, 'superseded', 'user'], [2, 'approved', 'user']])
    expect(history.workflow(card.id)).toBe('sdd')
    const selected = history.events(card.id).filter((event) => event.type === 'workflow.selected')
    expect(selected.map((event) => event.payload.followsRecommendation)).toEqual([false, true])
    const proposal = history.decide(card.id, { kind: 'technical', statement: 'Usar FCM', actor: 'agent' })
    expect(proposal.status).toBe('proposed')
    history.setDecision(proposal.id, 'approved')
    expect(history.decisions(card.id).find((item) => item.id === proposal.id)?.status).toBe('approved')
  })

  it('only replaces the previous decision when the new proposal is approved', async () => {
    const { history, card } = await setup()
    const old = history.decide(card.id, { kind: 'scope', statement: 'Apenas Android', actor: 'user' })
    const rejected = history.decide(card.id, { kind: 'scope', statement: 'Apenas iOS', actor: 'agent', supersedes: old.number })
    expect(history.decisions(card.id).find((item) => item.id === old.id)?.status).toBe('approved')
    history.setDecision(rejected.id, 'superseded')
    expect(history.decisions(card.id).find((item) => item.id === old.id)?.status).toBe('approved')
    const replacement = history.decide(card.id, { kind: 'scope', statement: 'Android e iOS', actor: 'agent', supersedes: old.number })
    history.setDecision(replacement.id, 'approved')
    expect(history.decisions(card.id).map((item) => item.status)).toEqual(['superseded', 'superseded', 'approved'])
    expect(readArtifactHistory(history.artifactsDir(card.id)).decisions.map((item) => item.status)).toEqual(['superseded', 'superseded', 'approved'])
  })

  it('stores the method recommendation and choice per card and recovers them from the history', async () => {
    const { history, card, project, database, board } = await setup()
    assess(history, card.id, high)
    history.setConfig(project.id, { ...defaultWorkflowConfig, complexMethod: 'speckit' })
    history.recommendSddMethod(card.id, 'speckit', 'Funcionalidade nova', { actor: 'agent' })
    expect(history.history(card.id)).toMatchObject({ recommendedSddMethod: 'speckit', sddMethod: null, sddMethodReason: 'Funcionalidade nova' })
    history.selectWorkflow(card.id, 'sdd', { actor: 'user' }, '', 'user', 'native')
    expect(history.history(card.id)).toMatchObject({ recommendedSddMethod: 'speckit', sddMethod: 'native' })
    const context = new AgentContextService(board, new SettingsRepository(database), null, undefined, undefined, history)
    expect(await context.block(card.id)).toContain('Full GearMod SDD')
    database.db.exec('DELETE FROM card_assessments; DELETE FROM card_decisions; DELETE FROM card_events;')
    history.rebuild(card.id)
    expect(history.history(card.id)).toMatchObject({ workflow: 'sdd', recommendedSddMethod: 'speckit', sddMethod: 'native' })
  })
})

describe('Versionable artifacts', () => {
  it('includes audits in the history and recovers old records that were already synced', async () => {
    const { history, card, project, database } = await setup()
    new PolicyEngine(database).decide([], 'commit', { cardId: card.id, projectId: project.id, actor: 'agent' })
    const approvals = new ApprovalService(database)
    const approval = approvals.request({ kind: 'test', subjectRef: 'test', payload: {}, requestedActor: 'agent', cardId: card.id, projectId: project.id })
    approvals.decide(approval.id, true)
    const events = history.history(card.id).events
    expect(events.map((event) => event.type)).toEqual(['policy.decided', 'approval.requested', 'approval.approved'])
    expect(events[0]).toMatchObject({ cardId: card.id, projectId: project.id, source: { actor: 'agent' }, payload: { action: 'commit', decision: 'ask' } })
    expect(cardHistorySchema.safeParse(history.history(card.id)).success).toBe(true)
    database.db.prepare('UPDATE card_events SET synced_at = ?').run(new Date().toISOString())
    history.sync(card.id)
    history.sync(card.id)
    const file = join(history.artifactsDir(card.id), 'history.jsonl')
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3)
    database.db.exec('DELETE FROM card_events')
    expect(history.rebuild(card.id).events).toBe(3)
    expect(history.events(card.id).map((event) => event.type)).toEqual(events.map((event) => event.type))
  })
  it('mirrors events to history.jsonl without duplicating and rebuilds the history from the files alone', async () => {
    const { history, card, database } = await setup()
    assess(history, card.id, low)
    history.decide(card.id, { kind: 'scope', statement: 'Só Android', actor: 'user' })
    history.recordDiscovery(card.id, { objetivo: 'Avisar o usuário de pedidos novos', motivacao: '', escopo: ['App Android'], exclusoes: ['iOS'], criterios: ['Notificação chega em 5 s'], pendencias: [], contextoTecnico: '', prontidao: 'pronto' }, { actor: 'agent' })
    const dir = history.artifactsDir(card.id), file = join(dir, 'history.jsonl')
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3)
    expect(readFileSync(join(dir, 'discovery.md'), 'utf8')).toContain('Avisar o usuário de pedidos novos')
    // App crashed after writing and before marking: the next reconciliation does not duplicate.
    database.db.prepare('UPDATE card_events SET synced_at = NULL').run()
    expect(history.reconcile()).toBe(1)
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3)
    // A truncated line at the end of the file is ignored.
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"id":"cortad`)
    const fromFiles = readArtifactHistory(dir)
    expect(fromFiles.assessments.map((item) => item.total)).toEqual([5])
    expect(fromFiles.decisions.map((item) => item.statement)).toEqual(['Só Android'])
    // Database lost the history (e.g. old backup restored): rebuild recreates everything from the file.
    database.db.exec('DELETE FROM card_assessments; DELETE FROM card_decisions; DELETE FROM card_events;')
    expect(history.rebuild(card.id)).toEqual({ events: 3, assessments: 1, decisions: 1 })
    expect(history.rebuild(card.id)).toEqual({ events: 0, assessments: 0, decisions: 0 })
    expect(history.latest(card.id)?.total).toBe(5)
    expect(history.discovery(card.id)?.exclusoes).toEqual(['iOS'])
  })

  it('rewrites to the new folder when the artifacts folder changes and does not accept a relative path', async () => {
    const { history, card, project, root } = await setup()
    assess(history, card.id, low)
    expect(() => history.setConfig(project.id, { ...defaultWorkflowConfig, artifactsDir: 'docs/cards' })).toThrow(/caminho absoluto/)
    const target = join(root, 'docs-repo', 'gearmod')
    history.setConfig(project.id, { ...defaultWorkflowConfig, artifactsDir: target })
    expect(history.artifactsDir(card.id).startsWith(target)).toBe(true)
    expect(readFileSync(join(history.artifactsDir(card.id), 'history.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('G01: normalizes old configs (sddPath, customManifest, legacy complexMethod) on read, without error; writes only the new format', async () => {
    const { history, project, database } = await setup()
    const setRaw = (raw: Record<string, unknown>): void => { database.db.prepare('UPDATE projects SET workflow_config = ? WHERE id = ?').run(JSON.stringify(raw), project.id) }
    const fixtures: Array<{ name: string; raw: Record<string, unknown>; expectMethod: 'native' | 'speckit'; expectLegacy: string | null }> = [
      { name: 'vazio (projeto novo)', raw: {}, expectMethod: 'native', expectLegacy: null },
      { name: 'nativo sem sdd', raw: { complexMethod: 'native' }, expectMethod: 'native', expectLegacy: null },
      { name: 'speckit com sddPath', raw: { complexMethod: 'speckit', sddPath: '/abs/path/.specify/memory/constitution.md' }, expectMethod: 'speckit', expectLegacy: null },
      { name: 'openspec legado (sem sdd)', raw: { complexMethod: 'openspec' }, expectMethod: 'native', expectLegacy: 'openspec' },
      { name: 'custom legado com customManifest', raw: { complexMethod: 'custom', customManifest: '/abs/manifest.json' }, expectMethod: 'native', expectLegacy: 'custom' },
      { name: 'já no formato novo (idempotente)', raw: { sdd: { method: 'speckit', sourceId: null, root: 'docs', constitution: { native: 'a.md', speckit: 'b.md' }, featuresDir: 'specs' } }, expectMethod: 'speckit', expectLegacy: null }
    ]
    for (const fixture of fixtures) {
      setRaw(fixture.raw)
      const config = history.config(project.id)
      expect(config.sdd.method, fixture.name).toBe(fixture.expectMethod)
      expect(config.legacyMethod, fixture.name).toBe(fixture.expectLegacy)
    }
    // Write: always writes `sdd`, never the legacy complexMethod (today's UI only offers native/speckit).
    const saved = history.setConfig(project.id, { ...defaultWorkflowConfig, sdd: { ...defaultWorkflowConfig.sdd, method: 'speckit' } })
    expect(saved.sdd.method).toBe('speckit')
    const storedRaw = JSON.parse(database.db.prepare('SELECT workflow_config FROM projects WHERE id = ?').pluck().get(project.id) as string)
    expect(storedRaw.sdd.method).toBe('speckit'); expect(storedRaw.legacyMethod).toBeNull()
  })

  it('marks the exploration as outdated when a repository HEAD changes', async () => {
    const { history, card, root } = await setup(['frontend', 'backend'])
    history.recordExploration(card.id, { summary: 'Push fica em src/push', modules: ['push'], repositories: ['frontend'], evidence: [] }, { actor: 'agent' })
    expect(history.exploration(card.id)).toMatchObject({ stale: false, codeVersions: { frontend: '1'.repeat(40), backend: '2'.repeat(40) } })
    writeFileSync(join(root, 'backend', '.git', 'refs', 'heads', 'main'), `${'9'.repeat(40)}\n`)
    expect(history.exploration(card.id)?.stale).toBe(true)
    expect(readHead(join(root, 'nada'))).toBeNull()
  })

  it('strips secrets from what goes into the files', async () => {
    expect(redact('chave sk-abcdefghijklmnop e ghp_abcdefghijklmnopqrstuvwxyz')).toBe('chave [redacted] e [redacted]')
    const { history, card } = await setup()
    history.decide(card.id, { kind: 'other', statement: 'Usar o token sk-1234567890abcdef', actor: 'user' })
    expect(readFileSync(join(history.artifactsDir(card.id), 'history.jsonl'), 'utf8')).not.toContain('sk-1234567890abcdef')
  })
})

describe('central SDD (scenarios E, F and G)', () => {
  it('detects Spec Kit without generating parallel copies of the card documents', async () => {
    const { history, board, card, project, root } = await setup(['docs', 'frontend', 'backend'])
    mkdirSync(join(root, 'docs', '.specify', 'templates'), { recursive: true }); mkdirSync(join(root, 'docs', '.claude', 'commands'), { recursive: true })
    writeFileSync(join(root, 'docs', '.claude', 'commands', 'speckit.specify.md'), '# specify')
    const detected = history.detect(project.id)
    expect(detected).toEqual([{ method: 'speckit', path: join(root, 'docs'), repository: 'docs', commands: ['.claude/commands/speckit.specify.md'] }])
    history.setConfig(project.id, { ...defaultWorkflowConfig, complexMethod: 'speckit' })
    for (const [kind, text] of [['especificacao', '# Spec'], ['plano', '# Plano'], ['tasks', '- [ ] T001 Fazer']] as const) board.documents.write(card.id, kind, text, 'agent')
    history.selectWorkflow(card.id, 'sdd', { actor: 'user' }, '', 'user', 'speckit')
    const result = exportPlanArtifacts(history, board, card.id)
    const specDir = join(root, 'docs', 'specs', `${card.id.slice(0, 8)}-notificacoes-push`)
    expect(result.notices[0]).toContain('nenhum artefato paralelo')
    expect(existsSync(specDir)).toBe(false)
    expect(existsSync(join(root, 'frontend', 'specs'))).toBe(false)
    expect(existsSync(join(root, 'frontend', '.specify'))).toBe(false)
    expect(existsSync(join(history.artifactsDir(card.id), 'plan.md'))).toBe(false)
  })

  it('without SDD, the short flow produces only the minimal artifacts in the managed folder', async () => {
    const { history, board, card } = await setup()
    assess(history, card.id, low)
    history.selectWorkflow(card.id, 'light', { actor: 'user' })
    const result = exportPlanArtifacts(history, board, card.id)
    expect(result.written.filter((path) => path.includes(join('specs')))).toEqual([])
    expect(existsSync(join(history.artifactsDir(card.id), 'discovery.md'))).toBe(true)
  })
})

describe('MCP tools and context', () => {
  it('the agent evaluates, picks the confirmed flow and the next turn context carries the summary', async () => {
    const { history, board, card, database } = await setup()
    const context = new AgentContextService(board, new SettingsRepository(database), null, undefined, undefined, history)
    const approvals = new ApprovalService(database)
    const bridge = new McpBridge({ board, context, serverScript: 'unused', history, approvals })
    const changes: string[] = []
    const token = bridge.register('00000000-0000-4000-8000-000000000001', card.id, (change) => changes.push(change.type), { id: '00000000-0000-4000-8000-000000000002', purpose: 'planning' }).env.GEARMOD_TOKEN!
    const call = (tool: string, args: Record<string, unknown>) => (bridge as unknown as { handle(token: string, tool: string, args: Record<string, unknown>): { ok: boolean; text?: string; error?: string } }).handle(token, tool, args)
    expect(call('gearmod_assess_complexity', { notas: { escopo: 4 }, confianca: 'alta', motivo: 'x' })).toMatchObject({ ok: false })
    // With open questions the full assessment waits for the answers; a preliminary one still goes through.
    const understanding = { objetivo: 'Avisar pedidos novos', pendencias: ['Vale para iOS?'] }
    expect(call('gearmod_record_understanding', { ...understanding, prontidao: 'precisa_esclarecer' })).toMatchObject({ ok: true })
    const notes = { escopo: 1, acoplamento: 0, incerteza: 2, risco: 0, novidade: 0, validacao: 1 }
    const blocked = call('gearmod_assess_complexity', { notas: notes, confianca: 'media', motivo: 'Discovery inicial' })
    expect(blocked).toMatchObject({ ok: false }); expect(blocked.error).toContain('Vale para iOS?')
    expect(call('gearmod_assess_complexity', { notas: notes, confianca: 'baixa', preliminar: true, motivo: 'Usuário pediu estimativa já' })).toMatchObject({ ok: true })
    expect(call('gearmod_record_understanding', { ...understanding, pendencias: [], prontidao: 'pronto' })).toMatchObject({ ok: true })
    const first = call('gearmod_assess_complexity', { notas: { escopo: 1, acoplamento: 0, incerteza: 1, risco: 0, novidade: 0, validacao: 1 }, justificativas: { escopo: 'Um componente' }, confianca: 'media', motivo: 'Discovery inicial', evidencias: [{ tipo: 'file', referencia: 'src/App.tsx', linha: 10 }] })
    expect(first).toMatchObject({ ok: true }); expect(first.text).toContain('5 points')
    expect(call('gearmod_choose_workflow', { fluxo: 'light', confirmado_pelo_usuario: false })).toMatchObject({ ok: true })
    const proposed = approvals.list(card.id)[0]!
    expect(proposed.status).toBe('requested')
    approvals.decide(proposed.id, true)
    history.selectWorkflow(card.id, 'light', { actor: 'user' }, '', 'user')
    // The short flow does not change the card type: it comes from the chosen workflow.
    expect(board.card(card.id)).toMatchObject({ type: card.type, workflow: 'light', sddMethod: null })
    expect(call('gearmod_assess_complexity', { notas: { escopo: 2, acoplamento: 2, incerteza: 1, risco: 1, novidade: 0, validacao: 1 }, confianca: 'alta', gatilho: 'user-correction', motivo: 'x' })).toMatchObject({ ok: false })
    expect(call('gearmod_assess_complexity', { notas: { escopo: 2, acoplamento: 2, incerteza: 1, risco: 1, novidade: 0, validacao: 1 }, confianca: 'alta', gatilho: 'new-dependency', motivo: 'Descobri que o backend também muda' }).text).toContain('before 5; +9')
    const currentDecisions = history.decisions(card.id).filter((item) => item.status !== 'superseded').map((item) => item.number)
    expect(call('gearmod_record_decision', { decisao: 'Usar FCM', origem: 'agente', tipo: 'technical' })).toMatchObject({ ok: false })
    expect(call('gearmod_record_decision', { decisao: 'Usar FCM', origem: 'agente', tipo: 'technical', decisoes_revisadas: currentDecisions })).toMatchObject({ ok: true })
    expect(call('gearmod_choose_workflow', { fluxo: 'sdd', confirmado_pelo_usuario: false })).toMatchObject({ ok: false })
    expect(call('gearmod_choose_workflow', { fluxo: 'sdd', metodo: 'speckit', motivo: 'Funcionalidade nova', confirmado_pelo_usuario: false })).toMatchObject({ ok: true })
    expect(history.history(card.id)).toMatchObject({ recommendedSddMethod: 'speckit', sddMethod: null })
    expect(changes.filter((type) => type === 'card').length).toBeGreaterThanOrEqual(4)
    const block = await context.block(card.id)
    expect(block).toContain('Complexity v3: 14 points, média')
    expect(block).toContain('chosen workflow: light')
    expect(block).toContain('[agent recommendation, not approved] Usar FCM')
  })
})
