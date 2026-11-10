import type { PullRequestSummary } from '@gearmod/contracts'
import type { DiffRow } from './prDiff'

export type PrSort = 'created-desc' | 'created-asc' | 'updated-desc' | 'updated-asc'
export type PrTab = 'open' | 'merged' | 'closed' | 'all'

/** Title, number, author or branch (head/base) contains the text. */
export function filterPrs(prs: PullRequestSummary[], query: string): PullRequestSummary[] {
  const needle = query.trim().toLowerCase().replace(/^#/, '')
  if (!needle) return prs
  return prs.filter((pr) => [pr.title, String(pr.number), pr.author, pr.head, pr.base].some((value) => value.toLowerCase().includes(needle)))
}

const time = (value: string): number => { const n = Date.parse(value); return Number.isNaN(n) ? 0 : n }
export function sortPrs(prs: PullRequestSummary[], sort: PrSort): PullRequestSummary[] {
  const field = sort.startsWith('created') ? 'createdAt' : 'updatedAt', direction = sort.endsWith('asc') ? 1 : -1
  return [...prs].sort((a, b) => (time(a[field]) - time(b[field])) * direction || b.number - a.number)
}

/** Quick filters of the list (chips): mine, waiting for my review, drafts, failed pipeline. */
export type PrQuick = 'mine' | 'review' | 'draft' | 'failed'
export function quickFilter(prs: PullRequestSummary[], quick: PrQuick | null, context: { viewer: string | null; pipeline(pr: PullRequestSummary): string | undefined }): PullRequestSummary[] {
  if (!quick) return prs
  return prs.filter((pr) => quick === 'mine' ? Boolean(context.viewer) && pr.author === context.viewer
    : quick === 'review' ? pr.reviewRequested
    : quick === 'draft' ? pr.draft
    : context.pipeline(pr) === 'failed')
}

/** The state chip of a row, by meaning: merged and approved are done (success), changes asked waits for the author (warning), draft and closed are neutral. */
export type PrStateChip = 'merged' | 'closed' | 'draft' | 'approved' | 'changes' | null
export function stateChip(pr: Pick<PullRequestSummary, 'state' | 'draft' | 'reviewDecision'>, approvals: number | null | undefined): PrStateChip {
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'CLOSED') return 'closed'
  if (pr.draft) return 'draft'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes'
  if (pr.reviewDecision === 'APPROVED' || (approvals ?? 0) > 0) return 'approved'
  return null
}

/** Items grouped by local day (the key is the day as shown), keeping their order. */
export function groupByDay<T>(items: T[], at: (item: T) => string, day: (value: string) => string): Array<{ day: string; items: T[] }> {
  const groups: Array<{ day: string; items: T[] }> = []
  for (const item of items) { const key = day(at(item)), last = groups.at(-1); if (last && last.day === key) last.items.push(item); else groups.push({ day: key, items: [item] }) }
  return groups
}

/** Tab counter: the number loaded, with "+" while the host has more pages (they come as the list scrolls). */
export const countLabel = (count: number, more = false): string => more ? `${count}+` : String(count)

/** Adds a further page to a list: rows already there (an updated PR can move between pages) are not repeated. */
export function appendPage(current: PullRequestSummary[], page: PullRequestSummary[]): PullRequestSummary[] {
  const seen = new Set(current.map((pr) => pr.number))
  return [...current, ...page.filter((pr) => !seen.has(pr.number))]
}

/** Of a dragged selection, the ends in diff order. Null when it crosses hunks or touches a hunk header (hidden lines between hunks are not commentable). */
export function lineSpan(from: DiffRow, to: DiffRow): { start: DiffRow; end: DiffRow } | null {
  if (from.kind === 'hunk' || to.kind === 'hunk' || from.hunk !== to.hunk) return null
  return from.id <= to.id ? { start: from, end: to } : { start: to, end: from }
}
