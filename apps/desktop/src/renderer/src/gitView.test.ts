import { describe, expect, it } from 'vitest'
import type { GitRow } from '@gearmod/contracts'
import { agoLabel, commitDateLong, commitDateTime, ghostChip, graphEdges, initials, refChips, shortAgo, splitPath } from './gitView'

const now = Date.parse('2026-10-22T12:00:00Z')
const row = (hash: string, lane: number, parents: string[], extra: Partial<GitRow> = {}): GitRow => ({ hash, short: hash, parents, lane, author: 'Ana Souza', email: '', date: '2026-10-22T11:00:00Z', subject: hash, refs: [], cardId: null, agentProfileId: null, wip: null, ...extra })

describe('date labels', () => {
  it('groups by week and moves on to months and years', () => {
    expect(agoLabel('2026-10-20T00:00:00Z', now)).toBe('esta semana')
    expect(agoLabel(null, now)).toBe('esta semana')
    expect(agoLabel('2026-10-12T00:00:00Z', now)).toBe('semana passada')
    expect(agoLabel('2026-10-01T00:00:00Z', now)).toBe('há 3 semanas')
    expect(agoLabel('2026-07-01T00:00:00Z', now)).toBe('há 3 meses')
    expect(agoLabel('2024-10-01T00:00:00Z', now)).toBe('há 2 anos')
  })
  it('short time', () => {
    expect(shortAgo('2026-10-22T11:59:30Z', now)).toBe('agora')
    expect(shortAgo('2026-10-22T11:48:00Z', now)).toBe('12 min')
    expect(shortAgo('2026-10-22T09:00:00Z', now)).toBe('3 h')
    expect(shortAgo('2026-10-19T12:00:00Z', now)).toBe('3 dias')
  })
})

describe('commit date and time', () => {
  // Local time, so the expected text does not depend on the machine's time zone.
  const at = new Date(2026, 10, 11, 0, 25, 13).toISOString()
  it('follows the app language: day first in Portuguese, month first and AM/PM in English', () => {
    expect(commitDateTime(at, 'pt-BR')).toBe('11/11/2026 00:25')
    expect(commitDateTime(new Date(2026, 1, 3, 14, 5).toISOString(), 'pt-BR')).toBe('03/02/2026 14:05')
    expect(commitDateTime(new Date(2026, 1, 3, 14, 5).toISOString(), 'en-US')).toBe('02/03/2026 02:05 PM')
  })
  it('is empty without a date (changes not committed yet) and has a full form for the tooltip', () => {
    expect(commitDateTime(null)).toBe('')
    expect(commitDateLong(at, 'pt-BR')).toContain('2026')
  })
})

describe('branch chips', () => {
  it('merges local and origin into one chip and marks the current branch', () => {
    expect(refChips([{ name: 'main', kind: 'head' }, { name: 'origin/main', kind: 'remote' }, { name: 'origin/x', kind: 'remote' }, { name: 'v1', kind: 'tag' }])).toEqual([{ name: 'main', head: true, local: true, remote: true }, { name: 'x', remote: true }, { name: 'v1', tag: true }])
  })
  it('a row without a branch shows the one from its lane (above) or the main one in lane 0', () => {
    const rows = [row('a', 1, ['b'], { refs: [{ name: 'feat', kind: 'local' }] }), row('b', 1, ['c']), row('c', 0, [])]
    expect(ghostChip(rows, 1, 'main')).toEqual({ name: 'feat', local: true })
    expect(ghostChip(rows, 2, 'main')).toEqual({ name: 'main', local: true })
    expect(ghostChip(rows, 0, 'main')).toBeNull()
  })
})

describe('graph', () => {
  it('straight line in the same lane and a near-90° curve between lanes', () => {
    const rows = [row('a', 0, ['b']), row('b', 0, ['c']), row('x', 1, ['c']), row('c', 0, [])]
    const edges = graphEdges(rows, () => false)
    expect(edges[0]!.d).toBe('M16 18V54')
    expect(edges[2]!.d).toContain('Q')
    expect(edges[2]!.d.startsWith('M42 90V')).toBe(true)
  })
  it('a parent outside the list runs to the end and WIP is dashed', () => {
    const rows = [row('wip:main', 0, ['fora'], { wip: { modified: 1, added: 0, deleted: 0, staged: 0, branch: 'main' } })]
    const [edge] = graphEdges(rows, () => false)
    expect(edge).toMatchObject({ d: 'M16 18V36', wip: true })
  })
  it('fades what does not belong to the focused card', () => {
    const rows = [row('a', 0, ['b'], { cardId: 'c1' }), row('b', 0, [])]
    expect(graphEdges(rows, (r) => r.cardId !== 'c1')[0]!.dim).toBe(true)
  })
})

describe('names', () => {
  it('initials and path', () => {
    expect(initials('Ana Souza')).toBe('AS'); expect(initials('ana')).toBe('AN'); expect(initials('')).toBe('?')
    expect(splitPath('a/b/c.ts')).toEqual({ dir: 'a/b/', name: 'c.ts' }); expect(splitPath('c.ts')).toEqual({ dir: '', name: 'c.ts' })
  })
})
