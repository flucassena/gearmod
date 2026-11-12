import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from './database'
import { ProfileRepository } from './projects'
import { parseCodexRateLimits, rollWindow, UsageService } from './usage'
import { UsageLedgerService } from './usage-ledger'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const line = (primary: number, secondary: number, timestamp = '2026-10-21T10:00:00.000Z', resets: [number, number] = [1792548600, 1792800000]) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 10 } }, rate_limits: { primary: { used_percent: primary, window_minutes: 300, resets_at: resets[0] }, secondary: { used_percent: secondary, window_minutes: 10080, resets_at: resets[1] } } } })

describe('parseCodexRateLimits', () => {
  it('reads the five-hour and weekly windows from a session line', () => {
    const found = parseCodexRateLimits(line(42.4, 17))!
    expect(found.windows).toEqual([
      { id: 'five_hour', label: 'Sessão de 5 horas', usedPercent: 42, resetsAt: new Date(1792548600 * 1000).toISOString() },
      { id: 'seven_day', label: 'Semana', usedPercent: 17, resetsAt: new Date(1792800000 * 1000).toISOString() }
    ])
    expect(found.at).toBe('2026-10-21T10:00:00.000Z')
  })

  it('ignores lines without limits, broken JSON and out-of-range values are clamped', () => {
    expect(parseCodexRateLimits('{"type":"message"}')).toBeNull()
    expect(parseCodexRateLimits('{"rate_limits": {oops')).toBeNull()
    expect(parseCodexRateLimits(line(150, -3))!.windows.map((window) => window.usedPercent)).toEqual([100, 0])
  })
})

describe('rollWindow', () => {
  it('projects the next reset by adding whole periods and keeps current windows untouched', () => {
    const now = Date.parse('2026-10-21T12:00:00.000Z')
    const past = { id: 'five_hour', label: 'x', usedPercent: 80, resetsAt: '2026-10-21T01:00:00.000Z' }
    const rolled = rollWindow(past, now)
    expect(rolled.usedPercent).toBe(0); expect(rolled.resetsAt).toBe('2026-10-21T16:00:00.000Z')
    const week = rollWindow({ id: 'seven_day', label: 'x', usedPercent: 50, resetsAt: '2026-10-10T12:00:00.000Z' }, now)
    expect(week.resetsAt).toBe('2026-10-24T12:00:00.000Z')
    const current = { id: 'five_hour', label: 'x', usedPercent: 10, resetsAt: '2026-10-21T13:00:00.000Z' }
    expect(rollWindow(current, now)).toBe(current)
  })
})

describe('UsageService', () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-usage-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root)
    const codex = profiles.create({ provider: 'codex', label: 'Codex', scope: 'x' })
    const claude = profiles.create({ provider: 'claude', label: 'Claude', scope: 'x' })
    return { root, database, codex, claude, service: new UsageService(database, profiles) }
  }

  it('reads the latest Codex limits from the newest session files', async () => {
    const { database, codex, service } = await setup()
    const dir = join(codex.configDir, 'sessions', '2026', '10', '21'); await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'old.jsonl'), `${line(90, 90)}\n`); await utimes(join(dir, 'old.jsonl'), new Date('2026-10-20'), new Date('2026-10-20'))
    await writeFile(join(dir, 'new.jsonl'), `{"type":"session_meta"}\n${line(10, 20, '2026-10-21T09:00:00.000Z')}\n${line(55, 21, '2026-10-21T11:00:00.000Z', [Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000) + 86400])}\n{"type":"agent_message"}\n`)
    const usage = (await service.list()).find((item) => item.profileId === codex.id)!
    expect(usage.windows.map((window) => window.usedPercent)).toEqual([55, 21]); expect(usage.capturedAt).toBe('2026-10-21T11:00:00.000Z'); expect(usage.source).toBe('Sessões do Codex')
    expect((await service.list()).find((item) => item.provider === 'claude')!.windows).toEqual([])
    database.close()
  })

  it('zeroes Codex windows whose reset time already passed', async () => {
    const { database, codex, service } = await setup()
    const dir = join(codex.configDir, 'sessions'); await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.jsonl'), `${line(80, 60, '2026-10-21T11:00:00.000Z', [1000, 2000])}\n`)
    const usage = (await service.list()).find((item) => item.profileId === codex.id)!
    expect(usage.windows.map((window) => window.usedPercent)).toEqual([0, 0])
    for (const window of usage.windows) expect(Date.parse(window.resetsAt!)).toBeGreaterThan(Date.now())
    database.close()
  })

  it('returns no windows for a Codex profile without sessions', async () => {
    const { database, codex, service } = await setup()
    expect((await service.list()).find((item) => item.profileId === codex.id)).toMatchObject({ windows: [], capturedAt: null })
    database.close()
  })

  it('shows the newest Claude event when two arrive in the same millisecond', async () => {
    const { database, claude, service } = await setup()
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-06T12:00:00.000Z'))
    try {
      const future = Math.floor(Date.now() / 1000) + 3600
      service.recordClaude(claude.id, { rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.73, resetsAt: future } } } })
      service.recordClaude(claude.id, { rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.8, resetsAt: future } } } })
      expect((await service.list()).find((item) => item.profileId === claude.id)!.windows.map((window) => window.usedPercent)).toEqual([80])
    } finally { vi.useRealTimers(); database.close() }
  })

  it('stores the Claude rate_limit_event of each run and zeroes windows that already reset', async () => {
    const { database, claude, service } = await setup()
    const future = Math.floor(Date.now() / 1000) + 3600, past = Math.floor(Date.now() / 1000) - 3600
    service.recordClaude(claude.id, { rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.73, resetsAt: future }, seven_day: { utilization: 0.79, resetsAt: past } } } })
    const usage = (await service.list()).find((item) => item.profileId === claude.id)!
    expect(usage.windows.map((window) => [window.id, window.usedPercent])).toEqual([['five_hour', 73], ['seven_day', 0]])
    expect(Date.parse(usage.windows[1]!.resetsAt!)).toBeGreaterThan(Date.now())
    expect(usage.windows[0]!.resetsAt).toBe(new Date(future * 1000).toISOString())
    service.recordClaude(claude.id, { rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.8, resetsAt: future } } } })
    expect((await service.list()).find((item) => item.profileId === claude.id)!.windows[0]!.usedPercent).toBe(80)
    service.recordClaude(claude.id, { nada: true })
    expect(database.db.prepare('SELECT count(*) AS count FROM quota_snapshots WHERE profile_id = ?').get(claude.id)).toEqual({ count: 3 })
    expect(database.db.prepare('SELECT count(*) AS count FROM agent_usage_snapshots WHERE profile_id = ?').get(claude.id)).toEqual({ count: 0 })
    database.close()
  })

  it('exposes history and export through the usage facade', async () => {
    const { database, root } = await setup()
    const profiles = new ProfileRepository(database, root), service = new UsageService(database, profiles, undefined, undefined, undefined, new UsageLedgerService(database))
    expect(service.history({ granularity: 'month', tz: 'UTC', groupBy: 'provider' })).toEqual([])
    expect(service.exportCsv({})).toContain('inputTokens')
    database.close()
  })

  it('deduplicates quota snapshots when two profiles identify the same account', async () => {
    const { database, claude, service } = await setup()
    const profiles = new ProfileRepository(database, join(tmpdir(), 'gearmod-usage-second-profile'))
    const second = profiles.create({ provider: 'claude', label: 'Claude 2', scope: 'x' })
    const future = Math.floor(Date.now() / 1000) + 3600
    const firstPayload = { account: { accountId: 'same-account' }, rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: future } } } }
    service.recordClaude(claude.id, firstPayload)
    service.recordClaude(second.id, firstPayload)
    expect(database.db.prepare('SELECT count(*) AS count FROM quota_snapshots WHERE account_key IS NOT NULL').get()).toEqual({ count: 1 })
    expect(profiles.accountKey(claude.id)).toBe(profiles.accountKey(second.id))
    database.close()
  })

  it('probes Claude by itself when the last reading is old, and only then', async () => {
    const { root, database, claude } = await setup()
    const calls: string[] = []
    const future = Math.floor(Date.now() / 1000) + 3600
    const profiles = new ProfileRepository(database, root)
    const service = new UsageService(database, profiles, async (profile) => { calls.push(profile.id); return { rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: future } } } } })
    const first = await service.refresh(true)
    expect(calls).toEqual([claude.id]); expect(first.find((item) => item.profileId === claude.id)!.windows[0]!.usedPercent).toBe(40)
    await service.refresh(true); expect(calls).toHaveLength(1)
    const stale = new UsageService(database, profiles, async (profile) => { calls.push(profile.id); return null }, 0)
    await stale.refresh(true); expect(calls).toHaveLength(2)
    const failing = new UsageService(database, profiles, async () => { throw new Error('sem login') }, 0)
    expect((await failing.refresh(true)).find((item) => item.profileId === claude.id)!.windows[0]!.usedPercent).toBe(40)
    database.close()
  })
  it('Antigravity: reads the /usage screen on refresh, Gemini group first and the other groups labeled', async () => {
    const { root, database } = await setup()
    const profiles = new ProfileRepository(database, root)
    const gemini = profiles.create({ provider: 'gemini', label: 'Antigravity', scope: 'x' })
    let calls = 0
    const service = new UsageService(database, profiles, undefined, undefined, undefined, undefined, undefined, async () => { calls += 1; return [
      { id: 'seven_day', remainingPercent: 62.5, resetsInMs: 3 * 86_400_000 }, { id: 'five_hour', remainingPercent: 100, resetsInMs: null },
      { id: 'CLAUDE AND GPT:seven_day', remainingPercent: 90, resetsInMs: null }, { id: 'GEMINI 4 ARGON:seven_day', remainingPercent: 100, resetsInMs: null }
    ] })
    expect((await service.list()).find((item) => item.profileId === gemini.id)!.windows).toEqual([])
    const item = (await service.refresh(true)).find((entry) => entry.profileId === gemini.id)!
    expect(item.windows.map((window) => [window.id, window.label, window.usedPercent])).toEqual([
      ['five_hour', 'Gemini · Sessão de 5 horas', 0], ['seven_day', 'Gemini · Semana', 38],
      ['CLAUDE AND GPT:seven_day', 'Claude e GPT · Semana', 10], ['GEMINI 4 ARGON:seven_day', 'Gemini 4 Argon · Semana', 0]
    ])
    expect(item.windows[1]!.resetsAt).not.toBeNull()
    await service.refresh(true); expect(calls).toBe(1)
    database.close()
  })
})
