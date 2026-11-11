import type { GitRef, GitRow, GitRule } from '@gearmod/contracts'
import { dateLocale, tr } from './i18n'

/** Colors of the graph lanes, in lane order. */
export const laneColors = ['#8db99a', '#8fb8d6', '#e8c27a', '#b98fd6', '#e07a9a']
export const laneColor = (lane: number): string => laneColors[lane % laneColors.length]!
/** Horizontal position of a lane's dot. */
export const laneSpacing = 26
/** `spacing` shrinks with the graph column: the lanes get closer until they become a single line (spacing 0). */
export const laneX = (lane: number, spacing = laneSpacing): number => 16 + lane * spacing
export const rowHeight = 36

export const isWip = (row: GitRow): boolean => row.wip !== null

/** Date label by week: "this week", "last week", "N weeks ago"; after a month, months and years. */
export function agoLabel(date: string | null, now = Date.now()): string {
  const v = tr().git.view
  if (!date) return v.thisWeek
  const days = Math.max(0, Math.floor((now - new Date(date).getTime()) / 86_400_000))
  const weeks = Math.floor(days / 7)
  if (weeks === 0) return v.thisWeek
  if (weeks === 1) return v.lastWeek
  if (days < 35) return v.weeksAgo(weeks)
  const months = Math.floor(days / 30)
  if (months < 12) return v.monthsAgo(months)
  const years = Math.floor(days / 365)
  return v.yearsAgo(years)
}

/** Date and time of a commit in the app language: "11/11/2026 00:25" in Portuguese, "11/11/2026 12:25 AM" in English. */
export function commitDateTime(date: string | null, locale = dateLocale()): string {
  if (!date) return ''
  const at = new Date(date)
  return `${at.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })} ${at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`
}
/** The same, in full, for a tooltip: "terça-feira, 11 de novembro de 2026 00:25:13". */
export function commitDateLong(date: string | null, locale = dateLocale()): string {
  return date ? new Date(date).toLocaleString(locale, { dateStyle: 'full', timeStyle: 'medium' }) : ''
}

/** Short time for lists: "now", "12 min", "3 h", "2 days". */
export function shortAgo(date: string | null, now = Date.now()): string {
  const v = tr().git.view
  if (!date) return v.now
  const minutes = Math.max(0, Math.floor((now - new Date(date).getTime()) / 60_000))
  if (minutes < 1) return v.now
  if (minutes < 60) return v.minutes(minutes)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return v.hours(hours)
  const days = Math.floor(hours / 24)
  return v.days(days)
}

export interface RefChip { name: string; local?: boolean; remote?: boolean; head?: boolean; tag?: boolean }

/** One chip per branch: local (computer) and origin (cloud) together, instead of repeating the name with "origin/". */
export function refChips(refs: GitRef[]): RefChip[] {
  const map = new Map<string, RefChip>()
  for (const ref of refs) {
    const name = ref.kind === 'remote' ? ref.name.replace(/^[^/]+\//, '') : ref.name
    const chip = map.get(name) ?? { name }
    if (ref.kind === 'remote') chip.remote = true
    else if (ref.kind === 'tag') chip.tag = true
    else chip.local = true
    if (ref.kind === 'head') chip.head = true
    map.set(name, chip)
  }
  return [...map.values()]
}

/** On rows with no branch, that lane's branch (the nearest one above) appears dimmed on hover. */
export function ghostChip(rows: GitRow[], index: number, headName: string | null): RefChip | null {
  const row = rows[index]!
  if (row.refs.length || isWip(row) || row.stash) return null
  for (let i = index - 1; i >= 0; i--) {
    const above = rows[i]!
    if (above.lane === row.lane && above.refs.length) return refChips(above.refs)[0] ?? null
  }
  return row.lane === 0 && headName ? { name: headName, local: true } : null
}

/** Author initials for the graph dot. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase()
}

export interface GraphEdge { d: string; color: string; wip: boolean; dim: boolean }

/** Thin graph lines, with rounded corners of almost 90°. A parent outside the list (beyond the limit) goes down to the end. */
export function graphEdges(rows: GitRow[], dimmed: (row: GitRow) => boolean, height = rowHeight, spacing = laneSpacing): GraphEdge[] {
  const index = new Map(rows.map((row, i) => [row.hash, i]))
  const y = (i: number): number => i * height + height / 2
  const edges: GraphEdge[] = []
  const radius = 9
  rows.forEach((row, i) => {
    for (const hash of row.parents) {
      const j = index.get(hash), xi = laneX(row.lane, spacing), yi = y(i)
      if (j === undefined) { edges.push({ d: `M${xi} ${yi}V${rows.length * height}`, color: laneColor(row.lane), wip: isWip(row) || Boolean(row.stash), dim: dimmed(row) }); continue }
      const parent = rows[j]!, xj = laneX(parent.lane, spacing), yj = y(j), sign = Math.sign(xj - xi)
      const d = row.lane === parent.lane ? `M${xi} ${yi}V${yj}`
        : row.lane < parent.lane ? `M${xi} ${yi}H${xj - sign * radius}Q${xj} ${yi} ${xj} ${yi + radius}V${yj}`
          : `M${xi} ${yi}V${yj - radius}Q${xi} ${yj} ${xi + sign * radius} ${yj}H${xj}`
      edges.push({ d, color: laneColor(Math.max(row.lane, parent.lane)), wip: isWip(row) || Boolean(row.stash), dim: dimmed(row) || dimmed(parent) })
    }
  })
  return edges
}

/** Splits "folder/file.ts" into directory and name. */
export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf('/')
  return at < 0 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
}

export const ruleLabel = (rule: GitRule): string => tr().git.view.ruleLabel[rule]
export const ruleNote = (rule: GitRule): string => tr().git.view.ruleNote[rule]
