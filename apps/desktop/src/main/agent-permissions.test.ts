import { describe, expect, it } from 'vitest'
import { AgentPermissions } from './agent-permissions'

describe('run-scoped agent permissions', () => {
  const input = { runId: 'run-a', chatId: 'chat-a', provider: 'claude' as const, kind: 'Bash', details: { command: 'test' } }
  it('restores pending prompts when reopening a chat, rejects cross-run and duplicate decisions', async () => {
    const broker = new AgentPermissions(), events: string[] = []
    const pending = broker.request(input, new AbortController().signal, (event) => events.push(event.type))
    const request = broker.list('chat-a')[0]!
    expect(broker.list('other-chat')).toEqual([])
    expect(broker.decide('run-b', request.id, true)).toBe(false)
    expect(broker.decide('run-a', request.id, true)).toBe(true)
    expect(broker.decide('run-a', request.id, false)).toBe(false)
    expect(await pending).toBe(true)
    expect(broker.list('chat-a')).toEqual([])
    expect(events).toEqual(['gearmod/permission-requested', 'gearmod/permission-resolved'])
  })
  it('denies all pending requests on abort or run completion without affecting another run', async () => {
    const broker = new AgentPermissions(), controller = new AbortController()
    const first = broker.request(input, controller.signal, () => {})
    const second = broker.request({ ...input, runId: 'run-b' }, new AbortController().signal, () => {})
    controller.abort(); expect(await first).toBe(false)
    expect(broker.list('chat-a')).toHaveLength(1)
    broker.closeRun('run-b'); expect(await second).toBe(false)
    expect(broker.list('chat-a')).toEqual([])
    expect(await broker.request(input, controller.signal, () => {})).toBe(false)
  })
})

describe('allow everything from now on', () => {
  const input = { runId: 'run-a', chatId: 'chat-a', provider: 'claude' as const, kind: 'Bash', details: { command: 'test' }, planning: false }
  it('approves the open request, the ones waiting and the next ones of that chat only, until turned off', async () => {
    const broker = new AgentPermissions(), events: string[] = [], signal = new AbortController().signal
    const first = broker.request(input, signal, (event) => events.push(event.type))
    const waiting = broker.request({ ...input, kind: 'Read' }, signal, () => {})
    const otherChat = broker.request({ ...input, chatId: 'chat-b', runId: 'run-b' }, signal, () => {})
    expect(broker.decide('run-a', broker.list('chat-a')[0]!.id, true, true)).toBe(true)
    expect(await first).toBe(true); expect(await waiting).toBe(true)
    expect(broker.autoAllowed('chat-a')).toBe(true); expect(broker.autoAllowed('chat-b')).toBe(false)
    expect(broker.list('chat-b')).toHaveLength(1)
    const next = events.length
    expect(await broker.request({ ...input, runId: 'run-c' }, signal, (event) => events.push(event.type))).toBe(true)
    expect(events).toHaveLength(next)
    expect(broker.stopAuto('chat-a')).toBe(true)
    const asked = broker.request(input, signal, () => {})
    expect(broker.list('chat-a')).toHaveLength(1)
    broker.closeRun('run-a'); broker.closeRun('run-b'); expect(await asked).toBe(false); expect(await otherChat).toBe(false)
  })
  it('does not turn on by denying, keeps asking to leave plan mode and turns off when planning becomes execution', async () => {
    const broker = new AgentPermissions(), signal = new AbortController().signal
    const denied = broker.request(input, signal, () => {})
    broker.decide('run-a', broker.list('chat-a')[0]!.id, false, true); expect(await denied).toBe(false); expect(broker.autoAllowed('chat-a')).toBe(false)
    const planning = { ...input, planning: true }
    const read = broker.request({ ...planning, kind: 'Read' }, signal, () => {})
    broker.decide('run-a', broker.list('chat-a')[0]!.id, true, true); expect(await read).toBe(true)
    const exit = broker.request({ ...planning, kind: 'ExitPlanMode' }, signal, () => {})
    expect(broker.list('chat-a')).toHaveLength(1)
    broker.decide('run-a', broker.list('chat-a')[0]!.id, true, true); expect(await exit).toBe(true)
    const events: string[] = []
    const execution = broker.request(input, signal, (event) => events.push(event.type))
    expect(broker.autoAllowed('chat-a')).toBe(false)
    expect(events).toContain('gearmod/permission-resolved')
    expect(broker.list('chat-a')).toHaveLength(1)
    broker.closeRun('run-a'); expect(await execution).toBe(false)
  })
})
