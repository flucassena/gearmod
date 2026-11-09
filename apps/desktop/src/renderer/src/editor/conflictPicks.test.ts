import { describe, expect, it } from 'vitest'
import { blockOffset, composePicks, isResolved, parsePicks, pickEvery, pickWhole, sideFullyPicked, togglePick, type Picks } from './conflictPicks'

const file = 'a\n<<<<<<< HEAD\none\ntwo\n=======\nthree\n>>>>>>> topic\nz\n'

describe('conflict picks', () => {
  it('keeps the markers while nothing is picked', () => { const model = parsePicks(file); expect(composePicks(model, {})).toBe(file) })
  it('builds the output from picked lines, side A first', () => {
    const model = parsePicks(file); let picks: Picks = {}
    picks = togglePick(model, picks, 0, 'theirs', 0); picks = togglePick(model, picks, 0, 'ours', 1)
    expect(composePicks(model, picks)).toBe('a\ntwo\nthree\nz\n')
    expect(isResolved(picks, 0)).toBe(true)
  })
  it('picks a whole side, both, and unpicks back to the markers', () => {
    const model = parsePicks(file)
    expect(composePicks(model, pickWhole(model, {}, 0, 'both'))).toBe('a\none\ntwo\nthree\nz\n')
    expect(composePicks(model, pickWhole(model, {}, 0, 'theirs'))).toBe('a\nthree\nz\n')
    expect(composePicks(model, pickWhole(model, {}, 0, 'none'))).toBe(file)
  })
  it('handles two blocks and CRLF', () => {
    const text = '<<<<<<< A\r\nx\r\n=======\r\ny\r\n>>>>>>> B\r\nmid\r\n<<<<<<< A\r\n1\r\n=======\r\n2\r\n>>>>>>> B\r\n'
    const model = parsePicks(text)
    expect(model.blocks).toHaveLength(2)
    expect(composePicks(model, pickWhole(model, pickWhole(model, {}, 0, 'ours'), 1, 'theirs'))).toBe('x\r\nmid\r\n2\r\n')
  })
  it('picks a side everywhere and finds where a block starts in the output', () => {
    const text = 'a\n<<<<<<< A\nx\n=======\ny\n>>>>>>> B\nmid\n<<<<<<< A\n1\n=======\n2\n>>>>>>> B\n'
    const model = parsePicks(text), ours = pickEvery(model, {}, 'ours', true)
    expect(sideFullyPicked(model, ours, 'ours')).toBe(true)
    expect(sideFullyPicked(model, ours, 'theirs')).toBe(false)
    expect(composePicks(model, ours)).toBe('a\nx\nmid\n1\n')
    expect(blockOffset(model, ours, 0)).toBe(2)
    expect(blockOffset(model, ours, 1)).toBe(composePicks(model, ours).indexOf('1\n'))
    expect(blockOffset(model, {}, 1)).toBe(text.indexOf('<<<<<<< A', 5))
  })
})
