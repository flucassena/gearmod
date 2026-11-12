import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { AgentProfile } from '@gearmod/contracts'
import { claudeControl, claudeModelOptions, claudeUsageAsEvent, probeClaudeLimits } from './adapters'
import { antigravityModelOptions } from './agent-config'
import { antigravityOptions } from './antigravity-auth'
import type { ProcessFactory } from './adapters'

type Json = Record<string, unknown>
const profile = { id: '10000000-0000-4000-8000-000000000002', provider: 'claude', label: 'Claude', scope: 'w', color: '#D97757', configDir: 'C:\\profiles\\claude', executablePath: 'claude', enabled: true, billingMode: 'subscription', envPassthrough: [] } as unknown as AgentProfile

// Shapes recorded from Claude Code 2.1.322 (`initialize` and `get_usage` control responses), trimmed.
const initialize = { models: [
  { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', displayName: 'Opus 5.5', description: 'Best for everyday, complex tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'fable', displayName: 'Fable 5.2', description: 'Most capable for your hardest and longest-running tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', displayName: 'Sonnet 5.5', description: 'Efficient for routine tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' }
] }
const usage = { subscription_type: 'max', rate_limits: { five_hour: { utilization: 16, resets_at: '2026-11-11T06:50:00.861341+00:00' }, seven_day: { utilization: 47, resets_at: '2026-11-12T11:00:00.861360+00:00' }, seven_day_opus: null, extra_usage: { is_enabled: false } } }

/** Fake Claude Code that answers control requests only; it records whether any user message was sent. */
function fakeClaude(seen: { requests: string[]; userMessages: number }): ProcessFactory {
  return { start() {
    const emitter = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>
    const stdin = new PassThrough(), stdout = new PassThrough()
    Object.assign(emitter, { stdin, stdout, stderr: new PassThrough(), killed: false, kill() { return true } })
    stdin.on('data', (chunk: Buffer) => { for (const line of chunk.toString().split('\n').filter(Boolean)) {
      const message = JSON.parse(line) as { type: string; request_id?: string; request?: { subtype: string } }
      if (message.type === 'user') { seen.userMessages++; continue }
      const subtype = message.request!.subtype; seen.requests.push(subtype)
      const response: Json = subtype === 'initialize' ? initialize : subtype === 'get_usage' ? usage : {}
      stdout.write(`${JSON.stringify({ type: 'system', subtype: 'hook_started' })}\n${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })}\n`)
    } })
    return emitter as ChildProcessWithoutNullStreams
  } }
}

describe('Claude Code control channel (no prompt, nothing spent)', () => {
  it('reads the usage limit with get_usage after initialize, without any user message', async () => {
    const seen = { requests: [] as string[], userMessages: 0 }
    const event = await probeClaudeLimits(profile, fakeClaude(seen))
    expect(seen).toEqual({ requests: ['initialize', 'get_usage'], userMessages: 0 })
    expect(event).toEqual({ rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.16, resetsAt: Math.round(Date.parse('2026-11-11T06:50:00.861Z') / 1000) }, seven_day: { utilization: 0.47, resetsAt: Math.round(Date.parse('2026-11-12T11:00:00.861Z') / 1000) } } } })
  })

  it('returns what arrived when the CLI ends early', async () => {
    const factory: ProcessFactory = { start() {
      const emitter = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>
      Object.assign(emitter, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { return true } })
      queueMicrotask(() => emitter.emit('exit', 1))
      return emitter as ChildProcessWithoutNullStreams
    } }
    expect(await claudeControl(profile, ['get_usage'], factory)).toEqual({})
  })

  it('keeps only the plan windows: repeated variants of the week are dropped, the week of one model stays', () => {
    const event = claudeUsageAsEvent({ rate_limits: { seven_day: { utilization: 2, resets_at: null }, seven_day_overage_included: { utilization: 2, resets_at: null }, seven_day_fable: { utilization: 30, resets_at: null }, extra_usage: { is_enabled: false } } })
    expect(Object.keys((event!.rate_limit_info as { unifiedWindows: object }).unifiedWindows)).toEqual(['seven_day', 'seven_day_fable'])
  })

  it('usage without windows is ignored', () => {
    expect(claudeUsageAsEvent(undefined)).toBeNull()
    expect(claudeUsageAsEvent({ rate_limits: { five_hour: null } })).toBeNull()
  })

  it('lists the account models (Fable included), without "default"', () => {
    const models = claudeModelOptions(initialize)
    expect(models.map((model) => model.id)).toEqual(['opus', 'fable', 'sonnet', 'claude-haiku-4-5-20251001'])
    expect(models.find((model) => model.id === 'fable')).toMatchObject({ label: 'Fable 5.2', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })
    expect(models.find((model) => model.id === 'opus')!.recommendedFor).toEqual(['planning'])
    expect(models.find((model) => model.id === 'claude-haiku-4-5-20251001')).toMatchObject({ efforts: [], defaultEffort: null })
  })
})

describe('Antigravity account models', () => {
  // `session/new` of agy 1.5.5 on a free account (fixtures/antigravity/basic.jsonl).
  const session = { configOptions: [
    { id: 'model', options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' }, { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }] },
    { id: 'thought_level', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }
  ] }
  it('reads the select options of session/new', () => {
    expect(antigravityOptions(session, 'model').map((item) => item.id)).toEqual(['gemini-3.8-flash', 'claude-sonnet-4-6', 'gpt-oss-120b-medium'])
    expect(antigravityOptions({}, 'model')).toEqual([])
  })
  it('builds the picker: Auto first, thinking levels only on Gemini models', () => {
    const options = antigravityModelOptions(antigravityOptions(session, 'model'), ['low', 'medium', 'high'])
    expect(options.map((item) => item.id)).toEqual(['auto', 'gemini-3.8-flash', 'claude-sonnet-4-6', 'gpt-oss-120b-medium'])
    expect(options[1]).toMatchObject({ label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' })
    expect(options[2]).toMatchObject({ efforts: [], defaultEffort: null })
  })
})
