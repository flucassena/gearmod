import { existsSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentProfile, UsageWindow } from '@gearmod/contracts'
import type { AppDatabase } from './database'
import type { ProfileRepository } from './projects'
import { accountKeyFromProvider } from './account'
import type { UsageLedgerService } from './usage-ledger'
import type { Approval, ApprovalService } from './approvals'
import { tm } from './i18n'
import { antigravityGroupLabel, type AntigravityWindow } from './antigravity-usage'

const windowLabel = (id: string): string | undefined => id === 'five_hour' ? tm().usage.fiveHourSession : id === 'seven_day' ? tm().usage.week : undefined
/** Claude plan windows: `five_hour`, `seven_day` or the week of one model (`seven_day_opus`); variants like `seven_day_overage_included` repeat the week. */
export const isClaudePlanWindow = (id: string): boolean => /^(five_hour|seven_day)(_[a-z]+)?$/.test(id)
/** `seven_day_opus` → "Semana · Opus". */
const modelWeekLabel = (id: string): string | undefined => { const model = /^seven_day_([a-z]+)$/.exec(id)?.[1]; return model ? `${tm().usage.week} · ${model[0]!.toUpperCase()}${model.slice(1)}` : undefined }
const labelFor = (id: string, minutes?: number): string => windowLabel(id) ?? modelWeekLabel(id) ?? (minutes ? (minutes >= 10_080 ? tm().usage.week : minutes >= 1440 ? tm().usage.days(Math.round(minutes / 1440)) : tm().usage.hours(Math.round(minutes / 60))) : id)
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString()
const periods: Record<string, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86_400_000 }
/** Antigravity: `five_hour`/`seven_day` are the Gemini group; `<GROUP>:five_hour` the other groups (Claude and GPT, Argon…). */
const windowKind = (id: string): string => id.split(':').pop() ?? id
const antigravityLabel = (id: string): string => {
  const [group, kind] = id.includes(':') ? [antigravityGroupLabel(id.slice(0, id.lastIndexOf(':')), tm().usage.and), windowKind(id)] : ['Gemini', id]
  return `${group} · ${windowLabel(kind) ?? kind}`
}

/** Window that has already reset: goes back to 0% and the next reset is projected by adding the window period (5 h or a week). */
export function rollWindow(window: UsageWindow, now = Date.now()): UsageWindow {
  if (!window.resetsAt || Date.parse(window.resetsAt) > now) return window
  const period = periods[windowKind(window.id)]
  const next = period ? new Date(Date.parse(window.resetsAt) + Math.ceil((now - Date.parse(window.resetsAt) + 1) / period) * period).toISOString() : null
  return { ...window, usedPercent: 0, resetsAt: next }
}

/** Usage windows in a line of Codex sessions (`rate_limits` with `primary` and `secondary`); accepts variations in field names. */
export function parseCodexRateLimits(line: string): { windows: UsageWindow[]; at: string | null } | null {
  if (!line.includes('rate_limits')) return null
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return null }
  const find = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (record.rate_limits && typeof record.rate_limits === 'object') return record.rate_limits as Record<string, unknown>
    for (const nested of Object.values(record)) { const found = find(nested); if (found) return found }
    return null
  }
  const limits = find(parsed)
  if (!limits) return null
  const windows: UsageWindow[] = []
  for (const key of ['primary', 'secondary']) {
    const item = limits[key] as Record<string, unknown> | null | undefined
    if (!item || typeof item !== 'object') continue
    const percent = typeof item.used_percent === 'number' ? item.used_percent : typeof item.utilization === 'number' ? item.utilization * 100 : null
    if (percent === null) continue
    const minutes = typeof item.window_minutes === 'number' ? item.window_minutes : undefined
    const resets = typeof item.resets_at === 'number' ? iso(item.resets_at) : typeof item.resets_in_seconds === 'number' ? new Date(Date.now() + item.resets_in_seconds * 1000).toISOString() : null
    windows.push({ id: key === 'primary' ? 'five_hour' : 'seven_day', label: labelFor(key === 'primary' ? 'five_hour' : 'seven_day', minutes), usedPercent: Math.max(0, Math.min(100, Math.round(percent))), resetsAt: resets })
  }
  const at = typeof (parsed as { timestamp?: unknown }).timestamp === 'string' ? (parsed as { timestamp: string }).timestamp : null
  return windows.length ? { windows, at } : null
}

async function newestFiles(dir: string, limit: number): Promise<Array<{ path: string; mtime: number }>> {
  const files: Array<{ path: string; mtime: number }> = []
  const walk = async (current: string, depth: number): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = join(current, entry.name)
      if (entry.isDirectory() && depth < 5) await walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ path: full, mtime: (await stat(full)).mtimeMs })
    }
  }
  await walk(dir, 0)
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}

async function tail(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try { const { size } = await handle.stat(); const length = Math.min(size, bytes); const buffer = Buffer.alloc(length); await handle.read(buffer, 0, length, size - length); return buffer.toString('utf8') } finally { await handle.close() }
}

/** Session usage: Codex read from `<CODEX_HOME>/sessions/**\/*.jsonl`; Claude from the `rate_limit_event` that Claude Code emits on each run. */
export class UsageService {
  private readonly probing = new Set<string>()
  constructor(private readonly database: AppDatabase, private readonly profiles: ProfileRepository, private readonly probeClaude?: (profile: AgentProfile) => Promise<Record<string, unknown> | null>, private readonly staleMs = 10 * 60_000, private readonly readCodex?: (profile: AgentProfile) => Promise<Record<string, unknown> | null>, private readonly ledger?: UsageLedgerService, private readonly writeLegacySnapshots = process.env.GEARMOD_LEGACY_USAGE_SNAPSHOTS === '1', private readonly readAntigravity?: (profile: AgentProfile) => Promise<AntigravityWindow[] | null>) {}

  recordClaude(profileId: string, payload: Record<string, unknown>): void {
    const info = (payload.rate_limit_info ?? {}) as { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> }
    const upsert = this.database.db.prepare(`INSERT INTO agent_usage_snapshots(profile_id, window, utilization, resets_at, captured_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, window) DO UPDATE SET utilization = excluded.utilization, resets_at = excluded.resets_at, captured_at = excluded.captured_at`)
    const now = new Date().toISOString()
    const profile = this.profiles.get(profileId)
    const storedAccountKey = this.profiles.accountKey(profileId), derivedAccountKey = accountKeyFromProvider(profile.provider, payload)
    if (!storedAccountKey && derivedAccountKey) this.profiles.setAccountKey(profileId, derivedAccountKey)
    const accountKey = storedAccountKey ?? derivedAccountKey
    for (const [id, window] of Object.entries(info.unifiedWindows ?? {})) if (typeof window.utilization === 'number') {
      const resetsAt = typeof window.resetsAt === 'number' ? iso(window.resetsAt) : null
      if (this.writeLegacySnapshots) upsert.run(profileId, id, window.utilization, resetsAt, now)
      // Keep the legacy current-state table for one rollout cycle, while the new table is append-only and sampled.
      const previous = this.database.db.prepare(`SELECT used_percent AS usedPercent, resets_at AS resetsAt, captured_at AS capturedAt FROM quota_snapshots
        WHERE provider = ? AND bucket = ? AND ${accountKey ? 'account_key = ?' : 'profile_id = ?'} ORDER BY captured_at DESC, rowid DESC LIMIT 1`).get(profile.provider, id, accountKey ?? profileId) as { usedPercent: number; resetsAt: string | null; capturedAt: string } | undefined
      const changed = !previous || previous.usedPercent !== Math.round(window.utilization * 100) || previous.resetsAt !== resetsAt || Date.parse(now) - Date.parse(previous.capturedAt) >= 15 * 60_000
      if (changed) this.database.db.prepare(`INSERT INTO quota_snapshots(id,captured_at,provider,profile_id,account_key,bucket,window_id,used_percent,resets_at,window_duration_mins,reliability,source)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'reported','provider-event')`).run(randomUUID(), now, profile.provider, profileId, accountKey, id, id, Math.round(window.utilization * 100), resetsAt, null)
    }
  }

  private claude(profile: AgentProfile): { windows: UsageWindow[]; capturedAt: string | null } {
    // v32 is the durable source. The legacy table remains as a rollout fallback for databases predating the first snapshot.
    const accountKey = this.profiles.accountKey(profile.id)
    let rows = this.database.db.prepare(`SELECT q.bucket AS id, q.used_percent / 100.0 AS utilization, q.resets_at AS resetsAt, q.captured_at AS capturedAt FROM quota_snapshots q
      WHERE ${accountKey ? 'q.account_key = ?' : 'q.profile_id = ?'} AND q.rowid = (SELECT q2.rowid FROM quota_snapshots q2 WHERE ${accountKey ? 'q2.account_key=q.account_key' : 'q2.profile_id=q.profile_id'} AND q2.bucket=q.bucket ORDER BY q2.captured_at DESC, q2.rowid DESC LIMIT 1) ORDER BY q.bucket`).all(accountKey ?? profile.id) as Array<{ id: string; utilization: number; resetsAt: string | null; capturedAt: string }>
    if (!rows.length) rows = this.database.db.prepare('SELECT window AS id, utilization, resets_at AS resetsAt, captured_at AS capturedAt FROM agent_usage_snapshots WHERE profile_id = ? ORDER BY window').all(profile.id) as typeof rows
    // Claude: only the plan windows (older readings may have saved repeated variants of the week).
    if (profile.provider === 'claude') rows = rows.filter((row) => isClaudePlanWindow(row.id))
    const windows = rows.map((row) => rollWindow({ id: row.id, label: labelFor(row.id), usedPercent: Math.round(row.utilization * 100), resetsAt: row.resetsAt }))
    return { windows, capturedAt: rows.map((row) => row.capturedAt).sort().at(-1) ?? null }
  }

  /** Saved Antigravity windows: the Gemini group first (the quick panel reads its `five_hour`/`seven_day`), then the other groups. */
  private antigravity(profile: AgentProfile): { windows: UsageWindow[]; capturedAt: string | null } {
    const data = this.claude(profile), rank = (id: string): number => (id.includes(':') ? 1 : 0)
    const order = (id: string): number => (windowKind(id) === 'five_hour' ? 0 : 1)
    return { ...data, windows: data.windows.map((window) => ({ ...window, label: antigravityLabel(window.id) })).sort((a, b) => rank(a.id) - rank(b.id) || a.id.slice(0, a.id.lastIndexOf(':') + 1).localeCompare(b.id.slice(0, b.id.lastIndexOf(':') + 1)) || order(a.id) - order(b.id)) }
  }

  private async codex(profile: AgentProfile): Promise<{ windows: UsageWindow[]; capturedAt: string | null }> {
    if (this.readCodex) {
      try {
        const result = await this.readCodex(profile), limits = result?.rateLimits as Record<string, unknown> | undefined
        const windows = ([['primary', 'five_hour'], ['secondary', 'seven_day']] as const).flatMap(([key, id]) => {
          const item = limits?.[key] as Record<string, unknown> | undefined
          return item && typeof item.usedPercent === 'number' ? [{ id, label: labelFor(id, typeof item.windowDurationMins === 'number' ? item.windowDurationMins : undefined), usedPercent: Math.round(item.usedPercent), resetsAt: typeof item.resetsAt === 'number' ? iso(item.resetsAt) : null }] : []
        })
        if (windows.length) return { windows: windows.map((window) => rollWindow(window)), capturedAt: new Date().toISOString() }
      } catch { /* fallback below */ }
    }
    const dir = join(profile.configDir, 'sessions')
    if (!existsSync(dir)) return { windows: [], capturedAt: null }
    for (const file of await newestFiles(dir, 5)) {
      const lines = (await tail(file.path, 512 * 1024)).split('\n')
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const found = parseCodexRateLimits(lines[i]!)
        if (found) return { windows: found.windows.map((window) => rollWindow(window)), capturedAt: found.at ?? new Date(file.mtime).toISOString() }
      }
    }
    return { windows: [], capturedAt: null }
  }

  /**
   * Claude: besides the limit that comes with each run, the panel asks Claude Code for it (`get_usage`, the data behind `/usage`;
   * no prompt, nothing spent) and saves it. Only repeats when the data is more than 10 minutes old.
   */
  async refresh(explicit = false): Promise<Array<{ profileId: string; provider: 'claude' | 'codex' | 'gemini'; windows: UsageWindow[]; capturedAt: string | null; source: string }>> {
    if (explicit && this.probeClaude) {
      await Promise.all(this.profiles.list().filter((profile) => profile.provider === 'claude' && !this.probing.has(profile.id)).map(async (profile) => {
        const last = this.claude(profile).capturedAt
        if (last && Date.now() - Date.parse(last) < this.staleMs) return
        this.probing.add(profile.id)
        try { const payload = await this.probeClaude!(profile); this.ledger?.recordAuxiliary(profile, 'probe'); if (payload) this.recordClaude(profile.id, payload) } catch { /* no network or no login: keeps the last data */ } finally { this.probing.delete(profile.id) }
      }))
    }
    // Antigravity: the `/usage` screen read in a hidden terminal (nothing spent), saved like Claude's windows; same 10-minute rule.
    if (explicit && this.readAntigravity) {
      await Promise.all(this.profiles.list().filter((profile) => profile.provider === 'gemini' && !this.probing.has(profile.id)).map(async (profile) => {
        const last = this.claude(profile).capturedAt
        if (last && Date.now() - Date.parse(last) < this.staleMs) return
        this.probing.add(profile.id)
        try {
          const windows = await this.readAntigravity!(profile), now = Date.now()
          if (windows?.length) this.recordClaude(profile.id, { rate_limit_info: { unifiedWindows: Object.fromEntries(windows.map((window) => [window.id, { utilization: Math.max(0, Math.min(100, 100 - window.remainingPercent)) / 100, ...(window.resetsInMs !== null ? { resetsAt: Math.round((now + window.resetsInMs) / 1000) } : {}) }])) } })
        } catch { /* not installed or no login: keeps the last data */ } finally { this.probing.delete(profile.id) }
      }))
    }
    return this.list()
  }

  async list(): Promise<Array<{ profileId: string; provider: 'claude' | 'codex' | 'gemini'; windows: UsageWindow[]; capturedAt: string | null; source: string }>> {
    return Promise.all(this.profiles.list().map(async (profile) => {
      const data = profile.provider === 'claude' ? this.claude(profile) : profile.provider === 'gemini' ? this.antigravity(profile) : await this.codex(profile)
      return { profileId: profile.id, provider: profile.provider, ...data, source: profile.provider === 'claude' ? tm().usage.sourceClaude : profile.provider === 'gemini' ? tm().usage.sourceGemini : tm().usage.sourceCodex }
    }))
  }

  history(input: { granularity: 'day' | 'week' | 'month'; tz: string; groupBy: 'provider' | 'profile' | 'model' | 'project' | 'card' | 'purpose'; from?: string; to?: string }) { return this.requireLedger().history(input) }
  exportCsv(range: { from?: string; to?: string }) { return this.requireLedger().exportCsv(range) }
  requestPurge(approvals: ApprovalService, range: { from?: string; to?: string }): Approval { return this.requireLedger().requestPurge(approvals, range) }
  purge(approvals: ApprovalService, range: { from?: string; to?: string }, approvalId: string): { deleted: number; csv: string } { return this.requireLedger().purge(range, approvalId, approvals) }
  private requireLedger(): UsageLedgerService { if (!this.ledger) throw new Error(tm().usage.usageHistoryUnavailable); return this.ledger }
}
