import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { ClaudeCliAdapter, CodexAppServerAdapter, codexAccess, listCodexModels, type ProcessFactory } from './adapters'
import type { AgentProfile } from '@gearmod/contracts'

const profile = (provider: 'codex' | 'claude'): AgentProfile => ({ id: '10000000-0000-4000-8000-000000000001', provider, label: provider, scope: 'work', color: '#aeb9ff', configDir: 'C:\\profiles\\work', executablePath: null, enabled: true, billingMode: 'unknown', envPassthrough: [] })

function fakeProcess(onInput?: (value: Record<string, unknown>, child: ChildProcessWithoutNullStreams) => void): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  Object.assign(emitter, { stdin, stdout, stderr, killed: false, kill() { return true } })
  const child = emitter as ChildProcessWithoutNullStreams
  let buffer = ''
  stdin.on('data', (chunk: Buffer) => { buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop() ?? ''; for (const line of lines) if (line) onInput?.(JSON.parse(line) as Record<string, unknown>, child) })
  return child
}
function send(child: ChildProcessWithoutNullStreams, value: Record<string, unknown>): void { (child.stdout as PassThrough).write(`${JSON.stringify(value)}\n`) }

describe('real provider protocol adapters', () => {
  it('drives Codex initialize, thread and turn over JSONL and captures deltas', async () => {
    const methods: string[] = []
    const factory: ProcessFactory = { start() { return fakeProcess((request, child) => {
      methods.push(String(request.method)); const id = request.id
      if (request.method === 'initialize') send(child, { id, result: {} })
      if (request.method === 'thread/start') send(child, { id, result: { thread: { id: 'thread-1' }, model: 'gpt-6.1-effective' } })
      if (request.method === 'turn/start') { send(child, { id, result: { turn: { id: 'turn-1' } } }); send(child, { method: 'item/agentMessage/delta', params: { delta: 'Olá', threadId: 'thread-1', turnId: 'turn-1', itemId: 'i' } }); send(child, { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } }) }
    }) } }
    const events: string[] = []
    const result = await new CodexAppServerAdapter(factory).run({ cwd: 'C:\\repo', prompt: 'planeje', sessionId: null, planning: true, profile: profile('codex'), onEvent: (event) => events.push(event.type) })
    expect(methods).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start'])
    expect(result).toMatchObject({ sessionId: 'thread-1', turnId: 'turn-1', text: 'Olá', status: 'completed', modelEffective: 'gpt-6.1-effective' })
    expect(events).toContain('item/agentMessage/delta')
  })

  it('parses Claude stream-json and preserves its session id', async () => {
    let child: ChildProcessWithoutNullStreams
    const factory: ProcessFactory = { start() { child = fakeProcess(); queueMicrotask(() => { send(child, { type: 'system', session_id: 'session-1' }); send(child, { type: 'stream_event', session_id: 'session-1', event: { delta: { type: 'text_delta', text: 'Plano' } } }); send(child, { type: 'result', session_id: 'session-1', is_error: false }) }); return child } }
    const result = await new ClaudeCliAdapter(factory).run({ cwd: 'C:\\repo', prompt: 'planeje', sessionId: null, planning: true, profile: profile('claude'), onEvent: () => undefined })
    expect(result).toMatchObject({ sessionId: 'session-1', text: 'Plano', status: 'completed' })
  })

  it('continues Claude execution after a large attachment read event', async () => {
    const content = 'x'.repeat(120_000)
    const events: unknown[] = []
    const factory: ProcessFactory = { start() {
      const child = fakeProcess()
      queueMicrotask(() => {
        send(child, { type: 'user', message: { content: [{ type: 'tool_result', content }] }, session_id: 'session-large' })
        send(child, { type: 'result', session_id: 'session-large', result: 'Arquivo lido', is_error: false })
      })
      return child
    } }
    const result = await new ClaudeCliAdapter(factory).run({ cwd: 'C:\\repo', prompt: 'leia o anexo', sessionId: null, planning: true, profile: profile('claude'), onEvent: (event) => events.push(event) })
    expect(events[0]).toEqual({ type: 'claude/user', payload: { type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(100_000) }] }, session_id: 'session-large' } })
    expect(result).toMatchObject({ sessionId: 'session-large', text: 'Arquivo lido', status: 'completed' })
  })

  it("captures apiKeySource from Claude's system/init event, without recording the mode on its own", async () => {
    let child: ChildProcessWithoutNullStreams
    const factory: ProcessFactory = { start() { child = fakeProcess(); queueMicrotask(() => { send(child, { type: 'system', subtype: 'init', session_id: 'session-2', apiKeySource: 'ANTHROPIC_API_KEY' }); send(child, { type: 'result', session_id: 'session-2', is_error: false }) }); return child } }
    const result = await new ClaudeCliAdapter(factory).run({ cwd: 'C:\\repo', prompt: 'planeje', sessionId: null, planning: true, profile: profile('claude'), onEvent: () => undefined })
    expect(result).toMatchObject({ sessionId: 'session-2', status: 'completed', apiKeySource: 'ANTHROPIC_API_KEY' })
  })

  it('B4: task_started without task_notification does not trap the run forever: the turn result counts after a period of inactivity', async () => {
    let child: ChildProcessWithoutNullStreams
    const factory: ProcessFactory = { start() { child = fakeProcess(); queueMicrotask(() => { send(child, { type: 'system', subtype: 'task_started', task_id: 't1', session_id: 's' }); send(child, { type: 'result', session_id: 's', is_error: false, result: 'pronto' }) }); return child } }
    const result = await new ClaudeCliAdapter(factory, { graceMs: 10, pendingIdleMs: 30 }).run({ cwd: 'C:\repo', prompt: 'x', sessionId: null, planning: false, profile: profile('claude'), onEvent: () => undefined })
    expect(result).toMatchObject({ status: 'completed', text: 'pronto' })
  })

  it('waits for the turn Claude starts after a background task notification, even past the grace period', async () => {
    let child: ChildProcessWithoutNullStreams
    const factory: ProcessFactory = { start() { child = fakeProcess(); queueMicrotask(() => {
      send(child, { type: 'system', subtype: 'task_started', task_id: 't1', session_id: 's' })
      send(child, { type: 'result', session_id: 's', is_error: false, result: 'aviso quando terminar' })
      setTimeout(() => {
        send(child, { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', session_id: 's' })
        send(child, { type: 'system', subtype: 'background_tasks_changed', session_id: 's' })
        send(child, { type: 'system', subtype: 'init', session_id: 's' })
        setTimeout(() => { send(child, { type: 'stream_event', session_id: 's', event: { delta: { type: 'text_delta', text: ' testes passaram' } } }); send(child, { type: 'result', session_id: 's', is_error: false }) }, 40)
      }, 5)
    }); return child } }
    const result = await new ClaudeCliAdapter(factory, { graceMs: 10, pendingIdleMs: 500 }).run({ cwd: 'C:\repo', prompt: 'x', sessionId: null, planning: false, profile: profile('claude'), onEvent: () => undefined })
    expect(result).toMatchObject({ status: 'completed' })
    expect(result.text).toContain('testes passaram')
  })

  it('passes the system skills to Codex as developerInstructions and to Claude as --plugin-dir', async () => {
    const started: Record<string, unknown>[] = []
    const codex: ProcessFactory = { start() { return fakeProcess((request, child) => {
      const id = request.id
      if (request.method === 'initialize') send(child, { id, result: {} })
      if (request.method === 'thread/start') { started.push(request.params as Record<string, unknown>); send(child, { id, result: { thread: { id: 'thread-1' } } }) }
      if (request.method === 'turn/start') { send(child, { id, result: { turn: { id: 'turn-1' } } }); send(child, { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }) }
    }) } }
    await new CodexAppServerAdapter(codex).run({ cwd: 'C:\\repo', prompt: 'x', sessionId: null, planning: true, profile: profile('codex'), developerInstructions: 'SKILLS', mcp: { command: 'node', args: ['s.mjs'], env: { GEARMOD_TOKEN: 't' } }, onEvent: () => undefined })
    expect(started[0]).toMatchObject({ developerInstructions: 'SKILLS', sandbox: 'read-only', config: { mcp_servers: { gearmod: { command: 'node', args: ['s.mjs'] } } } })

    let args: string[] = []
    let child: ChildProcessWithoutNullStreams
    const claude: ProcessFactory = { start(_command, received) { args = received; child = fakeProcess(); queueMicrotask(() => send(child, { type: 'result', session_id: 's', result: 'ok' })); return child } }
    await new ClaudeCliAdapter(claude).run({ cwd: 'C:\\repo', prompt: 'x', sessionId: null, planning: true, profile: profile('claude'), pluginDir: 'C:\\plugin', onEvent: () => undefined })
    expect(args).toContain('--plugin-dir'); expect(args[args.indexOf('--plugin-dir') + 1]).toBe('C:\\plugin')
    expect(args.slice(-2)).toEqual(['--', 'x'])
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(args).not.toContain('--mcp-config')

    let mcpFile = ''
    const withMcp: ProcessFactory = { start(_command, received) { args = received; if (received.includes('--mcp-config')) mcpFile = readFileSync(received[received.indexOf('--mcp-config') + 1]!, 'utf8'); child = fakeProcess(); queueMicrotask(() => send(child, { type: 'result', session_id: 's', result: 'ok' })); return child } }
    const mcp = { command: 'node', args: ['server.mjs'], env: { GEARMOD_TOKEN: 't' } }
    await new ClaudeCliAdapter(withMcp).run({ cwd: 'C:\\repo', prompt: 'x', sessionId: null, planning: true, profile: profile('claude'), mcp, onEvent: () => undefined })
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default'); expect(args[args.indexOf('--tools') + 1]).not.toMatch(/Edit|Write|Bash/)
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__gearmod'); 
    // S2: the secret does not go on the command line; it goes through a file, which is deleted at the end of the run
    expect(args.join(' ')).not.toContain('GEARMOD_TOKEN')
    expect(args[args.indexOf('--mcp-config') + 1]).toMatch(/mcp\.json$/); expect(JSON.parse(mcpFile).mcpServers.gearmod.env.GEARMOD_TOKEN).toBe('t'); expect(existsSync(args[args.indexOf('--mcp-config') + 1]!)).toBe(false)
    await new ClaudeCliAdapter(withMcp).run({ cwd: 'C:\\repo', prompt: 'x', sessionId: null, planning: false, profile: profile('claude'), mcp, onEvent: () => undefined })
    expect(args).not.toContain('--tools')
  })

  it('maps permission modes, model and effort to Claude flags', async () => {
    let args: string[] = []
    let child: ChildProcessWithoutNullStreams
    const factory: ProcessFactory = { start(_command, received) { args = received; child = fakeProcess(); queueMicrotask(() => send(child, { type: 'result', session_id: 's', result: 'ok' })); return child } }
    const run = (mode: 'accept_edits' | 'auto' | 'bypass' | 'manual') => new ClaudeCliAdapter(factory).run({ cwd: 'C:\\repo', prompt: 'x', sessionId: null, planning: false, profile: profile('claude'), model: 'sonnet', effort: 'medium', mode, onEvent: () => undefined })
    await run('accept_edits'); expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits'); expect(args[args.indexOf('--model') + 1]).toBe('sonnet'); expect(args[args.indexOf('--effort') + 1]).toBe('medium')
    await run('auto'); expect(args[args.indexOf('--permission-mode') + 1]).toBe('auto')
    await run('bypass'); expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    await expect(run('manual').then(() => 'ran')).resolves.toBe('ran')
  })

  it('maps permission modes to Codex sandbox, approvals and reviewer, and sends model and effort', async () => {
    expect(codexAccess('plan')).toEqual({ sandbox: 'read-only', approvalPolicy: 'never' })
    expect(codexAccess('auto')).toEqual({ sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' })
    expect(codexAccess('bypass')).toEqual({ sandbox: 'danger-full-access', approvalPolicy: 'never' })
    expect(() => codexAccess('accept_edits')).toThrow('Codex')
    const params: Record<string, Record<string, unknown>> = {}
    const factory: ProcessFactory = { start() { return fakeProcess((request, child) => {
      const id = request.id
      if (request.method === 'initialize') send(child, { id, result: {} })
      if (request.method === 'thread/start') { params.thread = request.params as Record<string, unknown>; send(child, { id, result: { thread: { id: 't' } } }) }
      if (request.method === 'turn/start') { params.turn = request.params as Record<string, unknown>; send(child, { id, result: { turn: { id: 'u' } } }); send(child, { method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', status: 'completed' } } }) }
    }) } }
    await new CodexAppServerAdapter(factory).run({ cwd: 'C:\\repo', prompt: 'x', sessionId: null, planning: false, profile: profile('codex'), model: 'gpt-x', effort: 'high', mode: 'auto', onEvent: () => undefined })
    expect(params.thread).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', model: 'gpt-x' })
    expect(params.turn).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', model: 'gpt-x', effort: 'high' })
  })

  it('lists Codex models from the app-server and hides hidden ones', async () => {
    const factory: ProcessFactory = { start() { return fakeProcess((request, child) => {
      const id = request.id
      if (request.method === 'initialize') send(child, { id, result: {} })
      if (request.method === 'model/list') send(child, { id, result: { data: [
        { model: 'gpt-a', displayName: 'GPT A', description: 'A', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] },
        { model: 'gpt-h', displayName: 'Hidden', description: '', hidden: true, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [] }] } })
    }) } }
    expect(await listCodexModels(profile('codex'), factory)).toEqual([{ id: 'gpt-a', label: 'GPT A', description: 'A', efforts: ['low', 'medium'], recommendedFor: ['planning', 'execution'], defaultEffort: 'medium' }])
  })
})


describe('interactive provider permissions', () => {
  it.each([true, false])('answers Codex string request IDs and resumes the originating thread (allow=%s)', async (allow) => {
    const responses: Record<string, unknown>[] = [], policies: Record<string, unknown>[] = []
    const factory: ProcessFactory = { start() { return fakeProcess((request, child) => {
      const id = request.id
      if (request.method === 'initialize') send(child, { id, result: {} })
      if (request.method === 'thread/resume') { policies.push(request.params as Record<string, unknown>); send(child, { id, result: { thread: { id: 'existing-thread' } } }) }
      if (request.method === 'turn/start') {
        send(child, { id, result: { turn: { id: 'turn-2' } } })
        send(child, { id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'existing-thread', turnId: 'turn-2', itemId: 'cmd', command: 'npm test', cwd: 'C:\\repo' } })
      }
      if (id === 'approval-1') { responses.push(request); send(child, { method: 'turn/completed', params: { threadId: 'existing-thread', turn: { id: 'turn-2', status: 'completed' } } }) }
    }) } }
    const result = await new CodexAppServerAdapter(factory).run({ cwd: 'C:\\repo', prompt: 'x', sessionId: 'existing-thread', planning: false, mode: 'on_request', profile: profile('codex'), requestPermission: async (kind, details) => { expect(kind).toBe('item/commandExecution/requestApproval'); expect(details.command).toBe('npm test'); return allow }, onEvent: () => {} })
    expect(result.status).toBe('completed')
    expect(policies[0]).toMatchObject({ threadId: 'existing-thread', approvalPolicy: 'on-request', approvalsReviewer: 'user' })
    expect(responses).toEqual([{ id: 'approval-1', result: { decision: allow ? 'accept' : 'decline' } }])
  })

  it.each([true, false])('answers Claude can_use_tool over open stdin and preserves the resume session (allow=%s)', async (allow) => {
    let args: string[] = []
    const responses: Record<string, unknown>[] = []
    const factory: ProcessFactory = { start(_command, received) { args = received; return fakeProcess((message, child) => {
      if (message.type === 'user') send(child, { type: 'control_request', request_id: 'c-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/repo/a', content: 'hello' }, tool_use_id: 'tool-1' } })
      if (message.type === 'control_response') { responses.push(message); send(child, { type: 'result', session_id: 'existing-session', result: 'finished' }) }
    }) } }
    const result = await new ClaudeCliAdapter(factory).run({ cwd: 'C:\\repo', prompt: 'write a', sessionId: 'existing-session', planning: false, mode: 'manual', profile: profile('claude'), requestPermission: async (kind, details) => { expect(kind).toBe('Write'); expect(details.input).toEqual({ file_path: '/repo/a', content: 'hello' }); return allow }, onEvent: () => {} })
    expect(result.status).toBe('completed'); expect(args).toContain('--input-format'); expect(args).toContain('--permission-prompt-tool'); expect(args[args.indexOf('--resume') + 1]).toBe('existing-session')
    expect(args.slice(-2)).toEqual(['--permission-prompt-tool', 'stdio'])
    expect(responses[0]).toMatchObject({ type: 'control_response', response: { subtype: 'success', request_id: 'c-1', response: allow ? { behavior: 'allow', updatedInput: { file_path: '/repo/a', content: 'hello' } } : { behavior: 'deny' } } })
  })

  it('denies pending Claude permission before killing on cancellation; ignores late approval', async () => {
    const controller = new AbortController(), order: string[] = []
    let decide!: (allow: boolean) => void
    const factory: ProcessFactory = { start() { const child = fakeProcess((message, process) => {
      if (message.type === 'user') send(process, { type: 'control_request', request_id: 'c', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'x' } } })
      if (message.type === 'control_response') order.push('deny')
    }); child.kill = () => { order.push('kill'); queueMicrotask(() => child.emit('exit', null)); return true }; return child } }
    const pending = new ClaudeCliAdapter(factory).run({ cwd: 'C:\\repo', prompt: 'x', sessionId: null, planning: false, mode: 'manual', profile: profile('claude'), signal: controller.signal, requestPermission: () => new Promise((resolve) => { decide = resolve }), onEvent: () => {} })
    controller.abort(); expect((await pending).status).toBe('interrupted')
    decide(true); await Promise.resolve()
    expect(order[0]).toBe('deny'); expect(order[1]).toBe('kill'); expect(order.filter((item) => item === 'deny')).toHaveLength(1)
  })
})


describe('Codex permission categories', () => {
  it.each([
    ['item/fileChange/requestApproval', true, { decision: 'accept' }],
    ['item/fileChange/requestApproval', false, { decision: 'decline' }],
    ['item/permissions/requestApproval', true, { permissions: { network: { enabled: true } }, scope: 'turn' }],
    ['item/permissions/requestApproval', false, { permissions: {}, scope: 'turn' }],
    ['execCommandApproval', true, { decision: 'approved' }],
    ['applyPatchApproval', false, { decision: 'denied' }]
  ])('responds to %s (allow=%s) with the provider-specific payload', async (method, allow, response) => {
    let actual: unknown
    const factory: ProcessFactory = { start() { return fakeProcess((request, child) => {
      const id = request.id
      if (request.method === 'initialize') send(child, { id, result: {} })
      if (request.method === 'thread/start') send(child, { id, result: { thread: { id: 't' } } })
      if (request.method === 'turn/start') {
        send(child, { id, result: { turn: { id: 'u' } } })
        send(child, { id: 101, method, params: { ...(String(method).startsWith('item/') ? { threadId: 't', turnId: 'u' } : { conversationId: 't', callId: 'file' }), itemId: 'file', permissions: { network: { enabled: true }, fileSystem: null } } })
      }
      if (id === 101) { actual = request.result; send(child, { method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', status: 'completed' } } }) }
    }) } }
    await new CodexAppServerAdapter(factory).run({ cwd: 'C:\\repo', prompt: 'x', sessionId: null, planning: false, mode: 'read_only', profile: profile('codex'), requestPermission: async () => Boolean(allow), onEvent: () => {} })
    expect(actual).toEqual(response)
  })
})
