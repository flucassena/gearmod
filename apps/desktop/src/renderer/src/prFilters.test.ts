import { describe, expect, it } from 'vitest'
import type { PullRequestSummary } from '@gearmod/contracts'
import { parseFileDiff } from './prDiff'
import { appendPage, countLabel, filterPrs, groupByDay, lineSpan, quickFilter, sortPrs, stateChip } from './prFilters'

const pr = (number: number, over: Partial<PullRequestSummary> = {}): PullRequestSummary => ({ number, title: `Titulo ${number}`, url: '', draft: false, head: 'feat/x', base: 'main', updatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', state: 'OPEN', reviewDecision: null, author: 'ana', comments: 0, reviewRequested: false, labels: [], assignees: [], ...over })

describe('quickFilter', () => {
  const list = [pr(1, { author: 'eu' }), pr(2, { reviewRequested: true }), pr(3, { draft: true }), pr(4)]
  const context = { viewer: 'eu', pipeline: (p: PullRequestSummary) => p.number === 4 ? 'failed' : 'success' }
  it('keeps mine, review asked, drafts or failed pipelines', () => {
    expect(quickFilter(list, 'mine', context).map((p) => p.number)).toEqual([1])
    expect(quickFilter(list, 'review', context).map((p) => p.number)).toEqual([2])
    expect(quickFilter(list, 'draft', context).map((p) => p.number)).toEqual([3])
    expect(quickFilter(list, 'failed', context).map((p) => p.number)).toEqual([4])
    expect(quickFilter(list, null, context)).toBe(list)
  })
  it('"mine" is empty without a known viewer', () => { expect(quickFilter(list, 'mine', { ...context, viewer: null })).toEqual([]) })
})

describe('stateChip', () => {
  it('reads state, draft, decision and approvals in that order', () => {
    expect(stateChip(pr(1, { state: 'MERGED', draft: true }), 0)).toBe('merged')
    expect(stateChip(pr(1, { state: 'CLOSED' }), 3)).toBe('closed')
    expect(stateChip(pr(1, { draft: true, reviewDecision: 'APPROVED' }), 1)).toBe('draft')
    expect(stateChip(pr(1, { reviewDecision: 'CHANGES_REQUESTED' }), 2)).toBe('changes')
    expect(stateChip(pr(1, { reviewDecision: 'APPROVED' }), null)).toBe('approved')
    expect(stateChip(pr(1), 1)).toBe('approved')
    expect(stateChip(pr(1), 0)).toBeNull()
  })
})

describe('groupByDay', () => {
  it('groups consecutive items of the same day', () => {
    const items = [{ at: '2026-11-10T10:00' }, { at: '2026-11-10T08:00' }, { at: '2026-11-06T09:00' }]
    expect(groupByDay(items, (item) => item.at, (value) => value.slice(0, 10)).map((group) => [group.day, group.items.length])).toEqual([['2026-11-10', 2], ['2026-11-06', 1]])
  })
})

describe('filterPrs', () => {
  const list = [pr(1, { title: 'Corrige login' }), pr(22, { author: 'bia', head: 'fix/menu' }), pr(3, { base: 'develop' })]
  it('matches title, number, author and branch', () => {
    expect(filterPrs(list, 'login').map((p) => p.number)).toEqual([1])
    expect(filterPrs(list, '#22').map((p) => p.number)).toEqual([22])
    expect(filterPrs(list, 'BIA').map((p) => p.number)).toEqual([22])
    expect(filterPrs(list, 'fix/menu').map((p) => p.number)).toEqual([22])
    expect(filterPrs(list, 'develop').map((p) => p.number)).toEqual([3])
    expect(filterPrs(list, ' ')).toBe(list)
  })
})

describe('sortPrs', () => {
  const list = [pr(1, { createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' }), pr(2, { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z' }), pr(3, { createdAt: '2026-01-03T00:00:00Z', updatedAt: '2026-04-01T00:00:00Z' })]
  it('orders by created or updated, both ways, without mutating', () => {
    expect(sortPrs(list, 'created-desc').map((p) => p.number)).toEqual([3, 1, 2])
    expect(sortPrs(list, 'created-asc').map((p) => p.number)).toEqual([2, 1, 3])
    expect(sortPrs(list, 'updated-desc').map((p) => p.number)).toEqual([2, 3, 1])
    expect(sortPrs(list, 'updated-asc').map((p) => p.number)).toEqual([1, 3, 2])
    expect(list.map((p) => p.number)).toEqual([1, 2, 3])
  })
})

describe('countLabel', () => {
  it('adds + while there are more pages', () => { expect(countLabel(7)).toBe('7'); expect(countLabel(50)).toBe('50'); expect(countLabel(50, true)).toBe('50+'); expect(countLabel(100, true)).toBe('100+') })
})

describe('appendPage', () => {
  it('appends without repeating a PR that moved between pages', () => {
    expect(appendPage([pr(1), pr(2)], [pr(2), pr(3)]).map((p) => p.number)).toEqual([1, 2, 3])
  })
})

describe('lineSpan', () => {
  const rows = parseFileDiff(['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', '@@ -20,1 +20,1 @@', ' z'])
  it('orders the ends when dragging down or up', () => {
    expect(lineSpan(rows[1]!, rows[3]!)).toEqual({ start: rows[1], end: rows[3] })
    expect(lineSpan(rows[3]!, rows[1]!)).toEqual({ start: rows[1], end: rows[3] })
    expect(lineSpan(rows[2]!, rows[2]!)).toEqual({ start: rows[2], end: rows[2] })
  })
  it('refuses crossing hunks and hunk headers', () => {
    expect(lineSpan(rows[1]!, rows[6]!)).toBeNull()
    expect(lineSpan(rows[0]!, rows[2]!)).toBeNull()
  })
})
