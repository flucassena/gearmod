export type FileDiff = { status: 'A' | 'M' | 'D'; lines: string[] }

/**
 * Splits the PR diff per file. The status comes from git's markers or, in the API diffs (no markers), from the hunk header
 * (-0,0 = new, +0,0 = deleted). Header lines (index, ---/+++) are skipped only before the first hunk, so a removed "-- comment" stays.
 */
export function splitDiff(diff: string): Map<string, FileDiff> {
  const files = new Map<string, FileDiff>()
  let current: FileDiff | undefined, inHunk = false
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (head) { current = { status: 'M', lines: [] }; files.set(head[2]!, current); inHunk = false; continue }
    if (!current) continue
    if (line.startsWith('@@')) {
      if (/^@@ -0,0 /.test(line)) current.status = 'A'
      else if (/^@@ -\d+(,\d+)? \+0,0 @@/.test(line)) current.status = 'D'
      inHunk = true
    } else if (!inHunk) {
      if (line.startsWith('new file mode')) current.status = 'A'
      else if (line.startsWith('deleted file mode')) current.status = 'D'
      continue
    }
    current.lines.push(line)
  }
  return files
}

export type DiffRowKind = 'hunk' | 'ctx' | 'add' | 'del'
/** One line of a file's patch with its numbers. `oldPos`/`newPos` are the counters GitLab uses in `line_code` (counted for every line, also added and removed ones). */
export interface DiffRow { id: number; kind: DiffRowKind; text: string; oldLine: number | null; newLine: number | null; oldPos: number; newPos: number; hunk: number }

/** Reads the patch lines of one file (from `splitDiff`) into rows with old/new line numbers and positions. */
export function parseFileDiff(lines: string[]): DiffRow[] {
  const rows: DiffRow[] = []
  let oldCount = 0, newCount = 0, hunk = -1
  for (const line of lines) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (head) { hunk++; oldCount = Number(head[1]); newCount = Number(head[2]); rows.push({ id: rows.length, kind: 'hunk', text: line, oldLine: null, newLine: null, oldPos: oldCount, newPos: newCount, hunk }); continue }
    if (hunk < 0 || line.startsWith('\\')) continue
    const sign = line[0], text = line.slice(1)
    if (sign === '+') { rows.push({ id: rows.length, kind: 'add', text, oldLine: null, newLine: newCount, oldPos: oldCount, newPos: newCount, hunk }); newCount++ }
    else if (sign === '-') { rows.push({ id: rows.length, kind: 'del', text, oldLine: oldCount, newLine: null, oldPos: oldCount, newPos: newCount, hunk }); oldCount++ }
    else { rows.push({ id: rows.length, kind: 'ctx', text, oldLine: oldCount, newLine: newCount, oldPos: oldCount, newPos: newCount, hunk }); oldCount++; newCount++ }
  }
  return rows
}

export interface SideRow { hunk?: DiffRow; left: DiffRow | null; right: DiffRow | null }
/** Side-by-side layout: context on both sides; a run of removals sits next to the run of additions that follows it. */
export function pairRows(rows: DiffRow[]): SideRow[] {
  const out: SideRow[] = []
  let index = 0
  while (index < rows.length) {
    const row = rows[index]!
    if (row.kind === 'hunk') { out.push({ hunk: row, left: null, right: null }); index++; continue }
    if (row.kind === 'ctx') { out.push({ left: row, right: row }); index++; continue }
    const dels: DiffRow[] = [], adds: DiffRow[] = []
    while (rows[index]?.kind === 'del') dels.push(rows[index++]!)
    while (rows[index]?.kind === 'add') adds.push(rows[index++]!)
    for (let n = 0; n < Math.max(dels.length, adds.length); n++) out.push({ left: dels[n] ?? null, right: adds[n] ?? null })
  }
  return out
}
