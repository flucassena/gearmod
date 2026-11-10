import { createHash } from 'node:crypto'

/** One end of a commented range: line numbers (old/new) and the positions the patch counts for every line, as GitLab does in `line_code`. */
export interface DiffPoint { oldLine: number | null; newLine: number | null; oldPos: number; newPos: number }
export interface LineCommentInput { body: string; path: string; oldPath: string; headSha: string; baseSha: string | null; startSha: string | null; start: DiffPoint; end: DiffPoint }

const sameLine = (a: DiffPoint, b: DiffPoint): boolean => a.oldLine === b.oldLine && a.newLine === b.newLine
/** Added and context lines are commented on the new side; only removed lines go to the old side. */
const side = (p: DiffPoint): 'RIGHT' | 'LEFT' => p.newLine !== null ? 'RIGHT' : 'LEFT'
const lineOf = (p: DiffPoint): number => (p.newLine ?? p.oldLine) as number

export function githubLineBody(input: LineCommentInput): Record<string, unknown> {
  const body: Record<string, unknown> = { body: input.body, commit_id: input.headSha, path: input.path, line: lineOf(input.end), side: side(input.end) }
  if (!sameLine(input.start, input.end)) { body.start_line = lineOf(input.start); body.start_side = side(input.start) }
  return body
}

export const lineCode = (path: string, oldPos: number, newPos: number): string => `${createHash('sha1').update(path).digest('hex')}_${oldPos}_${newPos}`

export function gitlabLineBody(input: LineCommentInput): Record<string, unknown> {
  const lines = (p: DiffPoint): Record<string, number> => ({ ...(p.oldLine !== null ? { old_line: p.oldLine } : {}), ...(p.newLine !== null ? { new_line: p.newLine } : {}) })
  const position: Record<string, unknown> = { position_type: 'text', base_sha: input.baseSha, start_sha: input.startSha, head_sha: input.headSha, old_path: input.oldPath, new_path: input.path, ...lines(input.end) }
  if (!sameLine(input.start, input.end)) {
    // Only line_code and type: the API turns old_line/new_line inside line_range into text, and the
    // position's JSON schema wants integers, so sending them fails with "must be a valid json schema".
    // GitLab works out the lines from line_code.
    const point = (p: DiffPoint): Record<string, unknown> => ({ line_code: lineCode(input.path, p.oldPos, p.newPos), type: p.newLine !== null ? 'new' : 'old' })
    position.line_range = { start: point(input.start), end: point(input.end) }
  }
  return { body: input.body, position }
}
