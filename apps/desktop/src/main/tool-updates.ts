import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { specKitCompatSchema, toolKeys, type SpecKitCompat, type ToolVersions } from '@gearmod/contracts'
import { tm } from './i18n'

type Key = typeof toolKeys[number]
/** Where the latest version of each tool comes from: npm package or GitHub release. */
const sources: Record<Key, { kind: 'npm'; name: string } | { kind: 'github'; repo: string }> = {
  claude: { kind: 'npm', name: '@anthropic-ai/claude-code' }, codex: { kind: 'npm', name: '@openai/codex' }, gemini: { kind: 'npm', name: '@google/gemini-cli' }, openspec: { kind: 'npm', name: '@fission-ai/openspec' },
  playwright: { kind: 'npm', name: '@playwright/cli' }, specify: { kind: 'github', repo: 'github/spec-kit' }
}
const day = 24 * 60 * 60 * 1000
/** Verdicts of the scheduled CI job, published as an asset of a fixed release so no commit or site deploy is needed. */
export const specCompatUrl = 'https://github.com/flucassena/gearmod/releases/download/speckit-compat/speckit-compat.json'
const compatTtl = 60 * 60 * 1000
export type FetchJson = (url: string, timeoutMs: number) => Promise<unknown>
const nativeFetch: FetchJson = async (url, timeoutMs) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json', 'user-agent': 'GearMod' } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}
const empty = (): ToolVersions => ({ checkedAt: null, versions: { claude: null, codex: null, gemini: null, specify: null, openspec: null, playwright: null }, error: null })

/**
 * Latest published version of Claude Code, Codex, Spec Kit, OpenSpec and Playwright CLI, to warn about updates. Fetches at most once every 24 h
 * (or with `force`), saves the result in a file and, without internet, returns what it had with `error` instead of blowing up.
 */
export class ToolUpdateService {
  private cache: ToolVersions | null = null
  constructor(private readonly file: string, private readonly fetchJson: FetchJson = nativeFetch, private readonly now: () => number = Date.now) {}

  private load(): ToolVersions {
    if (this.cache) return this.cache
    try { const saved = JSON.parse(readFileSync(this.file, 'utf8')) as ToolVersions; this.cache = { ...empty(), ...saved, versions: { ...empty().versions, ...saved.versions }, error: null } } catch { this.cache = empty() }
    return this.cache
  }

  private compatCache: { at: number; value: SpecKitCompat } | null = null
  /**
   * Which Spec Kit versions the CI job verified against GearMod's contract. Read at most once an hour; the content goes through the schema (anything
   * malformed counts as "no verdict"), and offline it keeps the last good answer. It only decides whether the update button shows: the install command stays fixed in the app.
   */
  async compat(): Promise<SpecKitCompat> {
    const file = `${this.file}.compat`
    if (!this.compatCache) { try { this.compatCache = { at: 0, value: specKitCompatSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) } } catch { this.compatCache = { at: 0, value: { checkedAt: null, versions: {} } } } }
    if (this.now() - this.compatCache.at < compatTtl) return this.compatCache.value
    try {
      const data = await this.fetchJson(specCompatUrl, 8000) as { generatedAt?: unknown; versions?: unknown }
      const parsed = specKitCompatSchema.safeParse({ checkedAt: typeof data.generatedAt === 'string' ? data.generatedAt : null, versions: data.versions ?? {} })
      if (parsed.success) { this.compatCache = { at: this.now(), value: parsed.data }; try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(parsed.data)) } catch { /* only the offline copy */ } }
      else this.compatCache = { at: this.now(), value: this.compatCache.value }
    } catch { this.compatCache = { at: this.now() - compatTtl + 5 * 60_000, value: this.compatCache.value } }
    return this.compatCache.value
  }

  /** Returns only the last saved result; does not query the network. */
  cached(): ToolVersions { return this.load() }

  async latest(force = false): Promise<ToolVersions> {
    const cached = this.load()
    if (!force && cached.checkedAt && this.now() - Date.parse(cached.checkedAt) < day) return cached
    const versions = { ...cached.versions }
    let failed = 0
    await Promise.all(toolKeys.map(async (key) => {
      const source = sources[key]
      try {
        const data = await this.fetchJson(source.kind === 'npm' ? `https://registry.npmjs.org/${source.name.replace('/', '%2F')}/latest` : `https://api.github.com/repos/${source.repo}/releases/latest`, 8000) as { version?: unknown; tag_name?: unknown }
        const text = source.kind === 'npm' ? data.version : data.tag_name
        if (typeof text !== 'string' || !text) throw new Error('resposta sem versão')
        versions[key] = text.replace(/^v/i, '')
      } catch { failed++ }
    }))
    const error = failed ? tm().toolUpdates.checkFailed : null
    // Only marks as checked when everything responded; this way a failure does not hide the next attempt for 24 h.
    this.cache = { checkedAt: failed ? cached.checkedAt : new Date(this.now()).toISOString(), versions, error }
    if (failed < toolKeys.length) { try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify({ checkedAt: this.cache.checkedAt, versions })) } catch { /* it just does not save the cache */ } }
    return this.cache
  }
}
