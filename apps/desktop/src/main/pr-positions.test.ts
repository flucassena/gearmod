import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { githubLineBody, gitlabLineBody, lineCode, type DiffPoint, type LineCommentInput } from './pr-positions'

const added = (n: number, pos: number): DiffPoint => ({ oldLine: null, newLine: n, oldPos: pos - 1, newPos: pos })
const removed = (n: number, pos: number): DiffPoint => ({ oldLine: n, newLine: null, oldPos: pos, newPos: pos - 1 })
const context = (o: number, n: number): DiffPoint => ({ oldLine: o, newLine: n, oldPos: o, newPos: n })
const base = (start: DiffPoint, end: DiffPoint): LineCommentInput => ({ body: 'oi', path: 'a/b.ts', oldPath: 'a/old.ts', headSha: 'abc', baseSha: 'b1', startSha: 's1', start, end })

describe('githubLineBody', () => {
  it('uses RIGHT for an added line', () => expect(githubLineBody(base(added(5, 5), added(5, 5)))).toEqual({ body: 'oi', commit_id: 'abc', path: 'a/b.ts', line: 5, side: 'RIGHT' }))
  it('uses LEFT for a removed line', () => expect(githubLineBody(base(removed(3, 3), removed(3, 3)))).toMatchObject({ line: 3, side: 'LEFT' }))
  it('uses RIGHT for context', () => expect(githubLineBody(base(context(2, 4), context(2, 4)))).toMatchObject({ line: 4, side: 'RIGHT' }))
  it('sends start_line and start_side for a range', () => expect(githubLineBody(base(added(5, 5), added(7, 7)))).toMatchObject({ start_line: 5, start_side: 'RIGHT', line: 7, side: 'RIGHT' }))
})

describe('gitlabLineBody', () => {
  it('sends new_line for an added line, without a range', () => {
    const { position } = gitlabLineBody(base(added(5, 5), added(5, 5))) as { position: Record<string, unknown> }
    expect(position).toMatchObject({ position_type: 'text', base_sha: 'b1', start_sha: 's1', head_sha: 'abc', old_path: 'a/old.ts', new_path: 'a/b.ts', new_line: 5 })
    expect(position).not.toHaveProperty('old_line')
    expect(position).not.toHaveProperty('line_range')
  })
  it('sends old_line for a removed line', () => {
    const { position } = gitlabLineBody(base(removed(3, 3), removed(3, 3))) as { position: Record<string, unknown> }
    expect(position).toMatchObject({ old_line: 3 })
    expect(position).not.toHaveProperty('new_line')
  })
  it('sends both for a context line', () => {
    const { position } = gitlabLineBody(base(context(2, 4), context(2, 4))) as { position: Record<string, unknown> }
    expect(position).toMatchObject({ old_line: 2, new_line: 4 })
  })
  it('builds line_range with line_code = sha1(path)_oldPos_newPos', () => {
    const { position } = gitlabLineBody(base(added(5, 6), removed(8, 9))) as { position: { line_range: { start: Record<string, unknown>; end: Record<string, unknown> } } }
    const sha = createHash('sha1').update('a/b.ts').digest('hex')
    // Only line_code and type: GitLab's API turns line numbers inside line_range into text and its schema rejects that.
    expect(position.line_range.start).toEqual({ line_code: `${sha}_5_6`, type: 'new' })
    expect(position.line_range.end).toEqual({ line_code: `${sha}_9_8`, type: 'old' })
    expect(lineCode('a/b.ts', 1, 2)).toBe(`${sha}_1_2`)
  })
})
