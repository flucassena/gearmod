import { describe, expect, it } from 'vitest'
import { pairRows, parseFileDiff, splitDiff } from './prDiff'

describe('splitDiff', () => {
  it('splits per file and reads the status from git markers or from the hunk header', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', '-old', '+new', '--- removed sql comment',
      'diff --git a/novo.ts b/novo.ts', 'new file mode 100644', '--- /dev/null', '+++ b/novo.ts', '@@ -0,0 +1 @@', '+x',
      'diff --git a/api.py b/api.py', '@@ -0,0 +1,2 @@', '+a', '+b',
      'diff --git a/old.py b/old.py', '--- a/old.py', '+++ b/old.py', '@@ -1,2 +0,0 @@', '-a', '-b',
    ].join('\r\n')
    const files = splitDiff(diff)
    expect([...files.keys()]).toEqual(['src/a.ts', 'novo.ts', 'api.py', 'old.py'])
    expect(files.get('src/a.ts')).toEqual({ status: 'M', lines: ['@@ -1,2 +1,2 @@', '-old', '+new', '--- removed sql comment'] })
    expect(files.get('novo.ts')?.status).toBe('A')
    expect(files.get('api.py')?.status).toBe('A')
    expect(files.get('old.py')).toEqual({ status: 'D', lines: ['@@ -1,2 +0,0 @@', '-a', '-b'] })
  })
})

describe('parseFileDiff', () => {
  const lines = ['@@ -1,3 +1,3 @@', ' a', '-b', '+B', '+C', ' d', '\\ No newline at end of file', '@@ -10,2 +11,2 @@', ' x', '-y', '+z']
  it('numbers old and new lines and counts positions like GitLab', () => {
    const rows = parseFileDiff(lines)
    expect(rows.map((r) => r.kind)).toEqual(['hunk', 'ctx', 'del', 'add', 'add', 'ctx', 'hunk', 'ctx', 'del', 'add'])
    expect(rows[1]).toMatchObject({ oldLine: 1, newLine: 1, oldPos: 1, newPos: 1 })
    expect(rows[2]).toMatchObject({ oldLine: 2, newLine: null, oldPos: 2, newPos: 2 })
    expect(rows[3]).toMatchObject({ oldLine: null, newLine: 2, oldPos: 3, newPos: 2 })
    expect(rows[4]).toMatchObject({ oldLine: null, newLine: 3, oldPos: 3, newPos: 3 })
    expect(rows[5]).toMatchObject({ oldLine: 3, newLine: 4 })
  })
  it('restarts counters in each hunk and tags the hunk index', () => {
    const rows = parseFileDiff(lines)
    expect(rows[7]).toMatchObject({ oldLine: 10, newLine: 11, hunk: 1 })
    expect(rows[9]).toMatchObject({ kind: 'add', newLine: 12, hunk: 1 })
  })
  it('handles a new file and a deleted file', () => {
    expect(parseFileDiff(['@@ -0,0 +1,2 @@', '+a', '+b']).map((r) => r.newLine)).toEqual([null, 1, 2])
    expect(parseFileDiff(['@@ -1,2 +0,0 @@', '-a', '-b']).map((r) => r.oldLine)).toEqual([null, 1, 2])
    expect(parseFileDiff([])).toEqual([])
  })
})

describe('pairRows', () => {
  it('puts removals next to additions and context on both sides', () => {
    const pairs = pairRows(parseFileDiff(['@@ -1,3 +1,4 @@', ' a', '-b', '-c', '+B', '+C', '+D', ' e']))
    expect(pairs.map((p) => [p.hunk ? 'h' : p.left?.text ?? '-', p.right?.text ?? '-'])).toEqual([['h', '-'], ['a', 'a'], ['b', 'B'], ['c', 'C'], ['-', 'D'], ['e', 'e']])
  })
  it('leaves the right side empty for a pure removal', () => {
    const pairs = pairRows(parseFileDiff(['@@ -1,1 +0,0 @@', '-a']))
    expect(pairs[1]).toMatchObject({ right: null })
    expect(pairs[1]?.left?.text).toBe('a')
  })
})
