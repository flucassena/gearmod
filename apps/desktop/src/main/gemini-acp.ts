import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname } from 'node:path'
import type { PermissionMode } from '@gearmod/contracts'
import { applyEnvPolicy } from './env-policy'
import { redact, redactObject } from './redaction'
import type { McpRunServer } from './mcp-registry'
import type { AgentRunOptions, AgentRunResult, ProcessFactory, RunTokens } from './adapters'
import { resolveCommand } from './agents'
import { tm } from './i18n'

/**
 * Antigravity CLI (`agy acp`, Agent Client Protocol v1, JSON-RPC 2.0 as lines over stdio). Every GearMod mode runs here: the mode is
 * set per session (`session/set_mode`), the model with `session/set_config_option`, and each pending action reaches GearMod's
 * permissions screen through `session/request_permission`. Real captures: docs/ANTIGRAVITY-ACP.md.
 * The login is the user's (one Google account per Windows user, kept in the OS credential store); the app never calls `authenticate`.
 */
type Json = Record<string, unknown>
const asObject = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {})

/**
 * GearMod mode → Antigravity session mode. Automatic modes run with `--dangerously-skip-permissions` instead (see `acpArgs`).
 * Modes of other agents (read only, on request) fall back to `default`, which asks before commands.
 */
export const antigravityMode: Partial<Record<PermissionMode, string>> = { plan: 'plan', manual: 'default', accept_edits: 'accept-edits', auto: 'default', bypass: 'default' }
const skipsPermissions = (mode: PermissionMode | undefined): boolean => mode === 'auto' || mode === 'bypass'

/** Command-line arguments: `acp`, the extra folders (attachments and worktree extras) and, in automatic mode, no permission prompts. */
export function acpArgs(options: Pick<AgentRunOptions, 'attachments' | 'addDirs' | 'mode' | 'planning'>): string[] {
  const args = ['acp']
  if (!options.planning && skipsPermissions(options.mode)) args.push('--dangerously-skip-permissions')
  for (const dir of new Set([...(options.addDirs ?? []), ...(options.attachments ?? []).map((path) => dirname(path))])) args.push('--add-dir', dir)
  return args
}

/** MCP servers in the `session/new` format: stdio has no `type`; http carries `type: "http"`; env and headers are name/value lists. */
export function acpMcpServers(servers: McpRunServer[], gearmod?: { command: string; args: string[]; env: Record<string, string> }): Json[] {
  const pairs = (record: Record<string, string>): Array<{ name: string; value: string }> => Object.entries(record).map(([name, value]) => ({ name, value }))
  const all: Json[] = servers.map((server) => server.transport === 'stdio'
    ? { name: server.name, command: server.command, args: server.args, env: pairs(server.env) }
    : { type: server.sse ? 'sse' : 'http', name: server.name, url: server.url, headers: pairs(server.headers) })
  if (gearmod) all.unshift({ name: 'gearmod', command: gearmod.command, args: gearmod.args, env: pairs(gearmod.env) })
  return all
}

/** Picks the option for the request: approve uses "once" (never "always"); deny uses "reject once". With no matching option, it cancels. */
export function acpPermissionOutcome(options: unknown, allow: boolean): Json {
  const list = (Array.isArray(options) ? options : []).map(asObject)
  const pick = (...kinds: string[]): Json | undefined => kinds.map((kind) => list.find((item) => item.kind === kind)).find(Boolean)
  const chosen = allow ? pick('allow_once') : pick('reject_once', 'reject_always')
  return chosen && typeof chosen.optionId === 'string' ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' }
}

/** Request details in the format the permissions screen already understands (command, description, file). Antigravity names the fields `CommandLine` and `Path`. */
export function acpPermissionDetails(params: Json): Json {
  const call = asObject(params.toolCall), input = asObject(call.rawInput)
  const locations = (Array.isArray(call.locations) ? call.locations : []).map(asObject).map((item) => item.path).filter((value): value is string => typeof value === 'string')
  const text = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === 'string' && value.length > 0)
  const path = text(locations[0], input.Path, input.AbsolutePath, input.TargetFile, input.path)
  return redactObject({ title: call.title, toolKind: call.kind, input, command: text(input.command, input.CommandLine), description: text(input.description, input.toolSummary, call.title), ...(path ? { path } : {}), options: params.options })
}

/** Tool input with the names the chat already reads (`file_path`, `command`) added next to Antigravity's own (`Path`, `CommandLine`). */
export function toolParameters(rawInput: unknown): Json {
  const input = asObject(rawInput)
  const file = [input.Path, input.AbsolutePath, input.TargetFile].find((value) => typeof value === 'string')
  return { ...input, ...(file && input.file_path === undefined ? { file_path: file } : {}), ...(typeof input.CommandLine === 'string' && input.command === undefined ? { command: input.CommandLine } : {}) }
}

/** Usage of the turn (`session/prompt` result): `inputTokens` already excludes the cache read; thinking is inside `outputTokens`. */
export function antigravityUsage(usage: unknown): RunTokens | undefined {
  const data = asObject(usage)
  if (!Object.keys(data).length) return undefined
  const count = (key: string): number => (typeof data[key] === 'number' && Number.isFinite(data[key]) ? Math.max(0, Math.round(data[key] as number)) : 0)
  return { input: count('inputTokens'), cached: count('cachedReadTokens'), output: count('outputTokens') }
}

/** Options of a `select` config option (`model`, `thought_level`) as announced by `session/new`. */
function selectValues(configOptions: unknown, id: string): string[] {
  const option = (Array.isArray(configOptions) ? configOptions : []).map(asObject).find((item) => item.id === id)
  return (Array.isArray(option?.options) ? option.options : []).map(asObject).map((item) => item.value).filter((value): value is string => typeof value === 'string')
}

/**
 * Model value to send, among the ones the account offers. `auto`/empty keeps the account default; the short ids saved by older
 * Gemini CLI profiles (`pro`, `flash`, `flash-lite`) map to the closest Gemini model listed. Unknown → null (keeps the default).
 */
export function antigravityModel(requested: string | null | undefined, available: string[]): string | null {
  if (!requested || requested === 'auto') return null
  if (available.includes(requested)) return requested
  const gemini = available.filter((value) => value.startsWith('gemini'))
  if (requested === 'pro') return gemini.find((value) => value.includes('pro')) ?? null
  if (requested === 'flash' || requested === 'flash-lite') return gemini.find((value) => value.includes('flash')) ?? null
  return available.find((value) => value.startsWith(requested)) ?? null
}

const isAuthError = (error: unknown): boolean => (error as { code?: unknown })?.code === -32000 || /authenticat|login|credential|sign.?in/i.test(error instanceof Error ? error.message : String(error))

export async function runGeminiAcp(processes: ProcessFactory, options: AgentRunOptions): Promise<AgentRunResult> {
  const env: NodeJS.ProcessEnv = { ...applyEnvPolicy(options.profile, process.env), ...options.env }
  // Profiles created for the old Gemini CLI may still hold its path: only an `agy` path is used as is.
  const saved = options.profile.executablePath
  const command = saved && /(^|[\\/])agy(\.exe)?$/i.test(saved) ? saved : resolveCommand('agy', env)
  const child: ChildProcessWithoutNullStreams = processes.start(command, acpArgs(options), { cwd: options.cwd, env })
  let nextId = 1, stderr = '', text = '', sessionId = options.sessionId ?? '', replaying = false, ended = false, modelEffective: string | undefined
  const pending = new Map<number, { resolve(value: Json): void; reject(error: Error): void }>()
  const write = (message: Json): void => { if (child.stdin.writable && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
  const request = (method: string, params: Json): Promise<Json> => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); write({ id, method, params }) })
  const failAll = (error: Error): void => { for (const item of pending.values()) item.reject(error); pending.clear() }
  child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-4000) })
  child.stdin.on('error', () => undefined)
  child.on('error', (error) => failAll(error))
  child.on('exit', (code) => { if (!ended) failAll(new Error(tm().adapters.geminiExited(code, redact(stderr)))) })
  // Permission requests in flight: on cancel, all of them are answered as "cancelled" (protocol requirement).
  const open = new Map<string, { kind: unknown; allow(): void; cancel(): void }>()
  const abort = (): void => { for (const entry of [...open.values()]) entry.cancel(); if (sessionId) write({ method: 'session/cancel', params: { sessionId } }) }
  // Mode changed while running: what the new mode would not ask for goes through without asking (also what was already waiting).
  let liveMode: PermissionMode | null = null
  const coveredByMode = (kind: unknown): boolean => liveMode === 'auto' || liveMode === 'bypass' || (liveMode === 'accept_edits' && kind === 'edit')
  options.signal?.addEventListener('abort', abort, { once: true })
  const trackModel = (configOptions: unknown): void => { const model = (Array.isArray(configOptions) ? configOptions : []).map(asObject).find((item) => item.id === 'model'); if (typeof model?.currentValue === 'string') modelEffective = model.currentValue }

  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: Json; try { message = JSON.parse(line) as Json } catch { return }
    const id = message.id, method = message.method
    if (typeof method !== 'string') {
      const key = typeof id === 'number' ? id : Number(id)
      const waiting = pending.get(key)
      if (!waiting) return
      pending.delete(key)
      const error = asObject(message.error)
      if (message.error) waiting.reject(Object.assign(new Error(redact(String(error.message ?? tm().adapters.geminiError))), { code: error.code }))
      else waiting.resolve(asObject(message.result))
      return
    }
    const params = asObject(message.params)
    if (method === 'session/update') {
      const update = asObject(params.update), kind = String(update.sessionUpdate ?? '')
      if (kind === 'config_option_update') trackModel(update.configOptions)
      if (replaying) return
      if (kind === 'agent_message_chunk') {
        const content = asObject(update.content)
        if (content.type === 'text' && typeof content.text === 'string') { text += content.text; options.onEvent({ type: 'item/agentMessage/delta', payload: { delta: content.text } }) }
      } else if (kind === 'tool_call') options.onEvent({ type: 'gemini/tool_use', payload: redactObject({ tool_name: update.name ?? update.title ?? update.kind ?? 'ferramenta', tool_kind: update.kind, tool_id: update.toolCallId, parameters: toolParameters(update.rawInput) }) })
      else if (kind === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed')) options.onEvent({ type: 'gemini/tool_result', payload: redactObject({ tool_id: update.toolCallId, status: update.status === 'failed' ? 'error' : 'success' }) })
      return
    }
    if (method === 'session/request_permission' && id !== undefined) {
      // Antigravity numbers its own requests with text ids ("1"): answer with the id exactly as received.
      // Answered once: by the user, by a mode change, or as cancelled. The screen's request is closed when the answer did not come from it.
      const control = new AbortController(), key = String(id)
      const answer = (outcome: Json): void => { if (!open.delete(key)) return; write({ id, result: { outcome } }); control.abort() }
      const entry = { kind: asObject(params.toolCall).kind, allow: () => answer(acpPermissionOutcome(params.options, true)), cancel: () => answer({ outcome: 'cancelled' }) }
      open.set(key, entry)
      const ask = options.requestPermission
      if (coveredByMode(entry.kind)) { entry.allow(); return }
      if (!ask) { answer(acpPermissionOutcome(params.options, false)); return }
      void ask('gemini/permission', acpPermissionDetails(params), control.signal).then((allow) => answer(acpPermissionOutcome(params.options, allow)), entry.cancel)
      return
    }
    // Any other agent request (file system, terminal…) was not announced in the capabilities: clear refusal.
    if (id !== undefined) write({ id, error: { code: -32601, message: 'Method not supported by GearMod' } })
  })

  const finish = (result: AgentRunResult): AgentRunResult => { ended = true; options.signal?.removeEventListener('abort', abort); try { child.stdin.end() } catch { /* already closed */ } if (!child.killed) child.kill(); return { ...result, ...(modelEffective ? { modelEffective } : {}) } }
  const interrupted = (): AgentRunResult => finish({ sessionId, turnId: null, text, status: 'interrupted', error: 'Interrompido pelo usuário' })
  const servers = acpMcpServers(options.mcpServers ?? [], options.mcp)
  try {
    if (options.signal?.aborted) return interrupted()
    const init = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } })
    const canLoad = asObject(init.agentCapabilities).loadSession === true
    let session: Json
    try {
      if (sessionId && canLoad) { replaying = true; try { session = await request('session/load', { sessionId, cwd: options.cwd, mcpServers: servers }) } finally { replaying = false } }
      else { session = await request('session/new', { cwd: options.cwd, mcpServers: servers }); sessionId = String(session.sessionId ?? '') }
    } catch (error) {
      if (isAuthError(error)) throw new Error(tm().adapters.antigravityLogin)
      throw error
    }
    trackModel(session.configOptions)
    options.onEvent({ type: 'gemini/init', payload: { session_id: sessionId } })
    const mode = options.planning ? 'plan' : antigravityMode[options.mode ?? 'manual'] ?? 'default'
    if (mode !== 'default') await request('session/set_mode', { sessionId, modeId: mode })
    const model = antigravityModel(options.model, selectValues(session.configOptions, 'model'))
    if (options.model && options.model !== 'auto' && !model) options.onEvent({ type: 'gemini/warning', payload: { message: tm().adapters.antigravityModelMissing(options.model) } })
    if (model && model !== modelEffective) await request('session/set_config_option', { sessionId, configId: 'model', value: model })
    if (options.effort && selectValues(session.configOptions, 'thought_level').includes(options.effort)) await request('session/set_config_option', { sessionId, configId: 'thought_level', value: options.effort })
    // Live mode switch: `session/set_mode` on the open session. A run started in an automatic mode has permissions skipped by flag,
    // which cannot be undone mid-run: that switch (like plan) is refused and the new mode applies on the next turn.
    if (options.requestPermission && !options.planning && !skipsPermissions(options.mode)) options.onModeControl?.((next) => {
      const target = antigravityMode[next]
      if (ended || next === 'plan' || !target) return false
      liveMode = next
      void request('session/set_mode', { sessionId, modeId: target }).catch(() => undefined)
      for (const entry of [...open.values()]) if (coveredByMode(entry.kind)) entry.allow()
      return true
    })
    const prompt = `${options.developerInstructions ? `${options.developerInstructions}\n\n` : ''}${options.prompt}`
    const done = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] })
    const stop = String(done.stopReason ?? 'end_turn'), usage = antigravityUsage(done.usage)
    if (stop === 'cancelled') return finish({ sessionId, turnId: null, text, status: 'interrupted', error: 'Interrompido pelo usuário', ...(usage ? { usage } : {}) })
    if (stop === 'refusal') return finish({ sessionId, turnId: null, text, status: 'failed', error: tm().adapters.antigravityRefusal, ...(usage ? { usage } : {}) })
    return finish({ sessionId, turnId: null, text, status: 'completed', error: null, ...(usage ? { usage } : {}) })
  } catch (error) {
    if (options.signal?.aborted) return interrupted()
    return finish({ sessionId, turnId: null, text, status: 'failed', error: redact(error instanceof Error ? error.message : String(error)) })
  }
}
