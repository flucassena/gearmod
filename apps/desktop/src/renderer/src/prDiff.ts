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
