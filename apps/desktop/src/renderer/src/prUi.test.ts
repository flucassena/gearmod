import { describe, expect, it } from 'vitest'
import { applyMarkdown, duration, eventText, toggleReaction } from './prUi'

const words = { text: 'texto', code: 'código', column: 'Coluna' }

describe('toggleReaction', () => {
  it('flips only my reaction of that kind, and twice gives back the start', () => {
    const start = { up: 2, down: 0, mineUp: false, mineDown: false }
    expect(toggleReaction(start, 'up')).toEqual({ up: 3, down: 0, mineUp: true, mineDown: false })
    expect(toggleReaction(toggleReaction(start, 'down'), 'down')).toEqual(start)
  })
})

describe('applyMarkdown', () => {
  it('wraps the selection and keeps it selected', () => {
    expect(applyMarkdown('a palavra b', 2, 9, 'bold', words)).toEqual({ text: 'a **palavra** b', start: 4, end: 11 })
    expect(applyMarkdown('x', 1, 1, 'code', words)).toEqual({ text: 'x`código`', start: 2, end: 8 })
  })
  it('puts a block on its own line, without an empty line at the start', () => {
    expect(applyMarkdown('', 0, 0, 'ul', words).text).toBe('- ')
    expect(applyMarkdown('linha', 5, 5, 'task', words).text).toBe('linha\n- [ ] ')
    expect(applyMarkdown('', 0, 0, 'table', words).text).toBe('| Coluna | Coluna |\n| --- | --- |\n|  |  |\n')
  })
})

describe('eventText', () => {
  it('turns a GitLab system note into a sentence and its list', () => {
    const body = 'added 2 commits\n\n<ul><li>617742b9 - 1 commit from branch <code>develop</code></li><li>c66091d1 - feat(#ASF-10221): Visualização &amp; &lt;Login&gt;</li></ul>\n\n[Compare with previous version](/grupo/repo/-/merge_requests/210/diffs?diff_id=1&start_sha=abc)'
    expect(eventText(body)).toEqual({ text: 'added 2 commits', items: ['617742b9 - 1 commit from branch `develop`', 'c66091d1 - feat(#ASF-10221): Visualização & <Login>'] })
  })
  it('keeps plain notes and the label of absolute links', () => {
    expect(eventText('assigned to @ana')).toEqual({ text: 'assigned to @ana', items: [] })
    expect(eventText('mentioned in [!12](https://gitlab.com/g/r/-/merge_requests/12)')).toEqual({ text: 'mentioned in !12', items: [] })
  })
})

describe('duration', () => {
  it('reads seconds as s, min or h', () => {
    expect(duration(null)).toBe('')
    expect(duration(42)).toBe('42 s')
    expect(duration(192)).toBe('3 min 12 s')
    expect(duration(3840)).toBe('1 h 4 min')
  })
})
