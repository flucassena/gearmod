import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * Result of the Antigravity login check: `account` is the e-mail when found, else the plan name (e.g. "Antigravity Starter Quota").
 * `models` and `thoughtLevels` are what this account offers (a paid plan lists more models than the free one).
 */
export interface AntigravityAccount { authenticated: boolean; account: string | null; models: Array<{ id: string; label: string }>; thoughtLevels: string[] }
export type AntigravityCheck = (command: string, env: NodeJS.ProcessEnv) => Promise<AntigravityAccount>

/**
 * E-mail of the signed-in account, from Antigravity's own debug log. ACP does not report it; on start `agy` logs
 * `server_oauth.go:226] OAuth: authenticated successfully as <email>`. An internal format: when it changes, the plan name is shown instead.
 */
export function antigravityEmail(log: string): string | null {
  const match = /authenticated successfully as (\S+@\S+)/.exec(log) ?? /applyAuthResult: email=([^\s,]+@[^\s,]+)/.exec(log)
  return match?.[1]?.trim().slice(0, 320) ?? null
}

/** Plan name announced by `session/new` (`_meta.antigravity.tier.name`). */
export function antigravityTier(result: unknown): string | null {
  const tier = (result as { _meta?: { antigravity?: { tier?: { name?: unknown } } } } | undefined)?._meta?.antigravity?.tier
  return typeof tier?.name === 'string' ? tier.name.slice(0, 120) : null
}

/** Options of a `select` config option announced by `session/new` (`model`, `thought_level`). */
export function antigravityOptions(result: unknown, id: string): Array<{ id: string; label: string }> {
  const configOptions = (result as { configOptions?: unknown } | undefined)?.configOptions
  const option = (Array.isArray(configOptions) ? configOptions : []).find((item) => (item as { id?: unknown })?.id === id) as { options?: unknown } | undefined
  return (Array.isArray(option?.options) ? option.options : []).flatMap((item) => {
    const { value, name } = (item ?? {}) as { value?: unknown; name?: unknown }
    return typeof value === 'string' ? [{ id: value, label: typeof name === 'string' ? name : value }] : []
  })
}

/**
 * Checks the login without spending quota: `agy acp` + `initialize` + `session/new` (no prompt), then closes. Antigravity keeps one
 * Google account per OS user, so the profile folder plays no part. The log goes to a temporary file read only by this check.
 */
export const checkAntigravity: AntigravityCheck = (command, env) => new Promise((resolve) => {
  const dir = mkdtempSync(join(tmpdir(), 'gearmod-agy-')), logFile = join(dir, 'acp.log')
  let settled = false, nextId = 1
  const child = spawn(command, ['acp', '--log-file', logFile, '--disable-telemetry'], { cwd: dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
  const done = (authenticated: boolean, session: unknown = undefined): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try { child.stdin.end() } catch { /* already closed */ }
    child.kill()
    let email: string | null = null
    try { email = authenticated ? antigravityEmail(readFileSync(logFile, 'utf8')) : null } catch { /* no log */ }
    setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* the process may still hold the log for a moment */ } }, 2000).unref()
    resolve({ authenticated, account: email ?? antigravityTier(session), models: antigravityOptions(session, 'model'), thoughtLevels: antigravityOptions(session, 'thought_level').map((item) => item.id) })
  }
  const timer = setTimeout(() => done(false), 30_000)
  const send = (method: string, params: Record<string, unknown>): void => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })}\n`) }
  child.on('error', () => done(false))
  child.on('exit', () => done(false))
  child.stdin.on('error', () => undefined)
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: { id?: unknown; result?: Record<string, unknown>; error?: unknown }
    try { message = JSON.parse(line) } catch { return }
    if (message.id === 1) { if (message.error) done(false); else send('session/new', { cwd: dir, mcpServers: [] }) }
    else if (message.id === 2) {
      if (message.error || typeof message.result?.sessionId !== 'string') return done(false)
      // Best effort: closes the empty session so it does not pile up in Antigravity's conversation list.
      send('session/close', { sessionId: message.result.sessionId })
      setTimeout(() => done(true, message.result), 300)
    }
  })
  send('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } })
})
