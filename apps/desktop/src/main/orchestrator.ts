import { AgentPermissions } from './agent-permissions'
import type { AgentPurpose, ChatPurpose, Effort, PermissionMode, Run } from '@gearmod/contracts'
import type { AgentAdapter, AgentEvent } from './adapters'
import type { ConversationRepository } from './conversations'
import type { WorktreeService } from './worktrees'
import type { AgentContextService } from './agent-context'
import type { AgentWriteback } from './agent-writeback'
import type { AgentConfigRepository } from './agent-config'
import { titleFromPrompt } from './agent-writeback'
import { toolActivities, toolEditedFiles } from './tool-activity'
import type { RunHarness } from './harness'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isSpecKitImplementRequest, SpecKitImplementBlocked } from './spec-tools'
import type { SpecKitRuntime } from './speckit'
import type { McpRegistry } from './mcp-registry'
import { tm } from './i18n'
import { ptBR } from './i18n/pt-BR'
import { en } from './i18n/en'

/** Block that accompanies a message with attachments: the agent reads those files as context. Kept in Portuguese on purpose: the renderer (Attachments.tsx) recognizes this marker to hide the block. */
export function attachmentNote(paths: string[]): string {
  return `Arquivos anexados (leia antes de responder; são contexto deste pedido):\n${paths.map((path) => `- ${path}`).join('\n')}`
}

type AgentChoice = { model?: string | null; effort?: Effort | null; mode?: PermissionMode }
type Job = { run: Run; chatId: string; prompt: string; planning: boolean; notice?: string; attachments?: string[]; automatic?: boolean; choice?: AgentChoice; cwd?: string }

export class AgentOrchestrator {
  readonly permissions = new AgentPermissions()
  private stopping = false
  private active = 0
  private readonly queue: Job[] = []
  private readonly controllers = new Map<string, AbortController>()
  private harness?: RunHarness
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly adapters: Record<'codex' | 'claude' | 'gemini', AgentAdapter>,
    private readonly emit: (event: { runId: string; eventType: string; payload: Record<string, unknown>; seq?: number }) => void,
    private readonly worktrees: WorktreeService,
    /** Limit of simultaneous runs; a function so it takes effect immediately when the user changes the setting. */
    private readonly concurrency: number | (() => number) = 2,
    private readonly agentContext?: Pick<AgentContextService, 'prompt' | 'freePrompt' | 'constitutionPrompt' | 'freeInstructions' | 'developerInstructions' | 'pluginDir'>,
    private readonly writeback?: AgentWriteback,
    private readonly configs?: Pick<AgentConfigRepository, 'resolve' | 'recordUse'>,
    private readonly usage?: { recordClaude(profileId: string, payload: Record<string, unknown>): void },
    private readonly collab?: { afterRun(info: { cardId: string; chatId: string; purpose: AgentPurpose; status: string }): void },
    private readonly onFinished?: (info: { cardId: string | null; chatId: string; runId: string; purpose: ChatPurpose; status: Run['status']; error: string | null }) => void,
    private readonly ledger?: { recordRun(runId: string, usage: { input: number; cached: number; output: number; costUsd?: number } | undefined, partial?: boolean): void; recordDelta?(runId: string, usage: { input: number; cached: number; output: number }): void },
    private readonly profiles?: { recordBillingHint(id: string, hint: string): void },
    private readonly speckit?: Pick<SpecKitRuntime, 'assertCanStart' | 'prepare' | 'prepareImplementation' | 'afterRun' | 'denies'>,
    private readonly mcpServers?: Pick<McpRegistry, 'effective'>
  ) {}

  /** Run limits (time, budget, attempts) and notices after the run; optional for tests. */
  setHarness(harness: RunHarness): void { this.harness = harness }

  /** `notice` replaces the prompt in the chat with a short notice (the app's internal instructions do not appear as a user message). */
  /** `cwd`: run in that folder instead of the project's (conflict chats work inside the repository or card worktree that has the conflict). */
  start(input: { chatId: string; prompt: string; planning: boolean; notice?: string; attachments?: string[]; automatic?: boolean; choice?: AgentChoice; cwd?: string }): Run {
    if (this.stopping) throw new Error(tm().orchestrator.appQuitting)
    const context = this.conversations.context(input.chatId)
    if (context.chat.purpose === 'planning' && isSpecKitImplementRequest(input.prompt, context.chat.skill)) {
      throw new SpecKitImplementBlocked()
    }
    if (context.chat.purpose === 'planning' && context.cardId) this.speckit?.assertCanStart(context.cardId)
    // `automatic`: a resume the app triggers on its own (chaining between steps); only it is blocked by repeated failures.
    const blocked = context.cardId ? this.harness?.before({ cardId: context.cardId, chatId: input.chatId, automatic: Boolean(input.automatic) }) : null
    if (blocked) throw new Error(blocked)
    // Attachments: only the ones that exist; the list goes in the text (the user sees it in the chat and the agent reads the files) and is passed on to the adapter to allow reading.
    const attachments = [...new Set(input.attachments ?? [])].filter((path) => isAbsolute(path) && existsSync(path) && statSync(path).isFile())
    if (input.attachments?.length && !attachments.length) throw new Error(tm().orchestrator.noAttachmentsFound)
    if (attachments.length) input = { ...input, attachments, prompt: `${input.prompt}\n\n${attachmentNote(attachments)}` }
    if (!context.profile.enabled) throw new Error(tm().orchestrator.agentRemoved(context.profile.label))
    const projectChat = context.chat.purpose === 'free' || context.chat.purpose === 'constitution' || context.chat.purpose === 'conflict'
    if (input.planning && context.chat.purpose !== 'planning' && !projectChat) throw new Error(tm().orchestrator.usePlanningChat)
    // The Constitution never changes files (runs like planning, read-only). Free chat changes files when the chosen mode is not plan mode.
    if (context.chat.purpose === 'constitution') input = { ...input, planning: true }
    if (context.chat.purpose !== 'free' && context.chat.purpose !== 'conflict') input = { ...input, choice: undefined }
    this.conversations.addMessage(input.notice ? { chatId: input.chatId, role: 'system', body: input.notice, status: 'complete' } : { chatId: input.chatId, role: 'user', body: input.prompt, status: 'complete' })
    const run = this.conversations.createRun({ cardId: context.cardId, chatId: input.chatId, profileId: context.profile.id })
    const full = this.active >= this.limit()
    this.queue.push({ run, ...input }); this.pump()
    // User request that did not fit: it stays in the queue and the screen asks whether to run anyway or change the limit. Automatic resumes wait silently.
    if (full && !input.automatic) this.emit({ runId: run.id, eventType: 'gearmod/run-queued', payload: { chatId: input.chatId, cardId: context.cardId, active: this.active, limit: this.limit() } })
    return run
  }

  private limit(): number { return Math.max(1, typeof this.concurrency === 'function' ? this.concurrency() : this.concurrency) }

  capacity(): { active: number; queued: number; limit: number } { return { active: this.active, queued: this.queue.length, limit: this.limit() } }

  /** The user decided to exceed the limit: takes the run out of the queue and runs it now. */
  runNow(runId: string): boolean {
    const index = this.queue.findIndex((job) => job.run.id === runId)
    if (index < 0) return false
    this.launch(this.queue.splice(index, 1)[0]!)
    return true
  }

  /** Call when the limit changed: if it went up, what was queued starts. */
  refill(): void { this.pump() }

  /** Runs running or queued: what dies if the app closes. */
  pendingCount(): number { return this.active + this.queue.length }

  shutdown(): void {
    this.stopping = true
    for (const job of this.queue.splice(0)) this.conversations.updateRun(job.run.id, 'cancelled', 'Aplicativo encerrado')
    for (const controller of this.controllers.values()) controller.abort()
  }

  cancel(runId: string): boolean {
    const queued = this.queue.findIndex((job) => job.run.id === runId)
    if (queued >= 0) { this.queue.splice(queued, 1); this.conversations.updateRun(runId, 'cancelled', 'Cancelled before start'); return true }
    const controller = this.controllers.get(runId); if (!controller) return false; controller.abort(); return true
  }

  private pump(): void {
    while (this.active < this.limit() && this.queue.length) this.launch(this.queue.shift()!)
  }

  private launch(job: Job): void {
    this.active += 1
    void this.execute(job).finally(() => { this.active -= 1; this.pump() })
  }

  private async execute(initial: Job): Promise<void> {
    let job = initial
    const controller = new AbortController(); this.controllers.set(job.run.id, controller)
    const context = this.conversations.context(job.chatId)
    // Project time limit: aborts the run and records it as a failure (not as a user stop).
    const limit = context.cardId ? this.harness?.timeoutMs(context.cardId) ?? null : null
    let timedOut = false
    const timer = limit ? setTimeout(() => { timedOut = true; controller.abort() }, limit) : null
    const timeoutError = (): string => tm().orchestrator.timeoutReached(Math.round((limit ?? 0) / 60_000))
    const offered = new Set<string>()
    const publish = (event: AgentEvent): void => {
      if (this.stopping) return
      if (event.type === 'tokens.update') { try { this.ledger?.recordDelta?.(job.run.id, { input: Number(event.payload.input) || 0, cached: Number(event.payload.cached) || 0, output: Number(event.payload.output) || 0 }) } catch { /* ledger is informational */ } }
      if (event.type === 'claude/rate_limit_event') { try { this.usage?.recordClaude(context.profile.id, event.payload) } catch { /* usage is informational */ } }
      const saved = this.conversations.appendEvent(job.run.id, event.type, event.payload); this.emit({ runId: job.run.id, eventType: saved.eventType, payload: saved.payload, seq: saved.seq })
      // Tools used become gray lines in the chat (as in Claude Code); the screen reloads the messages when it receives the notice.
      const tools = toolActivities(event.type, event.payload)
      // The agent touched another card's worktree (e.g. the user asked to work there): warns once per owner, so the screen can offer the link.
      if (context.cardId) for (const file of toolEditedFiles(event.type, event.payload)) {
        const owner = this.worktrees.foreignOwner(context.cardId, file)
        if (owner && !offered.has(owner.cardId)) { offered.add(owner.cardId); this.emit({ runId: job.run.id, eventType: 'gearmod/worktree-foreign', payload: { cardId: context.cardId, ownerCardId: owner.cardId, ownerTitle: owner.title } }) }
      }
      if (tools.length) {
        for (const tool of tools) this.conversations.addMessage({ chatId: job.chatId, role: 'tool', body: tool.detail ? `${tool.title}\n${tool.detail}` : tool.title, status: 'complete' })
        this.emit({ runId: job.run.id, eventType: 'gearmod/tool-activity', payload: { chatId: job.chatId } })
      }
    }
    try {
      const free = context.chat.purpose === 'free' || context.chat.purpose === 'conflict', constitution = context.chat.purpose === 'constitution'
      // The card's planning already uses the same worktree that will be reused in the run.
      // Projects without Git can still be planned in read-only mode.
      let worktree = null
      if (context.cardId) {
        try { worktree = await this.worktrees.prepare(context.cardId) }
        catch (error) {
          if (!job.planning || !(error instanceof Error) || ![ptBR, en].some((dict) => error.message.startsWith(dict.worktrees.noGitRepoFound.slice(0, 30)))) throw error
          this.conversations.addMessage({ chatId: job.chatId, role: 'system', body: tm().orchestrator.noGitReadOnlyPlanning, status: 'complete' })
        }
      }
      if (this.stopping) return
      const cwd = job.cwd ?? worktree?.path ?? context.projectPath
      if (worktree) this.conversations.attachWorktree(job.run.id, worktree.id)
      const failedRepos = worktree && context.cardId ? this.worktrees.repositories(context.cardId).filter((repo) => repo.status === 'failed') : []
      if (failedRepos.length) this.conversations.addMessage({ chatId: job.chatId, role: 'system', body: tm().orchestrator.reposFailed(failedRepos.length, failedRepos.map((repo) => `- ${repo.error}`).join('\n')), status: 'failed' })
      // S10: HEAD of each repository before the run, so the harness can later detect a commit/branch that did not come from agentCommit.
      if (worktree && context.cardId) try { await this.harness?.snapshotRepos?.(context.cardId) } catch { /* detection is best-effort */ }
      // Spec Kit: skill checked in the worktree, card feature tied in, and mode chosen by the user; a failure here becomes a run error (without switching methods).
      const sk = context.chat.purpose === 'planning' && context.cardId ? this.speckit?.prepare({ cardId: context.cardId, provider: context.profile.provider, prompt: job.prompt }) ?? null : null
      if (sk) job = { ...job, prompt: sk.prompt }
      // Implementation with Spec Kit: runs in the Spec Kit repository (where the skills and the feature are), with the other repositories unlocked.
      let impl: ReturnType<SpecKitRuntime['prepareImplementation']> = null
      if (!sk && context.chat.purpose === 'execution' && context.cardId) { try { impl = this.speckit?.prepareImplementation(context.cardId) ?? null } catch { impl = null } }
      const runCwd = sk?.cwd ?? impl?.cwd ?? cwd, adapterPlanning = job.planning && !sk
      this.conversations.updateRun(job.run.id, 'running', null)
      publish({ type: 'gearmod/run-started', payload: { cardId: context.cardId, chatId: job.chatId, planning: job.planning } })
      if (context.chat.purpose === 'free') this.conversations.setTitleIfEmpty(job.chatId, titleFromPrompt(job.prompt))
      if (constitution) this.conversations.setTitleIfEmpty(job.chatId, 'Constituição')
      const purpose = free || constitution ? null : context.chat.purpose as AgentPurpose
      const config = context.cardId && purpose ? this.configs?.resolve(context.cardId, context.profile.id, purpose) : undefined
      if (config && purpose) this.configs?.recordUse(config, purpose)
      const mcp = this.writeback?.begin(job.run.id, context.cardId, (type, payload) => publish({ type, payload }), { id: context.chat.id, purpose: context.chat.purpose })
      const prompt = this.agentContext ? await (constitution ? this.agentContext.constitutionPrompt(context.chat.projectId, job.prompt, context.chat.skill) : free || !context.cardId ? this.agentContext.freePrompt(job.prompt, context.chat.projectId, !job.planning, context.chat.skill) : this.agentContext.prompt(context.cardId, job.prompt, job.planning, context.chat.skill)) : job.prompt
      try { this.conversations.recordRunMeta(job.run.id, { purpose: context.chat.purpose, provider: context.profile.provider, model: config?.model ?? null, effort: config?.effort ?? null, promptChars: prompt.length }) } catch { /* metric is informational */ }
      // Registered MCP servers (global and project) for this agent; a failure to read them never takes the run down.
      let extraMcp: Awaited<ReturnType<McpRegistry['effective']>> = []
      if (this.mcpServers) { try { extraMcp = await this.mcpServers.effective(context.chat.projectId, context.profile.provider) } catch { /* the run continues without them */ } }
      const raw = await this.adapters[context.profile.provider].run({ cwd: runCwd, env: sk?.env ?? impl?.env, addDirs: impl?.addDirs, mcpServers: extraMcp, prompt, pluginDir: this.agentContext?.pluginDir, mcp, model: config?.model ?? job.choice?.model, effort: config?.effort ?? job.choice?.effort, mode: sk ? sk.mode : job.planning ? 'plan' : config?.mode ?? job.choice?.mode, developerInstructions: free ? this.agentContext?.freeInstructions(context.profile.provider === 'codex', !job.planning, context.chat.skill) : this.agentContext?.developerInstructions(job.planning, context.chat.skill, context.cardId, context.chat.purpose), sessionId: context.chat.providerSessionId, planning: adapterPlanning, attachments: job.attachments, profile: context.profile, signal: controller.signal, requestPermission: (kind, details, signal) => sk && this.speckit?.denies(details) ? Promise.resolve(false) : this.permissions.request({ runId: job.run.id, chatId: job.chatId, provider: context.profile.provider, kind, details }, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal, publish), onEvent: publish })
      if (this.stopping) return
      const result = timedOut ? { ...raw, status: 'failed' as const, error: timeoutError() } : raw
      this.conversations.updateSession(job.chatId, result.sessionId)
      try { this.conversations.recordEffectiveModel(job.run.id, result.modelEffective) } catch { /* metric is informational */ }
      try { this.conversations.recordUsage(job.run.id, result.usage) } catch { /* token count is informational */ }
      try { this.ledger?.recordRun(job.run.id, result.usage, result.status !== 'completed') } catch { /* ledger is informational; never takes the run down */ }
      if (result.apiKeySource) try { this.profiles?.recordBillingHint(context.profile.id, result.apiKeySource) } catch { /* hint is informational; it only suggests in the UI */ }
      if (result.text) this.conversations.addMessage({ chatId: job.chatId, role: 'assistant', body: result.text, status: result.status === 'completed' ? 'complete' : 'failed' })
      // The free chat may have become planning during the turn (gearmod_create_card tool): from here on the new card applies.
      const after = free ? this.conversations.context(job.chatId) : context
      const planned = job.planning || (free && after.chat.purpose === 'planning')
      const applied = this.writeback?.finish({ runId: job.run.id, cardId: after.cardId, planning: planned, completed: result.status === 'completed', text: result.text, prompt: job.prompt, publish: (type, payload) => publish({ type, payload }) })
      applied?.notices.forEach((body) => this.conversations.addMessage({ chatId: job.chatId, role: 'system', body, status: 'failed' }))
      // The version in `plans` is created when the user starts the run (approveCurrentPlan, from the Plan document); each planning turn no longer saves one.
      if (sk && result.status === 'completed' && after.cardId) { const next = this.speckit?.afterRun({ cardId: after.cardId, prompt: job.prompt }); if (next) this.conversations.addMessage({ chatId: job.chatId, role: 'system', body: next, status: 'complete' }) }
      if (result.status === 'failed' && !result.text && result.error) this.conversations.addMessage({ chatId: job.chatId, role: 'system', body: result.error, status: 'failed' })
      this.conversations.updateRun(job.run.id, result.status, result.error, result.turnId)
      publish({ type: 'gearmod/run-completed', payload: { chatId: job.chatId, status: result.status, error: result.error } })
      if (after.cardId && after.chat.purpose !== 'free' && after.chat.purpose !== 'constitution' && after.chat.purpose !== 'conflict' && this.harness) {
        try { (await this.harness.after({ cardId: after.cardId, runId: job.run.id, chatId: job.chatId, purpose: after.chat.purpose, status: result.status })).forEach((body) => this.conversations.addMessage({ chatId: job.chatId, role: 'system', body, status: 'failed' })) } catch { /* harness notice is best-effort */ }
      }
      try { if (after.cardId && after.chat.purpose !== 'free' && after.chat.purpose !== 'constitution' && after.chat.purpose !== 'conflict') this.collab?.afterRun({ cardId: after.cardId, chatId: job.chatId, purpose: after.chat.purpose, status: result.status }) } catch { /* chaining is best-effort; the chat shows the notice */ }
      try { this.onFinished?.({ cardId: after.cardId, chatId: job.chatId, runId: job.run.id, purpose: after.chat.purpose, status: result.status, error: result.error ?? null }) } catch { /* notification is best-effort */ }
    } catch (error) {
      if (this.stopping) return
      const message = timedOut ? timeoutError() : error instanceof Error ? error.message : String(error)
      const aborted = controller.signal.aborted && !timedOut
      // Without this the card was just left Paused, with no reason given (e.g. the worktree could not be created).
      if (!aborted) this.conversations.addMessage({ chatId: job.chatId, role: 'system', body: message, status: 'failed' })
      this.conversations.updateRun(job.run.id, aborted ? 'interrupted' : 'failed', message)
      publish({ type: 'gearmod/run-completed', payload: { chatId: job.chatId, status: aborted ? 'interrupted' : 'failed', error: message } })
      // A run that ends in error also closes the cycle: the harness checks what changed and chaining between steps continues.
      try {
        const after = this.conversations.context(job.chatId), status = aborted ? 'interrupted' as const : 'failed' as const
        if (after.cardId && after.chat.purpose !== 'free' && after.chat.purpose !== 'constitution' && after.chat.purpose !== 'conflict') {
          if (this.harness) try { (await this.harness.after({ cardId: after.cardId, runId: job.run.id, chatId: job.chatId, purpose: after.chat.purpose, status })).forEach((body) => this.conversations.addMessage({ chatId: job.chatId, role: 'system', body, status: 'failed' })) } catch { /* harness notice is best-effort */ }
          try { this.collab?.afterRun({ cardId: after.cardId, chatId: job.chatId, purpose: after.chat.purpose, status }) } catch { /* chaining is best-effort */ }
        }
      } catch { /* chat removed */ }
      try { const after = this.conversations.context(job.chatId); this.onFinished?.({ cardId: after.cardId, chatId: job.chatId, runId: job.run.id, purpose: after.chat.purpose, status: aborted ? 'interrupted' : 'failed', error: message }) } catch { /* notification is best-effort */ }
    } finally { this.permissions.closeRun(job.run.id); if (timer) clearTimeout(timer); this.controllers.delete(job.run.id) }
  }
}
