import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { IPty } from 'node-pty'

const require = createRequire(import.meta.url)

/**
 * Antigravity's quota is only shown by `/usage` in its interactive screen (no ACP method, no command line). GearMod opens `agy`
 * in a hidden terminal, sends `/usage` and reads the bars: nothing is spent. Each group of models has a weekly and a five-hour
 * limit; the first group (Gemini) becomes the agent's `five_hour`/`seven_day`, the others `<GROUP>:five_hour` and so on.
 */
export type AntigravityWindow = { id: string; remainingPercent: number; resetsInMs: number | null }

/* eslint-disable no-control-regex -- terminal escape codes are control characters by nature */
/** Terminal output as text: cursor positioning becomes a line break, forward moves become spaces, the rest is dropped. */
export function plainScreen(raw: string): string {
  return raw
    .replace(/\x1b\[\d+;\d+H/g, '\n')
    .replace(/\x1b\[(\d*)C/g, (_, count: string) => ' '.repeat(Number(count || 1)))
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?>=]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
}

/** "4h 12m", "2d 3h", "35 minutes" → milliseconds. */
function duration(text: string): number | null {
  let total = 0, found = false
  for (const [, value, unit] of text.matchAll(/(\d+)\s*(d|h|m)[a-z]*/gi)) {
    found = true
    total += Number(value) * ({ d: 86_400_000, h: 3_600_000, m: 60_000 }[unit!.toLowerCase() as 'd' | 'h' | 'm'])
  }
  return found ? total : null
}

/** Reads the `/usage` screen: group headings (upper case) followed by "Weekly/Five Hour Limit" entries with their bar and percent. */
export function parseAntigravityUsage(raw: string): AntigravityWindow[] {
  const lines = plainScreen(raw).split('\n').map((line) => line.trim()).filter(Boolean)
  const start = lines.findIndex((line) => /Models & Quota/i.test(line))
  const windows: AntigravityWindow[] = []
  let group: string | null = null, groups = 0, current: AntigravityWindow | null = null
  for (const line of lines.slice(start < 0 ? 0 : start)) {
    if (/^[A-Z][A-Z0-9 &-]{3,}$/.test(line)) { group = line.replace(/\s+MODELS$/, '').trim(); groups += 1; current = null; continue }
    const limit = /(Weekly|Five Hour)\s+Limit/i.exec(line)
    if (limit && group) {
      const kind = /weekly/i.test(limit[1]!) ? 'seven_day' : 'five_hour'
      current = { id: groups === 1 ? kind : `${group}:${kind}`, remainingPercent: NaN, resetsInMs: null }
      windows.push(current)
    }
    if (!current) continue
    const percent = /([\d.]+)\s*%/.exec(line)
    if (percent && Number.isNaN(current.remainingPercent)) current.remainingPercent = Number(percent[1])
    const reset = /(?:reset|refresh)\w*\s+(?:in\s+)?(.+)/i.exec(line)
    if (reset) current.resetsInMs = duration(reset[1]!)
  }
  return windows.filter((window) => Number.isFinite(window.remainingPercent))
}

/** "CLAUDE AND GPT" → "Claude and GPT"; short words in capitals stay that way except "and". */
export function antigravityGroupLabel(group: string, and: string): string {
  return group.split(/\s+/).map((word) => word === 'AND' ? and : word.length <= 3 && /[A-Z]/.test(word) ? word : `${word[0]}${word.slice(1).toLowerCase()}`).join(' ')
}

/**
 * Opens `agy` in a hidden terminal (an empty folder of its own, trusted on the first run), sends `/usage` and returns the screen.
 * Null when the screen does not show up in time (not installed, no login, the layout changed).
 */
export function readAntigravityUsage(command: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<AntigravityWindow[] | null> {
  const cwd = join(tmpdir(), 'gearmod-agy-usage')
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })
  const { spawn } = require('node-pty') as typeof import('node-pty')
  const clean = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  return new Promise((resolve) => {
    let proc: IPty
    try { proc = spawn(command, [], { cwd, env: { ...clean, TERM: 'xterm-256color' }, cols: 120, rows: 60, name: 'xterm-256color', useConpty: true }) } catch { resolve(null); return }
    let out = '', stage: 'start' | 'trusted' | 'asked' = 'start', mark = 0, settled = false
    const timers: NodeJS.Timeout[] = []
    const finish = (value: AntigravityWindow[] | null): void => {
      if (settled) return
      settled = true; timers.forEach(clearTimeout)
      try { proc.write('\x1b'); proc.kill() } catch { /* already closed */ }
      resolve(value)
    }
    timers.push(setTimeout(() => finish(stage === 'asked' ? parseAntigravityUsage(out.slice(mark)) : null), timeoutMs))
    proc.onExit(() => finish(null))
    proc.onData((data) => {
      out = (out + data).slice(-400_000)
      const text = plainScreen(out.slice(mark))
      if (stage === 'start' && /Do you trust/i.test(text)) { stage = 'trusted'; timers.push(setTimeout(() => proc.write('\r'), 300)); return }
      if (stage !== 'asked' && /\? for shortcuts/.test(text)) {
        stage = 'asked'; mark = out.length
        timers.push(setTimeout(() => { proc.write('/usage'); timers.push(setTimeout(() => proc.write('\r'), 400)) }, 800))
        return
      }
      // The quota screen ends with its own close hint; a little more time lets the last bars arrive.
      if (stage === 'asked' && /Models & Quota/.test(text) && /esc Close/i.test(text)) timers.push(setTimeout(() => finish(parseAntigravityUsage(out.slice(mark))), 500))
    })
  })
}
