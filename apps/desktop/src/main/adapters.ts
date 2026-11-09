import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { resolveCommand } from './agents'
import type { AgentProfile, Effort, ModelOption, PermissionMode } from '@gearmod/contracts'
import { effortSchema } from '@gearmod/contracts'
import type { McpEndpoint } from './mcp-bridge'
import { claudeMcpServers, codexMcpServers, type McpRunServer } from './mcp-registry'
import type { ServerNotification } from './generated/codex-app-server/ServerNotification'
import type { ThreadStartParams } from './generated/codex-app-server/v2/ThreadStartParams'
import type { ReasoningEffort } from './generated/codex-app-server/ReasoningEffort'
import type { SandboxMode } from './generated/codex-app-server/v2/SandboxMode'
import type { AskForApproval } from './generated/codex-app-server/v2/AskForApproval'
import type { ApprovalsReviewer } from './generated/codex-app-server/v2/ApprovalsReviewer'
import type { TurnStartParams } from './generated/codex-app-server/v2/TurnStartParams'
import { redact, redactObject } from './redaction'
import { applyEnvPolicy } from './env-policy'
import { tm } from './i18n'

export type AgentEvent = { type: string; payload: Record<string, unknown> }
export type AgentRunOptions = { cwd: string; addDirs?: string[]; prompt: string; sessionId: string | null; planning: boolean; profile: AgentProfile; pluginDir?: string | null; env?: Record<string, string>; mcpServers?: McpRunServer[]; mcp?: McpEndpoint; model?: string | null; effort?: Effort | null; mode?: PermissionMode; developerInstructions?: string; attachments?: string[]; signal?: AbortSignal; requestPermission?(kind: string, details: Record<string, unknown>, signal?: AbortSignal): Promise<boolean>; onEvent(event: AgentEvent): void }
/** `costUsd`: only when the agent itself reports it (Claude: `total_cost_usd` from the result); never estimated here. */
export type RunTokens = { input: number; cached: number; output: number; costUsd?: number }
export type AgentRunResult = { sessionId: string; turnId: string | null; text: string; status: 'completed' | 'failed' | 'interrupted'; error: string | null; usage?: RunTokens; modelEffective?: string; apiKeySource?: string }
export interface AgentAdapter { run(options: AgentRunOptions): Promise<AgentRunResult> }

type JsonObject = Record<string, unknown>
export interface ProcessFactory { start(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams }
export const nodeProcesses: ProcessFactory = { start(command, args, options) {
  const executable = safeExecutable(command)
  if (process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(executable).toLowerCase())) {
    const commandLine = [executable, ...args].map((value) => `"${value.replace(/"/g, '""')}"`).join(' ')
    // Verbatim: without it Node escapes the quotes as `\"` and cmd.exe cannot find the program.
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], { ...options, windowsHide: true, shell: false, windowsVerbatimArguments: true })
  }
  return spawn(executable, args, { ...options, windowsHide: true, shell: false })
} }

class JsonLineRpc {
  private nextId = 1
  private readonly pending = new Map<number, { resolve(value: JsonObject): void; reject(error: Error): void }>()
  private readonly listeners: Array<(message: JsonObject) => void> = []
  private stderr = ''
  constructor(readonly process: ChildProcessWithoutNullStreams) {
    createInterface({ input: process.stdout }).on('line', (line) => this.receive(line))
    process.stderr.on('data', (chunk: Buffer) => { this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4000) })
    process.on('exit', (code) => {
      const error = new Error(`Agent process exited (${code}): ${sanitize(this.stderr)}`)
      this.failAll(error)
      this.listeners.forEach((listener) => listener({ method: 'error', params: { message: error.message } }))
    })
  }
  onMessage(listener: (message: JsonObject) => void): void { this.listeners.push(listener) }
  notify(method: string, params?: JsonObject): void { this.write(params ? { method, params } : { method }) }
  request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextId++
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.write({ id, method, params }) })
  }
  respond(id: string | number, result: JsonObject): void { this.write({ id, result }) }
  unsupported(id: string | number): void { this.write({ id, error: { code: -32601, message: 'Agent request not supported by GearMod' } }) }
  stop(): void { if (!this.process.killed) this.process.kill() }
  private write(value: JsonObject): void { if (!this.process.stdin.writable || this.process.stdin.destroyed) return; this.process.stdin.write(`${JSON.stringify(value)}\n`) }
  private receive(line: string): void {
    let message: JsonObject
    try { message = JSON.parse(line) as JsonObject } catch { return }
    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(sanitize(JSON.stringify(message.error))))
      else pending.resolve(message.result as JsonObject)
      return
    }
    this.listeners.forEach((listener) => listener(message))
  }
  private failAll(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear() }
}

const codexEfforts = new Set<string>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
/** Attachments that go to Codex as an image (it sees the content), besides the path in the text. */
const imageExtensions = /\.(png|jpe?g|gif|webp|bmp)$/i
/** Efforts GearMod knows; a new level from the provider is ignored instead of invalidating the whole model list. */
const knownEffort = (value: unknown): value is Effort => effortSchema.safeParse(value).success
/**
 * GearMod's tools already check who may call what (e.g. only the Constitution chat writes it). Without this, in read-only mode
 * (approval "never") Codex refuses every tool that writes, and the planning and Constitution chats could not save.
 */
export const gearmodToolApproval = { default_tools_approval_mode: 'approve' } as const

/** GearMod permission modes → Codex sandbox, approval policy and reviewer (plan 08, section 6). */
export function codexAccess(mode: PermissionMode): { sandbox: SandboxMode; approvalPolicy: AskForApproval; approvalsReviewer?: ApprovalsReviewer } {
  switch (mode) {
    case 'plan': return { sandbox: 'read-only', approvalPolicy: 'never' }
    case 'auto': return { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }
    case 'on_request': return { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' }
    case 'read_only': return { sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' }
    case 'bypass': return { sandbox: 'danger-full-access', approvalPolicy: 'never' }
    default: throw new Error(tm().adapters.unsupportedCodexMode(mode))
  }
}

/** GearMod modes → Claude's `--permission-mode`. */
export const claudePermissionMode: Record<PermissionMode, string | null> = { plan: 'plan', auto: 'auto', accept_edits: 'acceptEdits', manual: 'manual', on_request: null, read_only: null, bypass: 'bypassPermissions' }

export class CodexAppServerAdapter implements AgentAdapter {
  constructor(private readonly processes: ProcessFactory = nodeProcesses, private readonly timing = { graceMs: 60_000, pendingIdleMs: 10 * 60_000 }) {}
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    if (options.signal?.aborted) throw new Error(tm().common.executionCancelled)
    const child = this.processes.start(options.profile.executablePath || 'codex', ['app-server', '--listen', 'stdio://'], { cwd: options.cwd, env: { ...applyEnvPolicy(options.profile, process.env), CODEX_HOME: options.profile.configDir, ...options.env } })
    const rpc = new JsonLineRpc(child)
    const approvals = new ProviderApprovals(options)
    const abort = () => { approvals.close(); rpc.stop() }; options.signal?.addEventListener('abort', abort, { once: true })
    let text = '', turnId: string | null = null, modelEffective: string | undefined
    let turnAbort: (() => void) | undefined
    const items = new Map<string, JsonObject>()
    // Codex reports usage on every model call (`last`); sum only when the thread total changes, so a repeated report is not counted twice.
    const usage: RunTokens = { input: 0, cached: 0, output: 0 }; let lastTotal = -1
    try {
      await rpc.request('initialize', { clientInfo: { name: 'gearmod', title: 'GearMod', version: '0.1.0' }, capabilities: null })
      rpc.notify('initialized')
      const access = codexAccess(options.planning ? 'plan' : options.mode ?? 'auto')
      const policy = { cwd: options.cwd, ...access, ...(options.model ? { model: options.model } : {}), ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}), ...(options.mcp || options.mcpServers?.length ? { config: { mcp_servers: { ...codexMcpServers(options.mcpServers ?? []), ...(options.mcp ? { gearmod: { command: options.mcp.command, args: options.mcp.args, env: options.mcp.env, ...gearmodToolApproval } } : {}) } } } : {}) } satisfies ThreadStartParams
      const threadResult = options.sessionId
        ? await rpc.request('thread/resume', { threadId: options.sessionId, ...policy })
        : await rpc.request('thread/start', policy)
      const thread = threadResult.thread as { id: string }
      if (typeof (threadResult as Record<string, unknown>).model === 'string') modelEffective = (threadResult as Record<string, unknown>).model as string
      const completed = new Promise<AgentRunResult>((resolve, reject) => {
        const onAbort = turnAbort = () => resolve({ sessionId: thread.id, turnId, text, status: 'interrupted', error: 'Interrompido pelo usuário', usage: { ...usage } })
        options.signal?.addEventListener('abort', onAbort, { once: true })
        rpc.onMessage((raw) => {
          if (typeof raw.id === 'string' || typeof raw.id === 'number') {
            const id = raw.id, method = String(raw.method), params = (raw.params ?? {}) as JsonObject
            if ((params.threadId ?? params.conversationId) !== thread.id || (turnId && params.turnId && params.turnId !== turnId)) { rpc.unsupported(id); return }
            const permission = method === 'item/permissions/requestApproval'
            const modern = method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval'
            const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval'
            if (permission || modern || legacy) {
              approvals.ask(JSON.stringify(id), method, { ...params, ...(typeof params.itemId === 'string' && items.has(params.itemId) ? { item: items.get(params.itemId) } : {}) }, (allow) => {
                if (permission) {
                  const requested = (params.permissions ?? {}) as JsonObject
                  rpc.respond(id, { permissions: allow ? Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== null)) : {}, scope: 'turn' })
                } else rpc.respond(id, { decision: modern ? (allow ? 'accept' : 'decline') : (allow ? 'approved' : 'denied') })
              })
            } else rpc.unsupported(id)
            return
          }
          const event = raw as unknown as ServerNotification
          if (!('method' in event)) return
          const params = (event.params ?? {}) as unknown as Record<string, unknown>
          if (params.item && typeof params.item === 'object' && params.threadId === thread.id) { const item = params.item as JsonObject; if (typeof item.id === 'string') items.set(item.id, item) }
          if (event.method === 'item/agentMessage/delta') { const delta = String(params.delta ?? ''); text += delta; options.onEvent({ type: event.method, payload: { delta } }) }
          else options.onEvent({ type: event.method, payload: redactObject(params) })
          if (event.method === 'serverRequest/resolved' && params.threadId === thread.id) approvals.cancel(JSON.stringify(params.requestId))
          if (event.method === 'thread/tokenUsage/updated') {
            const token = params.tokenUsage as { total?: { totalTokens?: number }; last?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } } | undefined
            if (token?.last && token.total?.totalTokens !== lastTotal) {
              lastTotal = token.total?.totalTokens ?? lastTotal
              const cached = token.last.cachedInputTokens ?? 0
              usage.cached += cached; usage.input += Math.max(0, (token.last.inputTokens ?? 0) - cached); usage.output += token.last.outputTokens ?? 0
              options.onEvent({ type: 'tokens.update', payload: { input: Math.max(0, (token.last.inputTokens ?? 0) - cached), cached, output: token.last.outputTokens ?? 0 } })
            }
          }
          if (event.method === 'turn/completed' && params.threadId === thread.id) {
            approvals.close()
            const turn = params.turn as { id?: string; status?: string; error?: unknown }; turnId = turn.id ?? turnId
            const status = turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed'
            const turnModel = typeof (turn as Record<string, unknown>).model === 'string' ? (turn as Record<string, unknown>).model as string : undefined
            resolve({ sessionId: thread.id, turnId, text, status, error: status === 'failed' ? sanitize(JSON.stringify(turn.error ?? 'Turn failed')) : null, usage: { ...usage }, ...(turnModel ?? modelEffective ? { modelEffective: turnModel ?? modelEffective } : {}) })
          }
          if (event.method === 'error') reject(new Error(sanitize(JSON.stringify(params))))
        })
      })
      const turnParams: TurnStartParams = { threadId: thread.id, input: [{ type: 'text', text: options.prompt, text_elements: [] }, ...(options.attachments ?? []).filter((path) => imageExtensions.test(path)).map((path) => ({ type: 'localImage' as const, path }))], approvalPolicy: access.approvalPolicy, ...(access.approvalsReviewer ? { approvalsReviewer: access.approvalsReviewer } : {}), ...(options.model ? { model: options.model } : {}), ...(options.effort && codexEfforts.has(options.effort) ? { effort: options.effort as ReasoningEffort } : {}) }
      const started = await rpc.request('turn/start', turnParams as unknown as JsonObject)
      turnId = (started.turn as { id?: string } | undefined)?.id ?? null
      return await completed
    } finally { approvals.close(); if (turnAbort) options.signal?.removeEventListener('abort', turnAbort); options.signal?.removeEventListener('abort', abort); rpc.stop() }
  }
}

/** Lists Codex models through the app-server (`model/list`); a failure or timeout returns an empty list. */
export async function listCodexModels(profile: AgentProfile, processes: ProcessFactory = nodeProcesses, timeoutMs = 30_000): Promise<ModelOption[]> {
  try {
    const live = await listCodexModelsLive(profile, processes, timeoutMs)
    if (live.length) return live
  } catch (error) {
    const cached = readCodexModelsCache(profile)
    if (cached.length) return cached
    throw error
  }
  const cached = readCodexModelsCache(profile)
  if (cached.length) return cached
  throw new Error(tm().adapters.noCodexModels)
}

/** Official quota reading from the App Server; the caller keeps a fallback on the session files. */
export async function readCodexQuota(profile: AgentProfile, processes: ProcessFactory = nodeProcesses, timeoutMs = 15_000): Promise<Record<string, unknown> | null> {
  const child = processes.start(profile.executablePath || 'codex', ['app-server', '--listen', 'stdio://'], { cwd: process.cwd(), env: { ...applyEnvPolicy(profile, process.env), CODEX_HOME: profile.configDir } })
  const rpc = new JsonLineRpc(child); let timedOut = false
  const timer = setTimeout(() => { timedOut = true; rpc.stop() }, timeoutMs)
  try {
    await rpc.request('initialize', { clientInfo: { name: 'gearmod', title: 'GearMod', version: '0.1.0' }, capabilities: null })
    rpc.notify('initialized')
    return await rpc.request('account/rateLimits/read', {})
  } catch (error) { if (timedOut) return null; throw error } finally { clearTimeout(timer); rpc.stop() }
}

/** Plan B: Codex keeps the last catalog in `models_cache.json` inside CODEX_HOME. */
export function readCodexModelsCache(profile: AgentProfile): ModelOption[] {
  try {
    const raw = JSON.parse(readFileSync(join(profile.configDir || join(homedir(), '.codex'), 'models_cache.json'), 'utf8')) as { models?: Array<Record<string, unknown>> }
    return (raw.models ?? []).filter((item) => typeof item.slug === 'string' && item.visibility !== 'hide' && item.visibility !== 'none').map((item) => {
      const levels = (Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels : []) as Array<{ effort?: string } | string>
      const efforts = levels.map((level) => (typeof level === 'string' ? level : level.effort)).filter(knownEffort)
      return { id: item.slug as string, label: typeof item.display_name === 'string' ? item.display_name : (item.slug as string), description: typeof item.description === 'string' ? item.description : '', efforts, recommendedFor: [] as Array<'planning' | 'execution' | 'test'>, defaultEffort: knownEffort(item.default_reasoning_level) ? item.default_reasoning_level : efforts[0] ?? null }
    }).map((model, index) => ({ ...model, recommendedFor: index === 0 ? ['planning' as const, 'execution' as const] : [] }))
  } catch { return [] }
}

async function listCodexModelsLive(profile: AgentProfile, processes: ProcessFactory, timeoutMs: number): Promise<ModelOption[]> {
  const child = processes.start(profile.executablePath || 'codex', ['app-server', '--listen', 'stdio://'], { cwd: process.cwd(), env: { ...applyEnvPolicy(profile, process.env), CODEX_HOME: profile.configDir } })
  const rpc = new JsonLineRpc(child)
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; rpc.stop() }, timeoutMs)
  try {
    await rpc.request('initialize', { clientInfo: { name: 'gearmod', title: 'GearMod', version: '0.1.0' }, capabilities: null })
    rpc.notify('initialized')
    const result = await rpc.request('model/list', {}) as unknown as { data?: Array<{ model: string; displayName: string; description: string; hidden: boolean; isDefault: boolean; defaultReasoningEffort: Effort; supportedReasoningEfforts: Array<{ reasoningEffort: Effort }> }> }
    return (result.data ?? []).filter((model) => !model.hidden).map((model) => ({ id: model.model, label: model.displayName, description: model.description, efforts: model.supportedReasoningEfforts.map((item) => item.reasoningEffort).filter(knownEffort), recommendedFor: model.isDefault ? ['planning', 'execution'] as const : [], defaultEffort: knownEffort(model.defaultReasoningEffort) ? model.defaultReasoningEffort : null })).map((model) => ({ ...model, recommendedFor: [...model.recommendedFor] }))
  } catch (error) {
    throw timedOut ? new Error(tm().adapters.codexModelsTimeout) : error
  } finally { clearTimeout(timer); rpc.stop() }
}

/** Minimal call to Claude just to read the `rate_limit_event` (usage limit); ends the process as soon as the event arrives. */
export async function probeClaudeLimits(profile: AgentProfile, processes: ProcessFactory = nodeProcesses, timeoutMs = 90_000): Promise<Record<string, unknown> | null> {
  const child = processes.start(profile.executablePath || 'claude', ['--print', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--no-session-persistence', '--', 'responda apenas: ok'], { cwd: tmpdir(), env: { ...applyEnvPolicy(profile, process.env), CLAUDE_CONFIG_DIR: profile.configDir } })
  child.stdin.end()
  return new Promise((resolve) => {
    let done = false
    const finish = (value: Record<string, unknown> | null): void => { if (done) return; done = true; clearTimeout(timer); if (!child.killed) child.kill(); resolve(value) }
    const timer = setTimeout(() => finish(null), timeoutMs)
    createInterface({ input: child.stdout }).on('line', (line) => {
      try { const message = JSON.parse(line) as Record<string, unknown>; if (message.type === 'rate_limit_event') finish(message) } catch { /* line that is not JSON */ }
    })
    child.on('error', () => finish(null)); child.on('exit', () => finish(null))
  })
}

/** Asks Haiku (a cheap model) for a commit message for the changes; returns only the one-line summary. */
export async function suggestCommitMessage(profile: AgentProfile, context: string, processes: ProcessFactory = nodeProcesses, timeoutMs = 60_000): Promise<string> {
  const child = processes.start(profile.executablePath || 'claude', ['--print', '--output-format', 'text', '--model', 'haiku', '--no-session-persistence'], { cwd: tmpdir(), env: { ...applyEnvPolicy(profile, process.env), CLAUDE_CONFIG_DIR: profile.configDir } })
  child.stdin.end(`Escreva a mensagem de commit destas alterações. Responda só com UMA linha (até 72 caracteres), sem aspas, sem ponto final, sem explicação, no mesmo idioma e estilo dos commits recentes.

${context}`)
  return new Promise((resolve, reject) => {
    let out = '', done = false
    const finish = (error?: Error): void => { if (done) return; done = true; clearTimeout(timer); if (!child.killed) child.kill(); const line = out.split(/\r?\n/).map((item) => item.trim()).find(Boolean)?.replace(/^["'`]+|["'`]+$/g, '') ?? ''; if (error) reject(error); else if (line) resolve(line.slice(0, 200)); else reject(new Error(tm().adapters.commitSuggestEmpty)) }
    const timer = setTimeout(() => finish(new Error(tm().adapters.commitSuggestTimeout)), timeoutMs)
    child.stdout.on('data', (chunk: Buffer | string) => { out += chunk.toString() })
    child.on('error', (error: Error) => finish(error)); child.on('exit', (code: number | null) => finish(code ? new Error(out.trim().slice(0, 300) || tm().adapters.commitSuggestEmpty) : undefined))
  })
}

export class ClaudeCliAdapter implements AgentAdapter {
  constructor(private readonly processes: ProcessFactory = nodeProcesses, private readonly timing = { graceMs: 60_000, pendingIdleMs: 10 * 60_000 }) {}
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    if (options.signal?.aborted) throw new Error(tm().common.executionCancelled)
    // In `plan` mode Claude refuses to call tools that write (including GearMod's; confirmed in a real test).
    // With MCP on, planning uses the default mode with read-only tools plus GearMod's; without MCP, `plan` and documents via markers.
    const readOnlyPlanning = options.planning && Boolean(options.mcp)
    const executionMode = claudePermissionMode[options.mode ?? 'accept_edits']
    if (!options.planning && !executionMode) throw new Error(tm().adapters.unsupportedClaudeMode(String(options.mode)))
    const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', options.planning ? (readOnlyPlanning ? 'default' : 'plan') : executionMode!]
    if (options.model) args.push('--model', options.model)
    if (options.effort) args.push('--effort', options.effort)
    if (readOnlyPlanning) args.push('--tools', 'Read,Grep,Glob,WebSearch,WebFetch')
    if (options.pluginDir) args.push('--plugin-dir', options.pluginDir)
    // The MCP config carries env and headers (secrets): it goes through a temporary file, not the command line, which shows up in the process list.
    let mcpConfigDir: string | null = null
    if (options.mcp || options.mcpServers?.length) {
      mcpConfigDir = mkdtempSync(join(tmpdir(), 'gearmod-mcp-'))
      const file = join(mcpConfigDir, 'mcp.json')
      writeFileSync(file, JSON.stringify({ mcpServers: { ...claudeMcpServers(options.mcpServers ?? []), ...(options.mcp ? { gearmod: { command: options.mcp.command, args: options.mcp.args, env: options.mcp.env } } : {}) } }), { mode: 0o600 })
      args.push('--mcp-config', file)
    }
    if (options.mcp) args.push('--allowedTools', 'mcp__gearmod')
    if (options.sessionId) args.push('--resume', options.sessionId)
    // Attachments outside the project folder: allow reading each one's folder.
    for (const dir of new Set([...(options.attachments ?? []).map((path) => dirname(path)), ...(options.addDirs ?? [])])) args.push('--add-dir', dir)
    const interactive = Boolean(options.requestPermission)
    if (interactive) args.push('--input-format', 'stream-json', '--permission-prompt-tool', 'stdio')
    else args.push('--', options.prompt)
    const child = this.processes.start(options.profile.executablePath || 'claude', args, { cwd: options.cwd, env: { ...applyEnvPolicy(options.profile, process.env), CLAUDE_CONFIG_DIR: options.profile.configDir, ...options.env } })
    const approvals = new ProviderApprovals(options)
    if (!interactive) child.stdin.end()
    let text = '', sessionId = options.sessionId ?? '', stderr = '', apiKeySource: string | undefined
    const abort = () => { approvals.close(); child.kill() }; options.signal?.addEventListener('abort', abort, { once: true })
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-4000) })
    return new Promise<AgentRunResult>((resolve, reject) => {
      // Background tasks (subagents and commands): the turn's `result` arrives while they are still running. The process can only exit when all of them
      // finish and Claude answers their notification (another `result`); if it does not answer, the last result counts after a grace period.
      const pending = new Set<string>(), { graceMs: grace, pendingIdleMs } = this.timing
      let answered = false, deferred: AgentRunResult | null = null, graceTimer: NodeJS.Timeout | undefined, idleTimer: NodeJS.Timeout | undefined
      const finish = (result: AgentRunResult): void => { if (graceTimer) clearTimeout(graceTimer); if (idleTimer) clearTimeout(idleTimer); resolve(result) }
      // Background task that never reports it finished (task_started without task_notification): with no activity for `pendingIdleMs`, the turn's result counts.
      const armIdle = (): void => { if (!deferred) return; if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (deferred) { const last = deferred; child.kill(); finish(last) } }, pendingIdleMs) }
      const settle = (): void => { if (deferred && !pending.size && !graceTimer) { const last = deferred; graceTimer = setTimeout(() => finish(last), grace) } }
      createInterface({ input: child.stdout }).on('line', (line) => {
        let message: JsonObject; try { message = JSON.parse(line) as JsonObject } catch { return }
        if (message.type === 'control_request' && typeof message.request_id === 'string') {
          const id = message.request_id, request = (message.request ?? {}) as JsonObject
          const respond = (allow: boolean): void => { if (!child.stdin.writable || child.stdin.destroyed) return; child.stdin.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: allow ? { behavior: 'allow', updatedInput: request.input ?? {} } : { behavior: 'deny', message: 'Permission denied by the user or the run has ended' } } })}\n`) }
          if (request.subtype === 'can_use_tool') approvals.ask(id, String(request.tool_name ?? 'Ferramenta'), request, respond)
          else child.stdin.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Request not supported' } })}\n`)
          return
        }
        if (message.type === 'control_cancel_request' && typeof message.request_id === 'string') { approvals.cancel(message.request_id); return }
        if (typeof message.session_id === 'string') sessionId = message.session_id
        armIdle()
        if (message.type === 'system' && message.subtype === 'init' && typeof message.apiKeySource === 'string') apiKeySource = message.apiKeySource
        const event = message.event as JsonObject | undefined, delta = event?.delta as JsonObject | undefined
        if (message.type === 'stream_event' && delta?.type === 'text_delta' && typeof delta.text === 'string') { text += delta.text; options.onEvent({ type: 'item/agentMessage/delta', payload: { delta: delta.text } }) }
        else options.onEvent({ type: `claude/${String(message.type ?? 'event')}`, payload: redactObject(message) })
        if (message.type === 'system' && typeof message.task_id === 'string') {
          if (message.subtype === 'task_started') pending.add(message.task_id)
          else if (message.subtype === 'task_notification') { pending.delete(message.task_id); settle() }
        }
        // Claude answering the notification starts a new turn: wait for its `result` instead of closing the run in the middle of it (the idle timer still applies).
        const taskBookkeeping = message.type === 'system' && (typeof message.task_id === 'string' || message.subtype === 'background_tasks_changed')
        if (graceTimer && message.type !== 'result' && !taskBookkeeping) { clearTimeout(graceTimer); graceTimer = undefined }
        // Resuming a session whose background command died emits an empty `result` (0 turns) for that stale notification, before our prompt is
        // read: closing the run on it killed the process and the user's message was never answered. Only a result after Claude started answering counts.
        if (message.type === 'assistant' || message.type === 'stream_event') answered = true
        if (message.type === 'result' && message.num_turns === 0 && !answered && !message.is_error) return
        if (message.type === 'result') {
          if (graceTimer) { clearTimeout(graceTimer); graceTimer = undefined }
          approvals.close()
          if (!text && typeof message.result === 'string') text = message.result
          const modelEffective = typeof message.model === 'string' ? message.model : typeof (message.result as JsonObject | undefined)?.model === 'string' ? (message.result as JsonObject).model as string : undefined
          const result: AgentRunResult = { sessionId, turnId: null, text, status: message.is_error ? 'failed' : 'completed', error: message.is_error ? sanitize(String(message.result ?? 'Claude failed')) : null, usage: claudeUsage(message.usage, message.total_cost_usd), ...(modelEffective ? { modelEffective } : {}), ...(apiKeySource ? { apiKeySource } : {}) }
          if (pending.size && !message.is_error) { deferred = result; armIdle() }
          else finish(result)
        }
      })
      child.on('error', (error) => reject(error))
      child.on('exit', (code) => { if (deferred && !options.signal?.aborted) { finish(deferred); return } if (options.signal?.aborted) resolve({ sessionId, turnId: null, text, status: 'interrupted', error: 'Interrompido pelo usuário' }); else reject(new Error(`Claude encerrou sem resultado (${code}): ${sanitize(stderr)}`)) })
      if (interactive) child.stdin.write(`${JSON.stringify({ type: 'user', session_id: '', message: { role: 'user', content: options.prompt }, parent_tool_use_id: null })}\n`)
      if (options.signal?.aborted) abort()
    }).finally(() => { approvals.close(); options.signal?.removeEventListener('abort', abort); if (!child.killed) child.kill(); if (mcpConfigDir) rmSync(mcpConfigDir, { recursive: true, force: true }) })
  }
}

/** Usage reported in Claude's `result`: what was created in the cache counts as new reads; cache reads are kept separate. */
function claudeUsage(value: unknown, cost?: unknown): RunTokens | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>, count = (key: string): number => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? Math.max(0, Math.round(usage[key] as number)) : 0)
  return { input: count('input_tokens') + count('cache_creation_input_tokens'), cached: count('cache_read_input_tokens'), output: count('output_tokens'), ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}) }
}
function sanitize(value: string): string { return redact(value) }

function safeExecutable(command: string): string {
  if (process.platform !== 'win32') return command
  command = resolveCommand(command, process.env)
  if (isAbsolute(command)) {
    if (!['.exe', '.cmd', '.bat'].includes(extname(command).toLowerCase())) throw new Error(tm().adapters.windowsExecutableRequired)
    return command
  }
  const folders = (process.env.PATH ?? '').split(delimiter)
  for (const extension of ['.exe', '.cmd', '.bat']) {
    for (const folder of folders) {
      const candidate = join(folder, `${command}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error(tm().adapters.safeExecutableNotFound(command))
}

/** Responses are synchronous on close, before killing the provider process; late UI replies cannot write. */
class ProviderApprovals {
  private readonly pending = new Map<string, (allow: boolean, send?: boolean) => void>()
  private closed = false
  constructor(private readonly options: AgentRunOptions) {}
  ask(id: string, kind: string, details: JsonObject, respond: (allow: boolean) => void): void {
    if (this.closed || this.options.signal?.aborted || !this.options.requestPermission) { respond(false); return }
    if (this.pending.has(id)) return
    const controller = new AbortController()
    const finish = (allow: boolean, send = true): void => { if (!this.pending.delete(id)) return; if (send) respond(allow); controller.abort() }
    this.pending.set(id, finish)
    void this.options.requestPermission(kind, redactObject(details), controller.signal).then(finish, () => finish(false))
  }
  cancel(id: string): void { this.pending.get(id)?.(false, false) }
  close(): void { this.closed = true; for (const finish of this.pending.values()) finish(false) }
}
