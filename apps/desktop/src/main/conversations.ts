import { randomUUID } from 'node:crypto'
import type { AgentPurpose, BackgroundTask, CardUsage, Chat, ChatPurpose, ChatMessage, Plan, Run, RunEvent, RunMetric, TokenCount } from '@gearmod/contracts'
import type { AgentProfile } from '@gearmod/contracts'
import type { AppDatabase } from './database'
import { tm } from './i18n'

type ChatRow = Omit<Chat, 'skill' | 'busy'> & { skillName: string | null; skillPath: string | null; busy?: number }
const toChat = ({ skillName, skillPath, busy, ...chat }: ChatRow): Chat => ({ ...chat, busy: Boolean(busy), skill: skillName && skillPath ? { name: skillName, path: skillPath } : null })

export class ConversationRepository {
  constructor(private readonly database: AppDatabase) {}

  listChats(projectId: string, cardId?: string | null): Chat[] {
    const where = cardId === undefined ? 'project_id = ?' : cardId === null ? 'project_id = ? AND card_id IS NULL' : 'project_id = ? AND card_id = ?'
    const args = cardId === undefined || cardId === null ? [projectId] : [projectId, cardId]
    return this.database.db.prepare(`SELECT id, project_id AS projectId, card_id AS cardId, purpose, provider, profile_id AS profileId,
      provider_session_id AS providerSessionId, skill_name AS skillName, skill_path AS skillPath, title, EXISTS (SELECT 1 FROM runs r WHERE r.chat_id = chats.id AND r.status IN ('queued', 'running')) AS busy, created_at AS createdAt, updated_at AS updatedAt FROM chats WHERE ${where} ORDER BY updated_at DESC`).all(...args)
      .map((row) => toChat(row as ChatRow))
  }

  projectOf(chatId: string): string {
    const row = this.database.db.prepare('SELECT project_id AS projectId FROM chats WHERE id = ?').get(chatId) as { projectId: string } | undefined
    if (!row) throw new Error(tm().common.chatNotFound)
    return row.projectId
  }

  setSkill(chatId: string, skill: { name: string; path: string } | null): Chat {
    const chat = this.database.db.prepare('SELECT project_id AS projectId, card_id AS cardId FROM chats WHERE id = ?').get(chatId) as { projectId: string; cardId: string | null } | undefined
    if (!chat) throw new Error(tm().common.chatNotFound)
    this.database.db.prepare('UPDATE chats SET skill_name = ?, skill_path = ? WHERE id = ?').run(skill?.name ?? null, skill?.path ?? null, chatId)
    return this.listChats(chat.projectId, chat.cardId).find((item) => item.id === chatId)!
  }

  createChat(input: { projectId: string; cardId: string | null; purpose: ChatPurpose; profileId: string; skill?: { name: string; path: string } | null }): Chat {
    const allowed = this.database.db.prepare('SELECT ap.provider FROM project_agent_profiles pap JOIN agent_profiles ap ON ap.id = pap.profile_id WHERE pap.project_id = ? AND pap.profile_id = ? AND pap.allowed = 1 AND ap.enabled = 1').get(input.projectId, input.profileId) as { provider: 'codex' | 'claude' } | undefined
    if (!allowed) throw new Error(tm().conversations.profileNotAllowed)
    const projectChat = input.purpose === 'free' || input.purpose === 'constitution' || input.purpose === 'conflict' || input.purpose === 'test-setup'
    if (projectChat ? input.cardId !== null : input.cardId === null) throw new Error(projectChat ? tm().conversations.projectChatHasNoCard : tm().conversations.chatNeedsCard)
    if (input.cardId && !this.database.db.prepare('SELECT 1 FROM cards WHERE id = ? AND project_id = ?').get(input.cardId, input.projectId)) throw new Error(tm().common.cardNotInProject)
    const id = randomUUID(), now = new Date().toISOString()
    this.database.db.prepare(`INSERT INTO chats(id, project_id, card_id, purpose, provider, profile_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.projectId, input.cardId, input.purpose, allowed.provider, input.profileId, now, now)
    if (input.skill) this.setSkill(id, input.skill)
    return this.listChats(input.projectId, input.cardId).find((chat) => chat.id === id)!
  }

  listMessages(chatId: string): ChatMessage[] {
    return this.database.db.prepare(`SELECT id, chat_id AS chatId, role, body, status, created_at AS createdAt,
      provider_message_id AS providerMessageId FROM chat_messages WHERE chat_id = ? ORDER BY created_at, rowid`).all(chatId) as ChatMessage[]
  }

  addMessage(input: { chatId: string; role: string; body: string; status: string }): ChatMessage {
    const id = randomUUID(), now = new Date().toISOString()
    if (!this.database.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(input.chatId)) throw new Error(tm().common.chatNotFound)
    this.database.db.prepare('INSERT INTO chat_messages(id, chat_id, role, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, input.chatId, input.role, input.body, input.status, now)
    this.database.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, input.chatId)
    return this.listMessages(input.chatId).find((message) => message.id === id)!
  }

  createRun(input: { cardId: string | null; chatId: string; profileId: string }): Run {
    const valid = input.cardId === null
      ? this.database.db.prepare(`SELECT 1 FROM chats WHERE id = ? AND card_id IS NULL AND purpose IN ('free', 'constitution', 'conflict', 'test-setup') AND profile_id = ?`).get(input.chatId, input.profileId)
      : this.database.db.prepare(`SELECT 1 FROM chats c JOIN cards k ON k.id = ? WHERE c.id = ? AND c.card_id = k.id AND c.profile_id = ?`).get(input.cardId, input.chatId, input.profileId)
    if (!valid) throw new Error(tm().conversations.runMismatch)
    const id = randomUUID(), startedAt = new Date().toISOString()
    this.database.db.prepare(`INSERT INTO runs(id, card_id, chat_id, profile_id, status, started_at) VALUES (?, ?, ?, ?, 'queued', ?)`).run(id, input.cardId, input.chatId, input.profileId, startedAt)
    return { id, ...input, status: 'queued', startedAt, endedAt: null, exitReason: null, worktreeId: null, providerTurnId: null }
  }

  /**
   * Background subagents and commands of the chat, read from the task_* events Claude already emits (and the app already saves).
   * Without a completion notice and with the run already ended, the task was interrupted. Subagent commands do not count: they stay inside the subagent.
   */
  backgroundTasks(chatId: string): BackgroundTask[] {
    const rows = this.database.db.prepare(`SELECT e.run_id AS runId, e.payload_json_sanitized AS payload, e.created_at AS at, r.status AS runStatus
      FROM run_events e JOIN runs r ON r.id = e.run_id
      WHERE r.chat_id = ? AND e.event_type = 'claude/system' AND e.payload_json_sanitized LIKE '%"subtype":"task_%'
      ORDER BY e.created_at, e.seq`).all(chatId) as Array<{ runId: string; payload: string; at: string; runStatus: string }>
    const tasks = new Map<string, BackgroundTask & { owned: boolean }>()
    for (const row of rows) {
      let event: Record<string, unknown>; try { event = JSON.parse(row.payload) as Record<string, unknown> } catch { continue }
      const id = String(event.task_id ?? ''); if (!id) continue
      const current = tasks.get(id)
      if (event.subtype === 'task_started') {
        const title = String(event.description ?? '').split(/\r?\n/)[0]!.slice(0, 160)
        tasks.set(id, { id, runId: row.runId, kind: event.subagent_type ? 'subagent' : 'command', title, activity: '', status: 'running', startedAt: row.at, endedAt: null, summary: '', owned: Boolean(event.owned_by_subagent) })
      } else if (!current) continue
      else if (event.subtype === 'task_progress') current.activity = String(event.description ?? '').slice(0, 200)
      else if (event.subtype === 'task_notification') {
        const status = String(event.status ?? ''); current.status = status === 'completed' || status === 'failed' ? status : 'stopped'
        current.endedAt = row.at; current.summary = String(event.summary ?? '').slice(0, 300)
      }
    }
    const runStatus = new Map(rows.map((row) => [row.runId, row.runStatus]))
    const list = [...tasks.values()].filter((task) => !task.owned).map(({ owned: _owned, ...task }) => task.status === 'running' && !['running', 'queued'].includes(runStatus.get(task.runId) ?? '') ? { ...task, status: 'stopped' as const } : task)
    const running = list.filter((task) => task.status === 'running'), done = list.filter((task) => task.status !== 'running').sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt)).slice(0, 10)
    return [...running, ...done]
  }

  /**
   * The chat's run still in progress and the text it streamed so far, rebuilt from the saved deltas. The screen keeps the live text
   * only in memory: without this, leaving the chat and coming back showed nothing until the run ended. `seq` is the last saved event.
   */
  liveRun(chatId: string): { runId: string; text: string; seq: number } | null {
    const run = this.database.db.prepare(`SELECT id FROM runs WHERE chat_id = ? AND status IN ('queued', 'running') ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(chatId) as { id: string } | undefined
    if (!run) return null
    const seq = (this.database.db.prepare('SELECT COALESCE(MAX(seq), -1) AS seq FROM run_events WHERE run_id = ?').get(run.id) as { seq: number }).seq
    const deltas = this.database.db.prepare(`SELECT payload_json_sanitized FROM run_events WHERE run_id = ? AND event_type = 'item/agentMessage/delta' ORDER BY seq`).pluck().all(run.id) as string[]
    let text = ''
    for (const payload of deltas) { try { text += String((JSON.parse(payload) as { delta?: unknown }).delta ?? '') } catch { /* damaged event: skip it */ } }
    return { runId: run.id, text, seq }
  }

  appendEvent(runId: string, eventType: string, payload: Record<string, unknown>): RunEvent {
    const next = this.database.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM run_events WHERE run_id = ?').get(runId) as { seq: number }
    const event = { id: randomUUID(), runId, seq: next.seq, eventType, payload, createdAt: new Date().toISOString() }
    this.database.db.prepare('INSERT INTO run_events(id, run_id, seq, event_type, payload_json_sanitized, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(event.id, runId, event.seq, eventType, JSON.stringify(payload), event.createdAt)
    return event
  }

  context(chatId: string): { chat: Chat; cardId: string | null; projectPath: string; profile: AgentProfile } {
    const row = this.database.db.prepare(`SELECT c.id, c.project_id AS projectId, c.card_id AS cardId, c.purpose, c.provider,
      c.profile_id AS profileId, c.provider_session_id AS providerSessionId, c.skill_name AS skillName, c.skill_path AS skillPath, c.title, c.created_at AS createdAt, c.updated_at AS updatedAt,
      p.local_path AS projectPath, ap.label, ap.scope, ap.color, ap.config_dir AS configDir, ap.executable_path AS executablePath, ap.enabled, ap.billing_mode AS billingMode, ap.env_passthrough AS envPassthroughRaw
      FROM chats c JOIN projects p ON p.id = c.project_id JOIN agent_profiles ap ON ap.id = c.profile_id WHERE c.id = ?`).get(chatId) as (ChatRow & { projectPath: string; label: string; scope: string; color: string; configDir: string; executablePath: string | null; enabled: number; billingMode: AgentProfile['billingMode']; envPassthroughRaw: string }) | undefined
    if (!row) throw new Error(tm().common.chatNotFound)
    if (!row.cardId && row.purpose !== 'free' && row.purpose !== 'constitution' && row.purpose !== 'conflict' && row.purpose !== 'test-setup') throw new Error(tm().conversations.executionNeedsCard)
    const { projectPath, label, scope, color, configDir, executablePath, enabled, billingMode, envPassthroughRaw, ...rest } = row
    const chat = toChat(rest)
    let envPassthrough: string[] = []
    try { const parsed = JSON.parse(envPassthroughRaw || '[]'); if (Array.isArray(parsed)) envPassthrough = parsed.filter((item): item is string => typeof item === 'string') } catch { /* lista vazia */ }
    return { chat, cardId: row.cardId ?? null, projectPath, profile: { id: row.profileId, provider: row.provider, label, scope, color, configDir, executablePath, enabled: Boolean(enabled), billingMode, envPassthrough } }
  }

  /** Free chat title (first request), only if it does not have one yet. */
  setTitleIfEmpty(chatId: string, title: string): void {
    this.database.db.prepare("UPDATE chats SET title = ? WHERE id = ? AND (title IS NULL OR title = '')").run(title.slice(0, 120), chatId)
  }

  /** The free chat became the planning of a new card: it becomes that card's planning chat, with the history and the agent session. */
  /** G09: the Constitution chat can also create a card to save a real change; it becomes planning like the free chat. */
  convertToPlanning(chatId: string, cardId: string): void {
    this.database.db.transaction(() => {
      const converted = this.database.db.prepare("UPDATE chats SET card_id = ?, purpose = 'planning', updated_at = ? WHERE id = ? AND purpose IN ('free','constitution')").run(cardId, new Date().toISOString(), chatId)
      if (!converted.changes) throw new Error(tm().conversations.onlyFreeOrConstitutionToPlanning)
      this.database.db.prepare('UPDATE runs SET card_id = ? WHERE chat_id = ?').run(cardId, chatId)
    })()
  }

  updateSession(chatId: string, providerSessionId: string): void {
    this.database.db.prepare('UPDATE chats SET provider_session_id = ?, updated_at = ? WHERE id = ?').run(providerSessionId, new Date().toISOString(), chatId)
  }

  updateRun(runId: string, status: Run['status'], exitReason: string | null, providerTurnId: string | null = null): void {
    const ended = ['completed', 'failed', 'interrupted', 'cancelled'].includes(status) ? new Date().toISOString() : null
    this.database.db.prepare('UPDATE runs SET status = ?, ended_at = ?, exit_reason = ?, provider_turn_id = COALESCE(?, provider_turn_id) WHERE id = ?').run(status, ended, exitReason, providerTurnId, runId)
  }

  /** Saves the run's tokens (the agent reports them when it finishes, also when interrupted). */
  recordUsage(runId: string, usage: { input: number; cached: number; output: number; costUsd?: number } | undefined): void {
    if (!usage) return
    this.database.db.prepare('UPDATE runs SET input_tokens = ?, cached_tokens = ?, output_tokens = ?, cost_usd = ? WHERE id = ?').run(usage.input, usage.cached, usage.output, usage.costUsd ?? null, runId)
  }

  recordEffectiveModel(runId: string, model: string | undefined): void {
    if (!model) return
    this.database.db.prepare('UPDATE runs SET model_effective = ? WHERE id = ?').run(model, runId)
  }

  /** Run identification for the metrics: stage, provider, model and effort used and the size of the text sent to the agent. */
  recordRunMeta(runId: string, meta: { purpose: string; provider: string; model: string | null; effort: string | null; promptChars: number }): void {
    this.database.db.prepare('UPDATE runs SET purpose = ?, provider = ?, model = ?, effort = ?, prompt_chars = ? WHERE id = ?').run(meta.purpose, meta.provider, meta.model, meta.effort, meta.promptChars, runId)
  }

  /** Metrics of the card's runs, only with what the agent reported (cost without a value from the agent stays `unavailable`). */
  runMetrics(cardId: string): RunMetric[] {
    const rows = this.database.db.prepare(`SELECT r.id AS runId, COALESCE(r.purpose, c.purpose) AS purpose, r.provider, r.model, r.model_effective AS modelEffective, r.effort, r.status, r.started_at AS startedAt, r.ended_at AS endedAt,
      r.input_tokens AS input, r.cached_tokens AS cached, r.output_tokens AS output, r.cost_usd AS costUsd, r.prompt_chars AS promptChars, r.used_playwright_cli AS usedPlaywrightCli FROM runs r JOIN chats c ON c.id = r.chat_id WHERE r.card_id = ? ORDER BY r.started_at`).all(cardId) as Array<Omit<RunMetric, 'durationMs' | 'costSource' | 'usedPlaywrightCli'> & { usedPlaywrightCli: number }>
    return rows.map((row) => ({ ...row, usedPlaywrightCli: Boolean(row.usedPlaywrightCli), durationMs: row.endedAt ? Math.max(0, Date.parse(row.endedAt) - Date.parse(row.startedAt)) : null, costSource: row.costUsd === null ? 'unavailable' : 'reported' }))
  }

  /** Card tokens summed by stage (planning, implementation and testing), by the purpose of each run's chat. */
  cardUsage(cardId: string): CardUsage {
    const total = (): TokenCount => ({ input: 0, cached: 0, output: 0, runs: 0 })
    const usage: CardUsage = { planning: total(), execution: total(), test: total(), agents: [] }
    const rows = this.database.db.prepare(`SELECT c.purpose AS purpose, SUM(r.input_tokens) AS input, SUM(r.cached_tokens) AS cached, SUM(r.output_tokens) AS output, COUNT(*) AS runs
      FROM runs r JOIN chats c ON c.id = r.chat_id WHERE r.card_id = ? GROUP BY c.purpose`).all(cardId) as Array<{ purpose: string; input: number; cached: number; output: number; runs: number }>
    for (const row of rows) if (row.purpose === 'planning' || row.purpose === 'execution' || row.purpose === 'test') usage[row.purpose] = { input: row.input, cached: row.cached, output: row.output, runs: row.runs }
    usage.agents = this.database.db.prepare(`SELECT c.purpose AS purpose, r.profile_id AS profileId, ap.label AS label, ap.provider AS provider, SUM(r.input_tokens) AS input, SUM(r.cached_tokens) AS cached, SUM(r.output_tokens) AS output, COUNT(*) AS runs
      FROM runs r JOIN chats c ON c.id = r.chat_id JOIN agent_profiles ap ON ap.id = r.profile_id WHERE r.card_id = ? AND c.purpose IN ('planning', 'execution', 'test') GROUP BY c.purpose, r.profile_id ORDER BY MIN(r.started_at), MIN(r.rowid)`).all(cardId) as CardUsage['agents']
    return usage
  }

  attachWorktree(runId: string, worktreeId: string): void {
    this.database.db.prepare('UPDATE runs SET worktree_id = ? WHERE id = ?').run(worktreeId, runId)
  }

  savePlan(cardId: string, profileId: string, content: string): void {
    const version = (this.database.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS value FROM plans WHERE card_id = ?').get(cardId) as { value: number }).value
    this.database.db.prepare(`INSERT INTO plans(id, card_id, version, agent_profile_id, content_md, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?)`).run(randomUUID(), cardId, version, profileId, content, new Date().toISOString())
  }

  listPlans(cardId: string): Plan[] {
    return this.database.db.prepare(`SELECT id, card_id AS cardId, version, agent_profile_id AS agentProfileId,
      content_md AS contentMd, status, created_at AS createdAt, approved_at AS approvedAt
      FROM plans WHERE card_id = ? ORDER BY version DESC`).all(cardId) as Plan[]
  }

  approvePlan(planId: string): Plan {
    const plan = this.database.db.prepare('SELECT card_id AS cardId FROM plans WHERE id = ?').get(planId) as { cardId: string } | undefined
    if (!plan) throw new Error(tm().conversations.planNotFound)
    const approve = this.database.db.transaction(() => {
      this.database.db.prepare(`UPDATE plans SET status = 'superseded' WHERE card_id = ? AND status = 'approved'`).run(plan.cardId)
      this.database.db.prepare(`UPDATE plans SET status = 'approved', approved_at = ? WHERE id = ?`).run(new Date().toISOString(), planId)
    })
    approve()
    return this.listPlans(plan.cardId).find((item) => item.id === planId)!
  }

  /** Ensures the card's current Plan exists as a version in `plans` and approves it (Start approves the plan). */
  approveCurrentPlan(cardId: string, profileId: string, planDocument: string): Plan | null {
    const latest = this.listPlans(cardId)[0]
    if (planDocument.trim() && latest?.contentMd !== planDocument) this.savePlan(cardId, profileId, planDocument)
    const target = this.listPlans(cardId)[0]
    return target ? this.approvePlan(target.id) : null
  }

  /** Chat of each card stage (planning, implementation, testing): one per stage, with the history, created the first time. */
  /** Short flow has a single chat: the planning chat becomes the work chat, keeping its messages and the agent's session. */
  promotePlanningChat(chatId: string): void {
    this.database.db.prepare("UPDATE chats SET purpose = 'execution' WHERE id = ? AND purpose = 'planning'").run(chatId)
  }

  purposeChat(projectId: string, cardId: string, purpose: AgentPurpose, profileId: string): Chat {
    const existing = this.listChats(projectId, cardId).find((chat) => chat.purpose === purpose)
    return existing ?? this.createChat({ projectId, cardId, purpose, profileId })
  }

  /** Restarts a stage's chat (agent switch): deletes its messages, runs and events. Refuses if an agent is still working. */
  resetChat(chatId: string): void {
    if (!this.database.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId)) throw new Error(tm().common.chatNotFound)
    if (this.database.db.prepare(`SELECT 1 FROM runs WHERE chat_id = ? AND status IN ('queued', 'running') LIMIT 1`).get(chatId)) throw new Error(tm().conversations.stopAgentBeforeRestart)
    this.database.db.transaction(() => {
      this.database.db.prepare('UPDATE test_runs SET run_id = NULL WHERE run_id IN (SELECT id FROM runs WHERE chat_id = ?)').run(chatId)
      this.database.db.prepare('UPDATE runs SET worktree_id = NULL WHERE chat_id = ?').run(chatId)
      this.database.db.prepare('DELETE FROM runs WHERE chat_id = ?').run(chatId)
      this.database.db.prepare('DELETE FROM chats WHERE id = ?').run(chatId)
    })()
  }

  /** Deletes a project chat. Chats linked to cards are part of the card's history and can never be deleted in isolation. */
  deleteChat(chatId: string): void {
    const chat = this.database.db.prepare('SELECT card_id AS cardId FROM chats WHERE id = ?').get(chatId) as { cardId: string | null } | undefined
    if (!chat) throw new Error(tm().common.chatNotFound)
    if (chat.cardId !== null) throw new Error(tm().conversations.cardChatsCannotBeDeleted)
    this.resetChat(chatId)
  }

  reconcileInterrupted(): number {
    return this.database.db.prepare(`UPDATE runs SET status = 'interrupted', ended_at = ?, exit_reason = 'Application restarted' WHERE status IN ('queued', 'running')`).run(new Date().toISOString()).changes
  }
}
