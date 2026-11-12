import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { antigravityGroupLabel, parseAntigravityUsage, plainScreen } from './antigravity-usage'

// `/usage` screen of agy 1.5.5 (Google AI Pro), recorded through a hidden terminal; e-mail and folder anonymized.
const screen = readFileSync(fileURLToPath(new URL('./fixtures/antigravity/usage-tui.txt', import.meta.url)), 'utf8')

describe('Antigravity quota from the /usage screen', () => {
  it('reads each group: the Gemini group as the main windows, the others prefixed with their group', () => {
    expect(parseAntigravityUsage(screen)).toEqual([
      { id: 'seven_day', remainingPercent: 100, resetsInMs: null },
      { id: 'five_hour', remainingPercent: 100, resetsInMs: null },
      { id: 'CLAUDE AND GPT:seven_day', remainingPercent: 100, resetsInMs: null },
      { id: 'CLAUDE AND GPT:five_hour', remainingPercent: 100, resetsInMs: null },
      { id: 'GEMINI 4 ARGON:seven_day', remainingPercent: 100, resetsInMs: null }
    ])
  })

  it('reads the remaining percent and the reset time when the quota is in use', () => {
    const used = '\x1b[16;1H└ Models & Quota\x1b[20;1HGEMINI MODELS\x1b[23;1H  Weekly Limit Remaining\x1b[24;5H[████░░░░]\x1b[2m 62.50%\x1b[25;5HResets in 3d 4h\x1b[27;1H  Five Hour Limit Remaining\x1b[28;5H[██░░]\x1b[2m 20.00%\x1b[29;5HResets in 1h 30m'
    expect(parseAntigravityUsage(used)).toEqual([
      { id: 'seven_day', remainingPercent: 62.5, resetsInMs: (3 * 24 + 4) * 3_600_000 },
      { id: 'five_hour', remainingPercent: 20, resetsInMs: 90 * 60_000 }
    ])
  })

  it('a screen without the quota gives nothing', () => {
    expect(parseAntigravityUsage('Welcome to the Antigravity CLI')).toEqual([])
    expect(plainScreen('\x1b[1mA\x1b[2;1HB\x1b[3CC')).toBe('A\nB   C')
  })

  it('group names for the usage panel', () => {
    expect(antigravityGroupLabel('CLAUDE AND GPT', 'e')).toBe('Claude e GPT')
    expect(antigravityGroupLabel('GEMINI 4 ARGON', 'and')).toBe('Gemini 4 Argon')
  })
})
