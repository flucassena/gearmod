import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Commit message convention of each repository, kept in `commit-conventions.json` in the app data folder (one entry per repository).
 * It is found by analyzing the repository history, saved with the analysis date and analyzed again on its own when it gets old,
 * by whoever needs it first (an agent in a card, an agent commit, the commit-message suggestion). No setting: the app keeps it.
 */

/** An entry older than this is analyzed again. */
export const conventionMaxAgeMs = 30 * 24 * 60 * 60 * 1000
/** With little history the pattern is not settled yet: look again sooner. */
export const thinHistoryMaxAgeMs = 24 * 60 * 60 * 1000
/** Fewer subjects than this is "little history". */
export const thinHistory = 10
/** How many recent subjects the analysis reads. */
export const historySize = 150

export type CommitLanguage = 'pt' | 'en' | 'mixed' | 'unknown'
export type TicketPlacement = 'scope' | 'prefix' | 'suffix' | 'body'

export interface CommitConventionRules {
  /** Share of subjects in the Conventional Commits form `type(scope): text` (0 to 1). */
  conventional: number
  /** Most used types, most frequent first. */
  types: string[]
  /** Share of subjects that reference a ticket (e.g. `#ASF-9503`, `ABC-12`). */
  ticket: number
  /** Where the ticket usually goes, and how it is written (e.g. `#ASF-9503`). */
  ticketPlacement: TicketPlacement | null
  ticketSample: string | null
  language: CommitLanguage
  /** Share whose text (after the prefix) starts with a capital letter. */
  capitalized: number
  /** Share that ends with a period. */
  trailingPeriod: number
  medianLength: number
  maxLength: number
}

export interface CommitConvention {
  /** Repository folder (main checkout, not a card worktree). */
  repoPath: string
  repoName: string
  /** How messages are written in this repository, for agents and for the suggestion. */
  description: string
  /** Real or model messages of this repository. */
  examples: string[]
  /** Measured from the history in the last analysis. */
  rules: CommitConventionRules
  /** Subjects read in the last analysis. */
  sampleSize: number
  /** ISO date of the last analysis. */
  analyzedAt: string
  /** `auto`: deduced by the app from the history; `agent`: reviewed and saved by an agent. */
  source: 'auto' | 'agent'
}

interface StoreFile { version: 1; repos: Record<string, CommitConvention> }

const conventionalHeader = /^([a-zA-Z]+)(\(([^)]*)\))?!?:\s*(.*)$/
const ticketPattern = /#?\b[A-Z][A-Z0-9]{1,9}-\d+\b|#\d+\b/

const ptWords = new Set(['de', 'da', 'do', 'das', 'dos', 'para', 'com', 'em', 'no', 'na', 'nos', 'nas', 'e', 'ao', 'os', 'as', 'um', 'uma', 'n\u00e3o', 'nao', 'que', 'por', 'quando', 'adiciona', 'adicionar', 'corrige', 'corrigir', 'ajusta', 'ajustar', 'remove', 'remover', 'atualiza', 'atualizar', 'cria', 'criar', 'melhora', 'nova', 'novo', 'inclui', 'altera', 'alterar', 'implementa', 'tela', 'campo', 'erro'])
const enWords = new Set(['the', 'to', 'for', 'with', 'and', 'of', 'in', 'on', 'from', 'when', 'into', 'add', 'adds', 'added', 'fix', 'fixes', 'fixed', 'update', 'updates', 'remove', 'removes', 'create', 'improve', 'use', 'make', 'allow', 'support', 'move', 'rename', 'refactor', 'bump', 'new', 'not', 'is', 'a', 'an'])

/** Reads the language of one subject from its words: `pt`, `en` or null when it cannot tell. */
export function subjectLanguage(subject: string): 'pt' | 'en' | null {
  const text = subject.toLowerCase()
  const words = text.normalize('NFC').split(/[^a-zà-ÿ]+/).filter(Boolean)
  let pt = /[ãõçáéíóúâêô]/.test(text) ? 2 : 0, en = 0
  for (const word of words) { if (ptWords.has(word)) pt += 1; if (enWords.has(word)) en += 1 }
  // short words shared by both ("a", "e", "no") weigh less than a clear signal
  if (pt === en) return null
  return pt > en ? 'pt' : 'en'
}

const share = (count: number, total: number): number => total ? Math.round((count / total) * 100) / 100 : 0
const percent = (value: number): string => `${Math.round(value * 100)}%`

/** Measures the history (most recent first). Merge and revert subjects are left out. */
export function measureHistory(subjects: string[]): { rules: CommitConventionRules; used: string[] } {
  const used = subjects.map((item) => item.trim()).filter((item) => item && !/^(merge|revert)\b/i.test(item) && !/^Merged? /.test(item))
  const total = used.length
  const types = new Map<string, number>(), placements = new Map<TicketPlacement, number>(), languages = { pt: 0, en: 0 }
  let conventional = 0, ticket = 0, capitalized = 0, period = 0, ticketSample: string | null = null
  for (const subject of used) {
    const header = conventionalHeader.exec(subject)
    const text = header ? header[4]! : subject
    if (header) { conventional += 1; const type = header[1]!.toLowerCase(); types.set(type, (types.get(type) ?? 0) + 1) }
    const found = ticketPattern.exec(subject)
    if (found) {
      ticket += 1; ticketSample ??= found[0]
      const placement: TicketPlacement = header?.[3] && ticketPattern.test(header[3]) ? 'scope' : found.index <= 2 || subject.slice(0, found.index).trim().replace(/[[\]:(]/g, '') === '' ? 'prefix' : found.index + found[0].length >= subject.replace(/[).\]\s]+$/, '').length ? 'suffix' : 'body'
      placements.set(placement, (placements.get(placement) ?? 0) + 1)
    }
    const first = text.replace(/^[^A-Za-zÀ-ÿ]+/, '').charAt(0)
    if (first && first === first.toUpperCase() && first !== first.toLowerCase()) capitalized += 1
    if (/[^.]\.$/.test(subject)) period += 1
    const language = subjectLanguage(text)
    if (language) languages[language] += 1
  }
  const lengths = used.map((item) => item.length).sort((a, b) => a - b)
  const known = languages.pt + languages.en
  const language: CommitLanguage = known < Math.max(2, total * 0.3) ? 'unknown' : languages.pt / known >= 0.75 ? 'pt' : languages.en / known >= 0.75 ? 'en' : 'mixed'
  const placement = [...placements.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  return {
    used,
    rules: {
      conventional: share(conventional, total),
      types: [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([type]) => type),
      ticket: share(ticket, total),
      ticketPlacement: placement,
      ticketSample,
      language,
      capitalized: share(capitalized, total),
      trailingPeriod: share(period, total),
      medianLength: lengths.length ? lengths[Math.floor(lengths.length / 2)]! : 0,
      maxLength: lengths.length ? lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.9))]! : 0
    }
  }
}

const languageNames: Record<CommitLanguage, string> = { pt: 'Portuguese', en: 'English', mixed: 'Portuguese and English (follow the language of the most recent commits)', unknown: 'not clear from the history' }

/** Describes the measured rules in a few lines, for agents and for the suggestion model. */
export function describeRules(rules: CommitConventionRules, sampleSize: number): string {
  if (sampleSize < 3) return 'The repository has almost no commit history yet, so there is no settled pattern: write a short, imperative first line in the language the user works in.'
  const lines: string[] = []
  if (rules.conventional >= 0.6) {
    const ticketInScope = rules.ticket >= 0.5 && rules.ticketPlacement === 'scope'
    lines.push(`Conventional Commits: \`type(scope): text\` (${percent(rules.conventional)} of recent commits). Types used: ${rules.types.join(', ') || 'feat, fix'}.${ticketInScope ? ` The scope is the ticket, e.g. \`${rules.types[0] ?? 'feat'}(${rules.ticketSample ?? '#ABC-123'}): ...\`.` : ''}`)
  } else if (rules.conventional >= 0.2) lines.push(`Conventional Commits only in part of the history (${percent(rules.conventional)}); follow the form of the most recent examples.`)
  else lines.push('No Conventional Commits prefix: the subject is plain text.')
  if (rules.ticket >= 0.5) lines.push(`References a ticket in ${percent(rules.ticket)} of commits (written like \`${rules.ticketSample ?? '#ABC-123'}\`, ${rules.ticketPlacement === 'scope' ? 'as the scope' : rules.ticketPlacement === 'prefix' ? 'at the start' : rules.ticketPlacement === 'suffix' ? 'at the end' : 'inside the text'}). Use the card's ticket (usually in the branch name or the card title); if there is none, leave the ticket out rather than inventing one.`)
  else if (rules.ticket >= 0.15) lines.push(`Some commits reference a ticket (like \`${rules.ticketSample ?? '#ABC-123'}\`); include it when the card has one.`)
  lines.push(`Language: ${languageNames[rules.language]}.`)
  lines.push(`Text after the prefix starts with ${rules.capitalized >= 0.6 ? 'a capital letter' : rules.capitalized <= 0.3 ? 'a lowercase letter' : 'either case'}; ${rules.trailingPeriod >= 0.5 ? 'ends with a period' : 'no period at the end'}.`)
  lines.push(`Subject length: usually about ${rules.medianLength} characters, up to ${Math.max(rules.maxLength, 50)}.`)
  return lines.join('\n')
}

/** Picks up to `count` examples: the most recent subjects, preferring ones in the dominant form. */
export function pickExamples(used: string[], rules: CommitConventionRules, count = 6): string[] {
  const fits = (subject: string): boolean => rules.conventional >= 0.6 ? conventionalHeader.test(subject) : true
  const chosen = [...new Set(used.filter(fits))].slice(0, count)
  return chosen.length ? chosen : used.slice(0, count)
}

/** Deduces the convention from the history (most recent first). */
export function analyzeHistory(repo: { path: string; name: string }, subjects: string[], now = new Date()): CommitConvention {
  const { rules, used } = measureHistory(subjects)
  return { repoPath: repo.path, repoName: repo.name, description: describeRules(rules, used.length), examples: pickExamples(used, rules), rules, sampleSize: used.length, analyzedAt: now.toISOString(), source: 'auto' }
}

/** Whether the entry is old enough to analyze again. */
export function isStale(entry: Pick<CommitConvention, 'analyzedAt' | 'sampleSize'>, now = Date.now()): boolean {
  const at = Date.parse(entry.analyzedAt)
  if (!Number.isFinite(at)) return true
  return now - at > (entry.sampleSize < thinHistory ? thinHistoryMaxAgeMs : conventionMaxAgeMs)
}

/**
 * Checks a message against the measured form. Only what is clear in the history blocks: the Conventional Commits prefix
 * when most commits use it. The rest (ticket, language) becomes a note.
 */
export function checkMessage(message: string, entry: CommitConvention): { ok: boolean; problems: string[]; notes: string[] } {
  const subject = message.split(/\r?\n/)[0]!.trim(), { rules } = entry
  const problems: string[] = [], notes: string[] = []
  if (entry.sampleSize < thinHistory) return { ok: true, problems, notes }
  const header = conventionalHeader.exec(subject)
  if (rules.conventional >= 0.7 && !header) problems.push(`the subject has no Conventional Commits prefix; this repository uses \`type(scope): text\` (types: ${rules.types.join(', ')})`)
  if (rules.conventional <= 0.1 && header && !rules.types.includes(header[1]!.toLowerCase())) notes.push('this repository does not use the `type(scope):` prefix')
  if (rules.ticket >= 0.7 && !ticketPattern.test(subject)) notes.push(`most commits here reference a ticket (like \`${rules.ticketSample ?? '#ABC-123'}\`); add the card's ticket if it has one`)
  const language = subjectLanguage(header ? header[4]! : subject)
  if ((rules.language === 'pt' || rules.language === 'en') && language && language !== rules.language) notes.push(`commits here are written in ${languageNames[rules.language]}`)
  return { ok: problems.length === 0, problems, notes }
}

/** Text given to agents and to the suggestion model. */
export function formatConvention(entry: CommitConvention): string {
  return `Commit message convention of ${entry.repoName} (analyzed ${entry.analyzedAt.slice(0, 10)} from ${entry.sampleSize} commits${entry.source === 'agent' ? ', reviewed by an agent' : ''}):\n${entry.description}${entry.examples.length ? `\n\nExamples:\n${entry.examples.map((item) => `- ${item}`).join('\n')}` : ''}`
}

/** Key of a repository in the file: its folder, with the same separators and case on every call. */
export function repoKey(path: string): string {
  const normal = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' || process.platform === 'darwin' ? normal.toLowerCase() : normal
}

export class CommitConventionStore {
  private readonly inFlight = new Map<string, Promise<CommitConvention>>()

  constructor(private readonly file: string, private readonly now: () => Date = () => new Date()) {}

  private read(): StoreFile {
    try {
      if (!existsSync(this.file)) return { version: 1, repos: {} }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreFile>
      return { version: 1, repos: parsed && typeof parsed.repos === 'object' && parsed.repos ? parsed.repos : {} }
    } catch { return { version: 1, repos: {} } }
  }

  private write(data: StoreFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`)
    renameSync(temp, this.file)
  }

  get(repoPath: string): CommitConvention | undefined { return this.read().repos[repoKey(repoPath)] }

  all(): CommitConvention[] { return Object.values(this.read().repos) }

  put(entry: CommitConvention): CommitConvention {
    const data = this.read()
    data.repos[repoKey(entry.repoPath)] = entry
    this.write(data)
    return entry
  }

  /**
   * Returns the saved convention; with none, or an old one, analyzes the history (`readHistory`, most recent first) and saves it first.
   * Two callers at the same time share one analysis.
   */
  async ensure(repo: { path: string; name: string }, readHistory: () => Promise<string[]>): Promise<{ entry: CommitConvention; refreshed: boolean; previous?: CommitConvention }> {
    const key = repoKey(repo.path), saved = this.read().repos[key]
    if (saved && !isStale(saved, this.now().getTime())) return { entry: saved, refreshed: false }
    let running = this.inFlight.get(key)
    if (!running) {
      running = readHistory().then((subjects) => this.put(analyzeHistory(repo, subjects, this.now()))).finally(() => this.inFlight.delete(key))
      this.inFlight.set(key, running)
    }
    return { entry: await running, refreshed: true, previous: saved }
  }

  /** An agent's review: its description and examples, with the rules measured now from the history. */
  async save(repo: { path: string; name: string }, input: { description: string; examples: string[] }, readHistory: () => Promise<string[]>): Promise<CommitConvention> {
    const measured = analyzeHistory(repo, await readHistory(), this.now())
    return this.put({ ...measured, description: input.description.trim(), examples: input.examples.map((item) => item.trim()).filter(Boolean).slice(0, 12), source: 'agent' })
  }
}
