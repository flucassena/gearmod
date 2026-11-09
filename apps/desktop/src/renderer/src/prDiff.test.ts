import { describe, expect, it } from 'vitest'
import { splitDiff } from './prDiff'

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
