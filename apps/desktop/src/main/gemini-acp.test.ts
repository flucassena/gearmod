import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { AgentProfile } from '@gearmod/contracts'
import { GeminiCliAdapter } from './gemini-adapter'
import { acpArgs, acpMcpServers, acpPermissionDetails, acpPermissionOutcome, antigravityModel, antigravityUsage, toolParameters } from './gemini-acp'
import { antigravityEmail, antigravityTier } from './antigravity-auth'
import { toolEditedFiles } from './tool-activity'
import type { ProcessFactory } from './adapters'

type Json = Record<string, unknown>
const profile = { id: '10000000-0000-4000-8000-000000000001', provider: 'gemini', label: 'Antigravity', scope: 'w', color: '#7BA7FF', configDir: 'C:\\profiles\\gemini', executablePath: 'C:\\agy\\bin\\agy.exe', enabled: true, billingMode: 'subscription', envPassthrough: [], createdAt: '', updatedAt: '' } as unknown as AgentProfile

/**
 * Fake `agy acp` that replays a real capture (fixtures/antigravity, recorded with agy 1.5.5): each client request receives the
 * agent messages recorded after the same request, with the response ids translated. Emission pauses after a permission request
 * until the client answers it, like the real agent.
 */
function replay(name: string, seen: { command?: string; args?: string[]; log: Json[] }): ProcessFactory {
  const records = readFileSync(fileURLToPath(new URL(`./fixtures/antigravity/${name}.jsonl`, import.meta.url)), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { dir: string; msg: Json })
  const segments: Array<{ method: string; id: unknown; messages: Json[] }> = []
  for (const record of records) {
    if (record.dir === 'out' && typeof record.msg.method === 'string') segments.push({ method: record.msg.method, id: record.msg.id, messages: [] })
    else if (record.dir === 'in' && segments.length) segments[segments.length - 1]!.messages.push(record.msg)
  }
  return { start(command, args) {
    seen.command = command; seen.args = args
    const emitter = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    Object.assign(emitter, { stdin, stdout, stderr, killed: false, kill() { return true } })
    const ids = new Map<unknown, unknown>()
    const queue: Json[] = []
    let waitingFor: unknown
    const pump = (): void => {
      while (queue.length) {
        const message = queue.shift()!
        const out = message.method === undefined && ids.has(message.id) ? { ...message, id: ids.get(message.id) } : message
        stdout.write(`${JSON.stringify(out)}\n`)
        if (message.method === 'session/request_permission') { waitingFor = message.id; return }
      }
    }
    let buffer = ''
    stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      for (const line of lines.filter((item) => item.trim())) {
        const message = JSON.parse(line) as Json; seen.log.push(message)
        if (message.method === undefined) { if (waitingFor !== undefined && message.id === waitingFor) { waitingFor = undefined; pump() } continue }
        const index = segments.findIndex((segment) => segment.method === message.method)
        if (index < 0) { if (message.id !== undefined) stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`); continue }
        const [segment] = segments.splice(index, 1)
        if (segment!.id !== undefined) ids.set(segment!.id, message.id)
        queue.push(...segment!.messages)
        if (waitingFor === undefined) pump()
      }
    })
    return emitter as ChildProcessWithoutNullStreams
  } }
}
const run = (name: string, extra: Json = {}, seen = { log: [] as Json[] } as { command?: string; args?: string[]; log: Json[] }) =>
  new GeminiCliAdapter(replay(name, seen)).run({ cwd: 'C:\\repo', prompt: 'faça X', sessionId: null, planning: false, mode: 'manual', profile, onEvent: () => undefined, requestPermission: async () => true, ...extra } as never).then((result) => ({ result, seen }))
const methods = (log: Json[]): unknown[] => log.map((message) => message.method).filter(Boolean)

describe('Antigravity over ACP (real captures, agy 1.5.5)', () => {
  it('runs `agy acp`, opens a session, streams the answer and reads the usage of the turn', async () => {
    const events: Array<{ type: string; payload: Json }> = []
    const { result, seen } = await run('basic', { onEvent: (event: { type: string; payload: Json }) => events.push(event) })
    expect(seen.command).toBe('C:\\agy\\bin\\agy.exe')
    expect(seen.args).toEqual(['acp'])
    expect(methods(seen.log)).toEqual(['initialize', 'session/new', 'session/prompt'])
    expect(result).toMatchObject({ sessionId: 'f464581d-d3ce-4435-a7dc-ef4586503e3d', status: 'completed', error: null, modelEffective: 'gemini-3.8-flash', usage: { input: 17117, cached: 0, output: 486 } })
    expect(result.text).toContain('oi.txt')
    const tool = events.find((event) => event.type === 'gemini/tool_use')!
    expect(tool.payload).toMatchObject({ tool_name: 'write_file', tool_kind: 'edit' })
    expect(toolEditedFiles(tool.type, tool.payload)[0]).toMatch(/oi\.txt$/)
  })

  it('asks the user about the command and answers with the text id the agent used ("deny")', async () => {
    const asked: Json[] = []
    const { result, seen } = await run('deny', { requestPermission: async (_kind: string, details: Json) => { asked.push(details); return false } })
    expect(asked[0]).toMatchObject({ title: 'git init', toolKind: 'execute', command: 'git init' })
    expect(seen.log.find((message) => message.id === '1')).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'deny' } } })
    expect(result.status).toBe('completed')
  })

  it('approving picks "allow" (allow_once)', async () => {
    const { seen } = await run('deny', { requestPermission: async () => true })
    expect(seen.log.find((message) => message.id === '1')).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'allow' } } })
  })

  it('without a permission channel the request is denied', async () => {
    const { seen } = await run('deny', { requestPermission: undefined })
    expect(seen.log.find((message) => message.id === '1')).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'deny' } } })
  })

  it('sends MCP servers in session/new and the agent uses them', async () => {
    const { result, seen } = await run('mcp', { mcp: { command: 'node', args: ['gearmod.mjs'], env: {} }, mcpServers: [{ name: 'teste', transport: 'stdio', command: 'node', args: ['mcp-ping.mjs'], env: {} }] })
    const created = seen.log.find((message) => message.method === 'session/new')!.params as { mcpServers: Json[] }
    expect(created.mcpServers.map((server) => server.name)).toEqual(['gearmod', 'teste'])
    expect(result.text).toBe('PONG-7731')
  })

  it('cancel: sends session/cancel and the turn ends as interrupted', async () => {
    const controller = new AbortController()
    // As in the capture: the user cancels right after the prompt went out, before any text.
    const { result, seen } = await run('cancel', { signal: controller.signal, onEvent: (event: { type: string }) => { if (event.type === 'gemini/init') setTimeout(() => controller.abort(), 20) } })
    expect(methods(seen.log)).toContain('session/cancel')
    expect(result.status).toBe('interrupted')
  })

  it('resumes with session/load and ignores the history the agent resends', async () => {
    const { result, seen } = await run('load', { sessionId: 'f464581d-d3ce-4435-a7dc-ef4586503e3d' })
    expect(methods(seen.log)).toEqual(['initialize', 'session/load', 'session/prompt'])
    expect(result.text).toBe('oi.txt')
  })

  it('planning sets the session to Plan mode', async () => {
    const { seen } = await run('plan', { planning: true })
    expect(seen.log.find((message) => message.method === 'session/set_mode')!.params).toMatchObject({ modeId: 'plan' })
  })

  it('switches the model (Claude through Antigravity) and reports the effective model', async () => {
    const { result, seen } = await run('model', { model: 'claude-sonnet-4-6' })
    expect(seen.log.find((message) => message.method === 'session/set_config_option')!.params).toMatchObject({ configId: 'model', value: 'claude-sonnet-4-6' })
    expect(result.modelEffective).toBe('claude-sonnet-4-6')
    expect(result.text).toContain('Claude Sonnet 4.6')
  })

  it('a model the account does not offer keeps the default and warns', async () => {
    const events: string[] = []
    const { seen } = await run('basic', { model: 'gemini-9-ultra', onEvent: (event: { type: string }) => events.push(event.type) })
    expect(methods(seen.log)).not.toContain('session/set_config_option')
    expect(events).toContain('gemini/warning')
  })

  it('modes: accept edits via set_mode; automatic skips permissions on the command line', async () => {
    const edits = await run('basic', { mode: 'accept_edits' })
    expect(edits.seen.log.find((message) => message.method === 'session/set_mode')!.params).toMatchObject({ modeId: 'accept-edits' })
    const auto = await run('basic', { mode: 'auto' })
    expect(auto.seen.args).toEqual(['acp', '--dangerously-skip-permissions'])
    expect(methods(auto.seen.log)).not.toContain('session/set_mode')
  })

  it('live mode switch: set_mode on the open session, and what was waiting goes through without the user', async () => {
    let setMode: ((mode: string) => boolean) | undefined, signal: AbortSignal | undefined
    const { result, seen } = await run('deny', {
      onModeControl: (control: (mode: string) => boolean) => { setMode = control },
      // The user does not answer; switching to Automatic answers for them and closes the screen's request.
      requestPermission: (_kind: string, _details: Json, s: AbortSignal) => { signal = s; setTimeout(() => setMode!('auto'), 10); return new Promise<boolean>(() => undefined) }
    })
    expect(seen.log.find((message) => message.method === 'session/set_mode')!.params).toMatchObject({ modeId: 'default' })
    expect(seen.log.find((message) => message.id === '1')).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'allow' } } })
    expect(signal?.aborted).toBe(true)
    expect(result.status).toBe('completed')
  })

  it('live mode switch: what the new mode covers is not asked; plan and runs started in Automatic refuse the switch', async () => {
    let asked = 0, accepted: boolean[] = []
    const { seen } = await run('deny', { onModeControl: (control: (mode: string) => boolean) => { accepted = [control('plan'), control('read_only'), control('bypass')] }, requestPermission: async () => { asked += 1; return false } })
    expect(accepted).toEqual([false, false, true])
    expect(asked).toBe(0)
    expect(seen.log.find((message) => message.id === '1')).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'allow' } } })
    let offered = false
    await run('basic', { mode: 'auto', onModeControl: () => { offered = true } })
    expect(offered).toBe(false)
  })

  it('without login it fails with a clear message and never calls authenticate', async () => {
    const seen = { log: [] as Json[] }
    const factory: ProcessFactory = { start(_command, args) {
      seen.log.push({ args })
      const emitter = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>
      const stdin = new PassThrough(), stdout = new PassThrough()
      Object.assign(emitter, { stdin, stdout, stderr: new PassThrough(), killed: false, kill() { return true } })
      stdin.on('data', (chunk: Buffer) => { for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const message = JSON.parse(line) as Json; seen.log.push(message)
        if (message.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }] } })}\n`)
        if (message.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required' } })}\n`)
      } })
      return emitter as ChildProcessWithoutNullStreams
    } }
    const result = await new GeminiCliAdapter(factory).run({ cwd: 'C:\\repo', prompt: 'x', sessionId: null, planning: false, mode: 'manual', profile, onEvent: () => undefined } as never)
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/Antigravity/)
    expect(methods(seen.log)).not.toContain('authenticate')
  })
})

describe('Antigravity protocol pieces', () => {
  it('maps saved model ids to what the account offers', () => {
    const offered = ['gemini-3.8-flash', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium']
    expect(antigravityModel('auto', offered)).toBeNull()
    expect(antigravityModel(null, offered)).toBeNull()
    expect(antigravityModel('claude-sonnet-4-6', offered)).toBe('claude-sonnet-4-6')
    expect(antigravityModel('flash', offered)).toBe('gemini-3.8-flash')
    expect(antigravityModel('pro', offered)).toBeNull()
    expect(antigravityModel('gpt-oss-120b', offered)).toBe('gpt-oss-120b-medium')
  })
  it('usage: input without cache, output with thinking; nothing when absent', () => {
    expect(antigravityUsage({ inputTokens: 4539, outputTokens: 64, cachedReadTokens: 5051, thoughtTokens: 0, totalTokens: 9654 })).toEqual({ input: 4539, cached: 5051, output: 64 })
    expect(antigravityUsage(undefined)).toBeUndefined()
  })
  it('permission options and details use Antigravity field names', () => {
    const options = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }]
    expect(acpPermissionOutcome(options, true)).toEqual({ outcome: 'selected', optionId: 'allow' })
    expect(acpPermissionOutcome([{ optionId: 'a', kind: 'allow_always' }], true)).toEqual({ outcome: 'cancelled' })
    expect(acpPermissionDetails({ toolCall: { title: 'Editar', kind: 'edit', rawInput: { Path: 'C:\\r\\a.ts' } }, options: [] })).toMatchObject({ toolKind: 'edit', path: 'C:\\r\\a.ts' })
    expect(toolParameters({ CommandLine: 'git status' })).toMatchObject({ command: 'git status' })
  })
  it('extra folders and MCP format', () => {
    expect(acpArgs({ attachments: ['C:\\a\\x.png', 'C:\\a\\y.png'], addDirs: ['C:\\b'], mode: 'manual', planning: false })).toEqual(['acp', '--add-dir', 'C:\\b', '--add-dir', 'C:\\a'])
    expect(acpArgs({ mode: 'auto', planning: true })).toEqual(['acp'])
    expect(acpMcpServers([{ name: 'api', transport: 'http', url: 'https://h/mcp', headers: { Authorization: 'z' } } as never])).toEqual([{ type: 'http', name: 'api', url: 'https://h/mcp', headers: [{ name: 'Authorization', value: 'z' }] }])
  })
  it('account: e-mail from the debug log line, plan name from session/new', () => {
    expect(antigravityEmail('I1110 23:05:23.577553 52 server_oauth.go:226] OAuth: authenticated successfully as pessoa@gmail.com\n')).toBe('pessoa@gmail.com')
    expect(antigravityEmail('server_oauth.go:221] applyAuthResult: email=pessoa@gmail.com, authMethod=consumer, quotaProject=')).toBe('pessoa@gmail.com')
    expect(antigravityEmail('nothing here')).toBeNull()
    expect(antigravityTier({ sessionId: 's', _meta: { antigravity: { tier: { name: 'Antigravity Starter Quota', id: 'free-tier' } } } })).toBe('Antigravity Starter Quota')
    expect(antigravityTier({})).toBeNull()
  })
})
