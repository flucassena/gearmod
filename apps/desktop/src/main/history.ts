import { randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import {
  assessmentSchema, complexityDimensions, complexityLevel, decisionSchema, defaultWorkflowConfig, dimensionLabels, discoveryBriefSchema, evidenceSchema, historyEventSchema,
  levelLabels, normalizeLegacySdd, recommendedWorkflow, triggerLabels, weightedTotal, workflowConfigSchema, workflowLabels,
  type Assessment, type AssessmentTrigger, type CardComplexity, type CardHistory, type Confidence, type Decision, type DecisionKind, type DimensionScores, type DiscoveryBrief,
  type Evidence, type Exploration, type HistoryEvent, type HistoryEventType, type SddDetection, type WorkflowConfig, type WorkflowKind
} from '@gearmod/contracts'
import type { AppDatabase } from './database'
import { redact, redactObject } from './redaction'
import { tm } from './i18n'

/** Source of who recorded: agent (with the run) or user. */
export interface HistorySource { actor: 'agent' | 'user' | 'system'; runId?: string | null; chatId?: string | null }
export interface AssessInput {
  cardId: string; scores: DimensionScores; justifications: Record<string, string>; confidence: Confidence; preliminary: boolean; criticalRisks: string[]
  evidence: Evidence[]; trigger: AssessmentTrigger; reason: string; source: HistorySource
}
type RunInfo = { profileId: string | null; provider: string | null; model: string | null; effort: string | null }
type EventRow = { id: string; cardId: string; projectId: string; type: string; version: number; actor: string; at: string; json: string }
const eventColumns = 'id, card_id AS cardId, project_id AS projectId, type, schema_version AS version, actor, created_at AS at, json'
const auditEventTypes = new Set(['policy.decided', 'approval.requested', 'approval.approved', 'approval.denied', 'approval.consumed'])

/** Old audits keep only the payload as json; the other fields are in the row's columns. */
function eventFromRow(row: EventRow): HistoryEvent {
  const data: unknown = JSON.parse(row.json)
  const full = historyEventSchema.safeParse(data)
  if (full.success) return full.data
  if (auditEventTypes.has(row.type)) return historyEventSchema.parse({ id: row.id, v: row.version, type: row.type, at: row.at, cardId: row.cardId, projectId: row.projectId, source: { actor: row.actor }, refs: [], payload: data })
  return historyEventSchema.parse(data)
}

/**
 * Decision & Evidence Registry + Complexity Engine (docs/09). SQLite holds the state for fast queries; each event also goes
 * to `history.jsonl` in the card's artifacts folder, from which the history can be rebuilt without the database. Nothing is overwritten:
 * new evaluations become versions, replaced decisions stay `superseded`.
 */
export class CardHistoryService {
  constructor(private readonly database: AppDatabase, private readonly dataDir: string) {}

  private get db(): Database.Database { return this.database.db }

  // ---- Project workflow configuration -------------------------------------------------------------------------------

  config(projectId: string): WorkflowConfig {
    const raw = this.db.prepare('SELECT workflow_config FROM projects WHERE id = ?').pluck().get(projectId) as string | null | undefined
    if (raw === undefined) throw new Error(tm().common.projectNotFound)
    if (!raw) return defaultWorkflowConfig
    // G01: configs from before `sdd` (legacy sddPath/customManifest/complexMethod) are normalized on read, without error.
    const parsed = workflowConfigSchema.safeParse({ ...defaultWorkflowConfig, ...normalizeLegacySdd(JSON.parse(raw) as Record<string, unknown>) })
    return parsed.success ? parsed.data : defaultWorkflowConfig
  }

  setConfig(projectId: string, input: WorkflowConfig): WorkflowConfig {
    const config = workflowConfigSchema.parse(input)
    for (const path of [config.sddPath, config.artifactsDir, config.customManifest]) if (path && !isAbsolute(path)) throw new Error(tm().history.useAbsolutePath(path))
    if (config.sddPath && !existsSync(config.sddPath)) throw new Error(tm().history.sddFolderNotFound(config.sddPath))
    if (config.complexMethod === 'custom') readManifest(config.customManifest)
    const before = this.config(projectId)
    this.db.prepare('UPDATE projects SET workflow_config = ? WHERE id = ?').run(JSON.stringify(config), projectId)
    // Artifacts folder changed: events are written again to the new folder (the write dedups by id).
    if ((before.artifactsDir ?? null) !== (config.artifactsDir ?? null)) {
      this.db.prepare('UPDATE card_events SET synced_at = NULL WHERE project_id = ?').run(projectId)
      for (const cardId of this.db.prepare('SELECT DISTINCT card_id FROM card_events WHERE project_id = ?').pluck().all(projectId) as string[]) this.sync(cardId)
    }
    return config
  }

  defaultArtifactsRoot(projectId: string): string { return join(this.dataDir, 'artifacts', projectId) }

  /**
   * Card artifacts folder. If the configured artifacts folder is inside a project repository and the card already has a worktree
   * of that repository, the folder is the worktree's (files go into the card's commit); otherwise, the usual configured folder.
   */
  artifactsDir(cardId: string): string {
    const projectId = this.projectOf(cardId), root = this.config(projectId).artifactsDir ?? this.defaultArtifactsRoot(projectId)
    return this.cardFolder(this.worktreeBase(cardId, root) ?? root, cardId)
  }

  /** Same folder, but in the previous place (outside the worktree), to bring over what was already written there. */
  private previousDir(cardId: string): string | null {
    const projectId = this.projectOf(cardId), root = this.config(projectId).artifactsDir ?? this.defaultArtifactsRoot(projectId), found = this.existingFolder(root, cardId)
    return found ? join(root, found) : null
  }

  private worktreeBase(cardId: string, root: string): string | null {
    const same = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const members = this.db.prepare(`SELECT wm.repo_path AS repoPath, wm.path AS path FROM worktree_members wm JOIN worktrees w ON w.id = wm.worktree_id WHERE w.card_id = ? AND wm.status = 'active'`).all(cardId) as Array<{ repoPath: string; path: string }>
    const target = same(root)
    for (const member of members) {
      const repo = same(member.repoPath)
      if ((target === repo || target.startsWith(`${repo}/`)) && existsSync(member.path)) return join(member.path, root.replace(/\\/g, '/').slice(repo.length).replace(/^\/+/, ''))
    }
    return null
  }

  private existingFolder(base: string, cardId: string): string | null {
    const short = cardId.slice(0, 8)
    try { return existsSync(base) ? readdirSync(base).find((name) => name === `card-${short}` || name.endsWith(`-${short}`)) ?? null : null } catch { return null }
  }

  /** Clear name: the card title in lowercase with hyphens and the short code (`login-page-redesign-2e84d10e`); an existing folder keeps its name. */
  private cardFolder(base: string, cardId: string): string {
    const existing = this.existingFolder(base, cardId)
    if (existing) return join(base, existing)
    const title = (this.db.prepare('SELECT title FROM cards WHERE id = ?').pluck().get(cardId) as string | undefined) ?? ''
    const slug = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 44).replace(/-$/, '')
    return join(base, `${slug || 'card'}-${cardId.slice(0, 8)}`)
  }

  /** First write in the new place (worktree): brings what already existed in the old folder, overwriting nothing. */
  private adopt(cardId: string, dir: string): void {
    if (existsSync(join(dir, 'history.jsonl'))) return
    const old = this.previousDir(cardId)
    if (!old || resolve(old) === resolve(dir) || !existsSync(old)) return
    try { cpSync(old, dir, { recursive: true, force: false, errorOnExist: false }) } catch { /* best effort: what is missing is rewritten by the sync */ }
  }

  /** Spec Kit (`.specify/`) and OpenSpec (`openspec/`) already installed in the project folder or its repositories. Nothing is installed here. */
  detect(projectId: string): SddDetection[] {
    const project = this.db.prepare('SELECT local_path FROM projects WHERE id = ?').pluck().get(projectId) as string | undefined
    if (!project) throw new Error(tm().common.projectNotFound)
    const sources = this.db.prepare('SELECT name, local_path AS path FROM project_sources WHERE project_id = ? ORDER BY sort_order').all(projectId) as Array<{ name: string; path: string }>
    const roots = new Map<string, string | null>([[resolve(project), null]])
    for (const source of sources) roots.set(resolve(source.path), source.name)
    const found: SddDetection[] = []
    for (const [root, repository] of roots) {
      if (isDir(join(root, '.specify'))) found.push({ method: 'speckit', path: root, repository, commands: commandsIn(root, /^speckit/i) })
      if (isDir(join(root, 'openspec'))) found.push({ method: 'openspec', path: root, repository, commands: commandsIn(root, /^openspec/i) })
    }
    return found
  }

  // ---- Evaluations ------------------------------------------------------------------------------------------------------

  assess(input: AssessInput): { assessment: Assessment; previous: Assessment | null } {
    const projectId = this.projectOf(input.cardId), config = this.config(projectId), previous = this.latest(input.cardId)
    const scores = input.scores, total = weightedTotal(scores, config.weights), level = complexityLevel(total, config.limits)
    // Same scores, same confidence and same preliminary state do not become a new version: only justified changes enter the history.
    if (previous && input.source.actor === 'agent' && sameScores(previous.scores, scores) && previous.confidence === input.confidence && previous.preliminary === input.preliminary) {
      throw new Error(`A avaliação atual (v${previous.version}, ${previous.total} pontos) já tem essas notas. Só reavalie quando algo mudar de verdade.`)
    }
    const run = this.runInfo(input.source.runId)
    const assessment = assessmentSchema.parse({
      id: randomUUID(), cardId: input.cardId, version: (previous?.version ?? 0) + 1, preliminary: input.preliminary, scores, weights: config.weights, limits: { simpleMax: config.limits.simpleMax, mediumMax: config.limits.mediumMax }, total, level,
      confidence: input.confidence, criticalRisks: input.criticalRisks.map((risk) => redact(risk)), justifications: Object.fromEntries(Object.entries(input.justifications).map(([key, value]) => [key, redact(value)])),
      evidence: input.evidence.map((item) => ({ ...item, detail: redact(item.detail), commit: item.commit ?? this.codeVersion(projectId) })), workflow: recommendedWorkflow(level, scores),
      trigger: previous ? input.trigger : 'initial', reason: redact(input.reason), actor: input.source.actor === 'user' ? 'user' : 'agent', ...run, codeVersion: this.codeVersion(projectId),
      supersedesId: previous?.id ?? null, createdAt: new Date().toISOString()
    })
    const type: HistoryEventType = assessment.actor === 'user' ? 'assessment.contested' : previous ? 'assessment.revised' : 'assessment.created'
    this.db.transaction(() => {
      this.insertAssessment(assessment)
      this.insertEvent(this.event(input.cardId, type, input.source, { assessment, previousVersion: previous?.version ?? null, previousTotal: previous?.total ?? null }, assessment.evidence.map((item) => item.ref)))
    })()
    this.sync(input.cardId)
    return { assessment, previous }
  }

  /** User correction: becomes a new version (the agent's stays in the history) and records the reason as evidence. */
  contest(cardId: string, scores: DimensionScores, reason: string): Assessment {
    const previous = this.latest(cardId)
    const changed = complexityDimensions.filter((dimension) => !previous || previous.scores[dimension] !== scores[dimension])
    if (previous && !changed.length) throw new Error('As notas são as mesmas da avaliação atual.')
    const justifications = Object.fromEntries(changed.map((dimension) => [dimension, `Corrigido pelo usuário: ${reason}`]))
    return this.assess({ cardId, scores, justifications: { ...previous?.justifications, ...justifications }, confidence: 'high', preliminary: false, criticalRisks: previous?.criticalRisks ?? [], evidence: [{ kind: 'message', ref: 'usuário', detail: reason, line: null, commit: null }], trigger: 'user-correction', reason, source: { actor: 'user' } }).assessment
  }

  latest(cardId: string): Assessment | null { return this.assessments(cardId).at(-1) ?? null }

  assessments(cardId: string): Assessment[] {
    return (this.db.prepare('SELECT * FROM card_assessments WHERE card_id = ? ORDER BY version').all(cardId) as AssessmentRow[]).map(fromAssessmentRow)
  }

  // ---- Decisions and flow -----------------------------------------------------------------------------------------------

  decide(cardId: string, input: { kind: DecisionKind; statement: string; rationale?: string; actor: 'agent' | 'user'; status?: 'proposed' | 'approved'; supersedes?: number | string | null; source?: HistorySource }): Decision {
    const old = input.supersedes == null ? null : this.decisions(cardId).find((item) => item.id === input.supersedes || item.number === input.supersedes)
    if (input.supersedes != null && !old) throw new Error(`Decisão não encontrada: ${String(input.supersedes)}`)
    if (old?.status === 'superseded') throw new Error('A decisão indicada já foi substituída')
    const number = ((this.db.prepare('SELECT MAX(number) FROM card_decisions WHERE card_id = ?').pluck().get(cardId) as number | null) ?? 0) + 1
    const decision = decisionSchema.parse({ id: randomUUID(), cardId, number, kind: input.kind, statement: redact(input.statement), rationale: redact(input.rationale ?? ''), status: input.status ?? (input.actor === 'user' ? 'approved' : 'proposed'), actor: input.actor, supersedesId: old?.id ?? null, createdAt: new Date().toISOString() })
    const source = input.source ?? { actor: input.actor }
    this.db.transaction(() => {
      this.insertDecision(decision)
      if (old && decision.status === 'approved') { this.db.prepare("UPDATE card_decisions SET status = 'superseded' WHERE id = ?").run(old.id); this.insertEvent(this.event(cardId, 'decision.superseded', source, { decisionId: old.id, number: old.number, by: decision.id })) }
      this.insertEvent(this.event(cardId, decision.status === 'approved' ? 'user.decision' : 'agent.decision', source, { decision }))
    })()
    this.sync(cardId)
    return decision
  }

  /** The user approves an agent recommendation or marks it as superseded. */
  setDecision(decisionId: string, status: 'approved' | 'superseded'): string {
    const row = this.db.prepare('SELECT * FROM card_decisions WHERE id = ?').get(decisionId) as DecisionRow | undefined
    if (!row) throw new Error(tm().common.decisionNotFound)
    this.db.transaction(() => {
      if (status === 'approved' && row.supersedes_id) {
        const old = this.db.prepare('SELECT * FROM card_decisions WHERE id = ? AND card_id = ?').get(row.supersedes_id, row.card_id) as DecisionRow | undefined
        if (!old || old.status === 'superseded') throw new Error(tm().history.supersededNotCurrent)
        this.db.prepare("UPDATE card_decisions SET status = 'superseded' WHERE id = ?").run(old.id)
        this.insertEvent(this.event(row.card_id, 'decision.superseded', { actor: 'user' }, { decisionId: old.id, number: old.number, by: decisionId }))
      }
      this.db.prepare('UPDATE card_decisions SET status = ? WHERE id = ?').run(status, decisionId)
      this.insertEvent(this.event(row.card_id, status === 'approved' ? 'user.decision' : 'decision.superseded', { actor: 'user' }, { decisionId, number: row.number, status }))
    })()
    this.sync(row.card_id)
    return row.card_id
  }

  decisions(cardId: string): Decision[] {
    return (this.db.prepare('SELECT * FROM card_decisions WHERE card_id = ? ORDER BY number').all(cardId) as DecisionRow[]).map(fromDecisionRow)
  }

  /** Effective card flow. It is recorded even when it differs from the recommended one; the previous flow decision becomes `superseded`. */
  /** `decidedBy`: who decided (the agent may record the choice the user confirmed in the chat). */
  selectWorkflow(cardId: string, workflow: WorkflowKind, source: HistorySource, reason = '', decidedBy: 'agent' | 'user' = source.actor === 'user' ? 'user' : 'agent', method?: 'native' | 'speckit'): void {
    const recommended = this.latest(cardId)?.workflow ?? null
    const previous = this.decisions(cardId).filter((item) => item.kind === 'workflow' && item.status !== 'superseded').at(-1)
    this.db.prepare('UPDATE cards SET workflow = ? WHERE id = ?').run(workflow, cardId)
    this.insertEvent(this.event(cardId, 'workflow.selected', source, { workflow, method: workflow === 'sdd' ? method ?? null : null, recommended, followsRecommendation: recommended === workflow, reason: redact(reason) }))
    this.decide(cardId, { kind: 'workflow', statement: `Fluxo: ${workflowLabels[workflow]}${workflow === 'sdd' && method ? ` — ${method === 'native' ? 'SDD do GearMod' : 'GitHub Spec Kit'}` : ''}`, rationale: reason || (recommended && recommended !== workflow ? `Diferente do recomendado (${workflowLabels[recommended]}).` : ''), actor: decidedBy, status: decidedBy === 'user' ? 'approved' : 'proposed', supersedes: previous?.id ?? null, source })
  }

  workflow(cardId: string): WorkflowKind | null { return (this.db.prepare('SELECT workflow FROM cards WHERE id = ?').pluck().get(cardId) as WorkflowKind | null | undefined) ?? null }

  sddMethod(cardId: string): 'native' | 'speckit' | null {
    const event = this.lastEvent(cardId, 'workflow.selected'), method = event?.payload.method
    return event?.payload.workflow === 'sdd' && (method === 'native' || method === 'speckit') ? method : null
  }

  recommendSddMethod(cardId: string, method: 'native' | 'speckit', reason: string, source: HistorySource): void {
    this.insertEvent(this.event(cardId, 'workflow.method-recommended', source, { method, reason: redact(reason), assessmentId: this.latest(cardId)?.id ?? null })); this.sync(cardId)
  }

  // ---- Discovery and exploration --------------------------------------------------------------------------------------------

  recordDiscovery(cardId: string, input: DiscoveryBrief, source: HistorySource): DiscoveryBrief {
    const brief = discoveryBriefSchema.parse({ ...redactDeep(input), registradoEm: new Date().toISOString() })
    this.insertEvent(this.event(cardId, 'discovery.recorded', source, { brief })); this.sync(cardId)
    return brief
  }

  discovery(cardId: string): DiscoveryBrief | null {
    const event = this.lastEvent(cardId, 'discovery.recorded')
    return event ? discoveryBriefSchema.parse(event.payload.brief) : null
  }

  /** Explorer result cached with the code version; becomes stale when the HEAD of any repository changes. */
  recordExploration(cardId: string, input: { summary: string; modules: string[]; repositories: string[]; evidence: Evidence[] }, source: HistorySource): Exploration {
    const codeVersions = this.codeVersions(this.projectOf(cardId))
    const evidence = input.evidence.map((item) => evidenceSchema.parse({ ...item, detail: redact(item.detail) }))
    this.insertEvent(this.event(cardId, 'exploration.recorded', source, { summary: redact(input.summary), modules: input.modules, repositories: input.repositories, evidence, codeVersions }, evidence.map((item) => item.ref)))
    this.sync(cardId)
    return this.exploration(cardId)!
  }

  exploration(cardId: string): Exploration | null {
    const event = this.lastEvent(cardId, 'exploration.recorded')
    if (!event) return null
    const saved = event.payload as { summary: string; modules: string[]; repositories: string[]; evidence: Evidence[]; codeVersions: Record<string, string> }
    const now = this.codeVersions(this.projectOf(cardId))
    const stale = Object.entries(saved.codeVersions).some(([name, hash]) => now[name] !== undefined && now[name] !== hash)
    return { summary: saved.summary, modules: saved.modules, repositories: saved.repositories, evidence: saved.evidence, codeVersions: saved.codeVersions, stale, createdAt: event.at }
  }

  // ---- Runs and handoff --------------------------------------------------------------------------------------------

  /** End of a card run: event with the metrics the agent reported and updated implementation/verification reports. */
  runFinished(info: { cardId: string; runId: string; chatId: string; purpose: string; status: string }): void {
    const run = this.db.prepare('SELECT profile_id AS profileId, provider, model, effort, started_at AS startedAt, ended_at AS endedAt, input_tokens AS input, cached_tokens AS cached, output_tokens AS output, cost_usd AS costUsd, prompt_chars AS promptChars FROM runs WHERE id = ?').get(info.runId) as Record<string, unknown> | undefined
    if (!run) return
    const type: HistoryEventType = info.purpose === 'test' ? 'verification.completed' : info.purpose === 'planning' ? 'handoff.completed' : 'execution.completed'
    this.insertEvent(this.event(info.cardId, type, { actor: 'agent', runId: info.runId, chatId: info.chatId }, { purpose: info.purpose, status: info.status, ...run }))
    this.sync(info.cardId)
  }

  /** Harness alert (e.g. files outside the Plan's scope); only records, does not block. */
  recordAlert(cardId: string, payload: Record<string, unknown>): void {
    this.insertEvent(this.event(cardId, 'harness.alert', { actor: 'system', runId: typeof payload.runId === 'string' ? payload.runId : null }, payload)); this.sync(cardId)
  }

  /** Artifact files written (exported Specification/Plan/Tasks, including in the central SDD folder). */
  recordArtifacts(cardId: string, paths: string[]): void {
    this.insertEvent(this.event(cardId, 'artifact.updated', { actor: 'system' }, { paths }, paths)); this.sync(cardId)
  }

  // ---- Full read -----------------------------------------------------------------------------------------------

  history(cardId: string): CardHistory {
    const recommendation = this.lastEvent(cardId, 'workflow.method-recommended'), method = recommendation?.payload.method
    const current = recommendation?.payload.assessmentId === (this.latest(cardId)?.id ?? null)
    return { assessments: this.assessments(cardId), decisions: this.decisions(cardId), discovery: this.discovery(cardId), exploration: this.exploration(cardId), workflow: this.workflow(cardId), sddMethod: this.sddMethod(cardId), recommendedSddMethod: current && (method === 'native' || method === 'speckit') ? method : null, sddMethodReason: current && typeof recommendation?.payload.reason === 'string' ? recommendation.payload.reason : '', artifactsDir: this.artifactsDir(cardId), events: this.events(cardId) }
  }

  events(cardId: string): HistoryEvent[] {
    return (this.db.prepare(`SELECT ${eventColumns} FROM card_events WHERE card_id = ? ORDER BY created_at, rowid`).all(cardId) as EventRow[]).map(eventFromRow)
  }

  // ---- Files: recoverable writing, reconciliation and rebuild -------------------------------------------------

  /** Writes to `history.jsonl` the events not yet written (dedup by id) and regenerates the card's Markdown reports. */
  sync(cardId: string): void {
    const dir = this.artifactsDir(cardId)
    try {
      mkdirSync(dir, { recursive: true })
      this.adopt(cardId, dir)
      const file = join(dir, 'history.jsonl'), known = existsSync(file) ? new Set(readJsonl(file).map((event) => event.id)) : new Set<string>()
      const pending = this.db.prepare(`SELECT ${eventColumns} FROM card_events WHERE card_id = ? AND (synced_at IS NULL OR type IN ('policy.decided', 'approval.requested', 'approval.approved', 'approval.denied', 'approval.consumed')) ORDER BY created_at, rowid`).all(cardId) as EventRow[]
      const lines = pending.filter((item) => !known.has(item.id)).map((item) => `${JSON.stringify(eventFromRow(item))}\n`).join('')
      if (lines) appendFileSync(file, lines, 'utf8')
      // Only marks after writing: if the app crashes midway, the next reconciliation writes again and dedup avoids duplicating.
      const mark = this.db.prepare('UPDATE card_events SET synced_at = ? WHERE id = ?'), now = new Date().toISOString()
      this.db.transaction(() => pending.forEach((item) => mark.run(now, item.id)))()
      this.writeReports(cardId, dir)
    } catch { /* artifact on disk is best-effort; the database keeps everything and reconciliation tries again */ }
  }

  /** On app open: writes the events left pending (app closed midway, folder unavailable). */
  reconcile(): number {
    const cards = this.db.prepare('SELECT DISTINCT card_id FROM card_events WHERE synced_at IS NULL').pluck().all() as string[]
    cards.forEach((cardId) => this.sync(cardId))
    return cards.length
  }

  /** Rebuilds evaluations, decisions and events from `history.jsonl`, without deleting or duplicating anything in the database. */
  rebuild(cardId: string): { events: number; assessments: number; decisions: number } {
    const file = join(this.artifactsDir(cardId), 'history.jsonl')
    if (!existsSync(file)) throw new Error(tm().history.noHistoryAt(file))
    const counts = { events: 0, assessments: 0, decisions: 0 }
    const events = readJsonl(file).filter((event) => event.cardId === cardId)
    this.db.transaction(() => {
      for (const event of events) {
        const inserted = this.db.prepare('INSERT OR IGNORE INTO card_events(id, card_id, project_id, type, schema_version, actor, created_at, json, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(event.id, cardId, event.projectId, event.type, event.v, event.source.actor, event.at, JSON.stringify(event), event.at).changes
        counts.events += inserted
        const assessment = assessmentSchema.safeParse(event.payload.assessment)
        if (assessment.success) counts.assessments += this.insertAssessment(assessment.data, true)
        const decision = decisionSchema.safeParse(event.payload.decision)
        if (decision.success) counts.decisions += this.insertDecision(decision.data, true)
        if (event.type === 'decision.superseded' && typeof event.payload.decisionId === 'string') this.db.prepare("UPDATE card_decisions SET status = 'superseded' WHERE id = ?").run(event.payload.decisionId)
        if (event.type === 'user.decision' && event.payload.status === 'approved' && typeof event.payload.decisionId === 'string') this.db.prepare("UPDATE card_decisions SET status = 'approved' WHERE id = ? AND status = 'proposed'").run(event.payload.decisionId)
        if (event.type === 'workflow.selected' && typeof event.payload.workflow === 'string') this.db.prepare('UPDATE cards SET workflow = ? WHERE id = ?').run(event.payload.workflow, cardId)
      }
    })()
    return counts
  }

  // ---- Internals -------------------------------------------------------------------------------------------------------

  private writeReports(cardId: string, dir: string): void {
    const card = this.db.prepare('SELECT title, type FROM cards WHERE id = ?').get(cardId) as { title: string; type: string } | undefined
    if (!card) return
    writeAtomic(join(dir, 'discovery.md'), discoveryMarkdown(card.title, this.history(cardId)))
    const runs = this.db.prepare(`SELECT r.id, c.purpose, r.status, r.provider, r.model, r.effort, r.started_at AS startedAt, r.ended_at AS endedAt, r.input_tokens AS input,
      r.cached_tokens AS cached, r.output_tokens AS output, r.cost_usd AS costUsd FROM runs r JOIN chats c ON c.id = r.chat_id WHERE r.card_id = ? ORDER BY r.started_at`).all(cardId) as RunRow[]
    const doc = (kind: string): string => (this.db.prepare('SELECT content_md FROM card_documents WHERE card_id = ? AND kind = ?').pluck().get(cardId, kind) as string | undefined)?.trim() ?? ''
    const execution = runs.filter((run) => run.purpose === 'execution'), tests = runs.filter((run) => run.purpose === 'test')
    if (execution.length) writeAtomic(join(dir, 'implementation.md'), `# Implementação — ${card.title}\n\n${runTable(execution)}\n\n## Resumo do card\n\n${doc('resumo') || '(vazio)'}\n`)
    if (tests.length) {
      const checklist = (this.db.prepare("SELECT content_md FROM card_checklists WHERE card_id = ? AND purpose = 'test'").pluck().get(cardId) as string | undefined)?.trim()
      const commands = this.db.prepare('SELECT command, status, exit_code AS exitCode, started_at AS startedAt FROM test_runs WHERE card_id = ? ORDER BY started_at').all(cardId) as Array<{ command: string; status: string; exitCode: number | null; startedAt: string }>
      const report = this.db.prepare("SELECT m.body AS body, m.created_at AS at FROM chat_messages m JOIN chats c ON c.id = m.chat_id WHERE c.card_id = ? AND c.purpose = 'test' AND m.role = 'assistant' AND TRIM(m.body) <> '' ORDER BY m.created_at DESC LIMIT 1").get(cardId) as { body: string; at: string } | undefined
      writeAtomic(join(dir, 'verification.md'), `# Verificação — ${card.title}\n\n${runTable(tests)}\n\n## Checklist do testador\n\n${checklist || '(sem checklist)'}\n${report ? `\n## Relatório do testador\n\n_${report.at}_\n\n${report.body.trim()}\n` : ''}${commands.length ? `\n## Comandos de teste\n\n| Quando | Comando | Resultado |\n|---|---|---|\n${commands.map((item) => `| ${item.startedAt} | \`${item.command}\` | ${item.status}${item.exitCode === null ? '' : ` (${item.exitCode})`} |`).join('\n')}\n` : ''}`)
    }
  }

  private event(cardId: string, type: HistoryEventType, source: HistorySource, payload: Record<string, unknown>, refs: string[] = []): HistoryEvent {
    return historyEventSchema.parse({ id: randomUUID(), v: 1, type, at: new Date().toISOString(), cardId, projectId: this.projectOf(cardId), source: { actor: source.actor, runId: source.runId ?? null, chatId: source.chatId ?? null, profileId: this.runInfo(source.runId).profileId }, refs, payload })
  }

  private insertEvent(event: HistoryEvent): void {
    this.db.prepare('INSERT INTO card_events(id, card_id, project_id, type, schema_version, actor, created_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(event.id, event.cardId, event.projectId, event.type, event.v, event.source.actor, event.at, JSON.stringify(event))
  }

  private insertAssessment(item: Assessment, ignore = false): number {
    return this.db.prepare(`INSERT ${ignore ? 'OR IGNORE ' : ''}INTO card_assessments(id, card_id, version, preliminary, scores_json, weights_json, limits_json, total, level, confidence, critical_risks_json, justifications_json,
      evidence_json, workflow, trigger, reason, actor, profile_id, provider, model, effort, code_version, supersedes_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(item.id, item.cardId, item.version, item.preliminary ? 1 : 0, JSON.stringify(item.scores), JSON.stringify(item.weights), item.limits ? JSON.stringify(item.limits) : null, item.total, item.level, item.confidence, JSON.stringify(item.criticalRisks),
        JSON.stringify(item.justifications), JSON.stringify(item.evidence), item.workflow, item.trigger, item.reason, item.actor, item.profileId, item.provider, item.model, item.effort, item.codeVersion, item.supersedesId, item.createdAt).changes
  }

  private insertDecision(item: Decision, ignore = false): number {
    return this.db.prepare(`INSERT ${ignore ? 'OR IGNORE ' : ''}INTO card_decisions(id, card_id, number, kind, statement, rationale, status, actor, supersedes_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(item.id, item.cardId, item.number, item.kind, item.statement, item.rationale, item.status, item.actor, item.supersedesId, item.createdAt).changes
  }

  private lastEvent(cardId: string, type: HistoryEventType): HistoryEvent | null {
    const json = this.db.prepare('SELECT json FROM card_events WHERE card_id = ? AND type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').pluck().get(cardId, type) as string | undefined
    return json ? JSON.parse(json) as HistoryEvent : null
  }

  private projectOf(cardId: string): string {
    const projectId = this.db.prepare('SELECT project_id FROM cards WHERE id = ?').pluck().get(cardId) as string | undefined
    if (!projectId) throw new Error(tm().common.cardNotFound)
    return projectId
  }

  private runInfo(runId?: string | null): RunInfo {
    const row = runId ? this.db.prepare('SELECT profile_id AS profileId, provider, model, effort FROM runs WHERE id = ?').get(runId) as RunInfo | undefined : undefined
    return row ?? { profileId: null, provider: null, model: null, effort: null }
  }

  /** HEAD of each project repository, read from Git's files (without spawning a process). */
  codeVersions(projectId: string): Record<string, string> {
    const sources = this.db.prepare('SELECT name, local_path AS path FROM project_sources WHERE project_id = ? AND is_git_repository = 1 ORDER BY sort_order').all(projectId) as Array<{ name: string; path: string }>
    const versions: Record<string, string> = {}
    for (const source of sources) { const head = readHead(source.path); if (head) versions[source.name] = head }
    return versions
  }

  private codeVersion(projectId: string): string | null {
    const entries = Object.entries(this.codeVersions(projectId))
    return entries.length ? entries.map(([name, hash]) => `${name}@${hash.slice(0, 12)}`).join(' ') : null
  }
}

/** Summary for the board card, computed straight from the database (BoardRepository does not depend on the service). */
export function complexitySummary(db: Database.Database, cardId: string): CardComplexity | null {
  const rows = db.prepare('SELECT total, level, confidence, preliminary, workflow, version, created_at AS createdAt FROM card_assessments WHERE card_id = ? ORDER BY version DESC LIMIT 2').all(cardId) as Array<{ total: number; level: CardComplexity['level']; confidence: Confidence; preliminary: number; workflow: WorkflowKind; version: number; createdAt: string }>
  const [current, previous] = rows
  if (!current) return null
  const chosen = db.prepare('SELECT workflow FROM cards WHERE id = ?').pluck().get(cardId) as WorkflowKind | null
  return { total: current.total, level: current.level, confidence: current.confidence, preliminary: Boolean(current.preliminary), recommended: current.workflow, workflow: chosen ?? null, delta: previous ? current.total - previous.total : null, version: current.version, createdAt: current.createdAt }
}

/** History read from files only (recovery scenario without SQLite): evaluations and decisions in the order they happened. */
export function readArtifactHistory(dir: string): { events: HistoryEvent[]; assessments: Assessment[]; decisions: Decision[] } {
  const events = readJsonl(join(dir, 'history.jsonl'))
  const assessments = events.map((event) => assessmentSchema.safeParse(event.payload.assessment)).filter((item) => item.success).map((item) => item.data)
  const decisions = new Map<string, Decision>()
  for (const event of events) {
    const decision = decisionSchema.safeParse(event.payload.decision)
    if (decision.success) decisions.set(decision.data.id, decision.data)
    const id = event.payload.decisionId
    if (typeof id === 'string' && decisions.has(id)) decisions.set(id, { ...decisions.get(id)!, status: event.type === 'decision.superseded' ? 'superseded' : event.payload.status === 'approved' ? 'approved' : decisions.get(id)!.status })
  }
  return { events, assessments, decisions: [...decisions.values()].sort((a, b) => a.number - b.number) }
}

/** Declarative manifest of a custom method (versioned JSON): steps, inputs, outputs and allowed commands. */
export interface MethodManifest { name: string; version: string; steps: Array<{ id: string; description: string; inputs?: string[]; outputs?: string[]; commands?: string[] }> }
export function readManifest(path: string | null): MethodManifest {
  if (!path || !existsSync(path)) throw new Error(tm().history.manifestFileRequired)
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<MethodManifest>
  if (typeof value.name !== 'string' || typeof value.version !== 'string' || !Array.isArray(value.steps) || !value.steps.length || value.steps.some((step) => typeof step?.id !== 'string' || typeof step.description !== 'string')) throw new Error(tm().history.invalidManifest)
  return value as MethodManifest
}

type AssessmentRow = { id: string; card_id: string; version: number; preliminary: number; scores_json: string; weights_json: string; limits_json: string | null; total: number; level: string; confidence: string; critical_risks_json: string; justifications_json: string; evidence_json: string; workflow: string; trigger: string; reason: string; actor: string; profile_id: string | null; provider: string | null; model: string | null; effort: string | null; code_version: string | null; supersedes_id: string | null; created_at: string }
type DecisionRow = { id: string; card_id: string; number: number; kind: string; statement: string; rationale: string; status: string; actor: string; supersedes_id: string | null; created_at: string }
type RunRow = { id: string; purpose: string; status: string; provider: string | null; model: string | null; effort: string | null; startedAt: string; endedAt: string | null; input: number; cached: number; output: number; costUsd: number | null }

function fromAssessmentRow(row: AssessmentRow): Assessment {
  return assessmentSchema.parse({ id: row.id, cardId: row.card_id, version: row.version, preliminary: Boolean(row.preliminary), scores: JSON.parse(row.scores_json), weights: JSON.parse(row.weights_json), limits: row.limits_json ? JSON.parse(row.limits_json) : null, total: row.total, level: row.level, confidence: row.confidence, criticalRisks: JSON.parse(row.critical_risks_json), justifications: JSON.parse(row.justifications_json), evidence: JSON.parse(row.evidence_json), workflow: row.workflow, trigger: row.trigger, reason: row.reason, actor: row.actor, profileId: row.profile_id, provider: row.provider, model: row.model, effort: row.effort, codeVersion: row.code_version, supersedesId: row.supersedes_id, createdAt: row.created_at })
}

function fromDecisionRow(row: DecisionRow): Decision {
  return decisionSchema.parse({ id: row.id, cardId: row.card_id, number: row.number, kind: row.kind, statement: row.statement, rationale: row.rationale, status: row.status, actor: row.actor, supersedesId: row.supersedes_id, createdAt: row.created_at })
}

function sameScores(a: DimensionScores, b: DimensionScores): boolean { return complexityDimensions.every((dimension) => a[dimension] === b[dimension]) }

function readJsonl(file: string): HistoryEvent[] {
  if (!existsSync(file)) return []
  const events: HistoryEvent[] = []
  // A truncated line (app crashed midway through writing) is ignored; the others still count.
  for (const line of readFileSync(file, 'utf8').split('\n')) { if (!line.trim()) continue; try { const parsed = historyEventSchema.safeParse(JSON.parse(line)); if (parsed.success) events.push(parsed.data) } catch { /* invalid line */ } }
  return events
}

function writeAtomic(file: string, content: string): void { const temp = `${file}.tmp`; writeFileSync(temp, content, 'utf8'); renameSync(temp, file) }

function isDir(path: string): boolean { try { return statSync(path).isDirectory() } catch { return false } }

function commandsIn(root: string, pattern: RegExp): string[] {
  const found: string[] = []
  for (const dir of ['.claude/commands', '.github/prompts', '.codex/prompts', '.agents/commands']) {
    const full = join(root, dir)
    if (!isDir(full)) continue
    for (const name of readdirSync(full)) if (pattern.test(name)) found.push(`${dir}/${name}`)
  }
  return found
}

/** HEAD without a process: follows `.git` (folder or worktree file), loose refs and `packed-refs`. */
export function readHead(repoPath: string): string | null {
  try {
    let gitDir = join(repoPath, '.git')
    if (!existsSync(gitDir)) return null
    if (!statSync(gitDir).isDirectory()) { const target = readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/)?.[1]?.trim(); if (!target) return null; gitDir = resolve(repoPath, target) }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40,64}$/.test(head)) return head
    const ref = head.match(/^ref:\s*(.+)$/)?.[1]
    if (!ref) return null
    const common = existsSync(join(gitDir, 'commondir')) ? resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()) : gitDir
    for (const base of [gitDir, common]) { const loose = join(base, ref); if (existsSync(loose)) return readFileSync(loose, 'utf8').trim() }
    const packed = join(common, 'packed-refs')
    if (!existsSync(packed)) return null
    return readFileSync(packed, 'utf8').split('\n').map((line) => line.split(' ')).find(([, name]) => name === ref)?.[0] ?? null
  } catch { return null }
}

/** No secrets go into artifacts: common tokens and keys become `[redacted]`. */
export { redact }
function redactDeep<T>(value: T): T { return redactObject(value) }

function runTable(runs: RunRow[]): string {
  const duration = (run: RunRow): string => run.endedAt ? `${Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000)} s` : '—'
  return `| Início | Status | Agente | Modelo | Esforço | Duração | Tokens (entrada / cache / saída) | Custo |\n|---|---|---|---|---|---|---|---|\n${runs.map((run) => `| ${run.startedAt} | ${run.status} | ${run.provider ?? '—'} | ${run.model ?? 'padrão'} | ${run.effort ?? '—'} | ${duration(run)} | ${run.input} / ${run.cached} / ${run.output} | ${run.costUsd === null ? 'não informado' : `US$ ${run.costUsd.toFixed(4)} (informado)`} |`).join('\n')}`
}

function discoveryMarkdown(title: string, history: CardHistory): string {
  const current = history.assessments.at(-1), lines = [`# Discovery — ${title || 'card sem título'}`, '', '> Gerado pelo GearMod a partir de `history.jsonl` (fonte versionável). Não edite à mão: as mudanças entram como eventos.', '']
  if (history.discovery) {
    const brief = history.discovery, list = (items: string[]): string => items.length ? items.map((item) => `- ${item}`).join('\n') : '- (nenhum)'
    lines.push('## Entendimento', '', `**Objetivo:** ${brief.objetivo}`, '', brief.motivacao ? `**Motivação:** ${brief.motivacao}\n` : '', '### Escopo', list(brief.escopo), '', '### Fora do escopo', list(brief.exclusoes), '', '### Critérios de aceite', list(brief.criterios), '', '### Pendências', list(brief.pendencias), '', brief.contextoTecnico ? `### Contexto técnico\n${brief.contextoTecnico}\n` : '', `**Prontidão:** ${brief.prontidao === 'pronto' ? 'pronto para planejar' : 'precisa esclarecer'}`, '')
  }
  if (current) {
    lines.push('## Complexidade atual', '', `**${current.total} pontos — ${levelLabels[current.level]}**${current.preliminary ? ' (preliminar)' : ''} · confiança ${current.confidence} · v${current.version} · ${current.actor === 'user' ? 'corrigida pelo usuário' : `agente ${current.provider ?? ''} ${current.model ?? ''}`.trim()}`, '',
      `Fluxo recomendado: ${workflowLabels[current.workflow]}${history.workflow ? ` · fluxo escolhido: ${workflowLabels[history.workflow]}` : ''}`, '', '| Dimensão | Nota | Peso | Pontos | Justificativa |', '|---|---|---|---|---|',
      ...complexityDimensions.map((dimension) => `| ${dimensionLabels[dimension]} | ${current.scores[dimension]} | ${current.weights[dimension]} | ${current.scores[dimension] * current.weights[dimension]} | ${(current.justifications[dimension] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`), '')
    if (current.criticalRisks.length) lines.push('### Riscos críticos', ...current.criticalRisks.map((item) => `- ${item}`), '')
    if (current.evidence.length) lines.push('### Evidências', ...current.evidence.map((item) => `- [${item.kind}] \`${item.ref}${item.line ? `:${item.line}` : ''}\`${item.commit ? ` @ ${item.commit}` : ''}${item.detail ? ` — ${item.detail}` : ''}`), '')
    lines.push('## Histórico de avaliações', '', '| Versão | Data | Pontos | Nível | Gatilho | Quem | Motivo |', '|---|---|---|---|---|---|---|',
      ...history.assessments.map((item) => `| v${item.version}${item.preliminary ? ' (preliminar)' : ''} | ${item.createdAt} | ${item.total} | ${levelLabels[item.level]} | ${triggerLabels[item.trigger]} | ${item.actor === 'user' ? 'usuário' : 'agente'} | ${item.reason.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`), '')
  }
  if (history.decisions.length) lines.push('## Decisões', '', ...history.decisions.map((item) => `- **D${String(item.number).padStart(3, '0')}** [${item.status === 'approved' ? 'aprovada pelo usuário' : item.status === 'proposed' ? 'recomendação do agente' : 'substituída'}] ${item.statement}${item.rationale ? ` — ${item.rationale}` : ''}`), '')
  if (history.exploration) lines.push('## Exploração do código', '', history.exploration.summary, '', `Versão do código: ${Object.entries(history.exploration.codeVersions).map(([name, hash]) => `${name}@${hash.slice(0, 12)}`).join(', ') || 'sem Git'}`, '')
  return `${lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n').trim()}\n`
}
