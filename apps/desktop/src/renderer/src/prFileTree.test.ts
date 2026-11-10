import { describe, expect, it } from 'vitest'
import { buildTree, filterFiles, type TreeFile, type TreeNode } from './prFileTree'

const f = (path: string): TreeFile => ({ path, status: 'modified', additions: 1, deletions: 0 })
const shape = (nodes: TreeNode[]): unknown[] => nodes.map((n) => n.type === 'dir' ? { [n.name]: shape(n.children) } : n.name)

describe('buildTree', () => {
  it('groups by folder, folders first, files alphabetical', () => {
    expect(shape(buildTree([f('z.md'), f('src/b.ts'), f('src/a.ts'), f('docs/x/y.md'), f('docs/x/z.md')]))).toEqual([{ 'docs/x': ['y.md', 'z.md'] }, { src: ['a.ts', 'b.ts'] }, 'z.md'])
  })
  it('compacts single-child folder chains but not folders with files', () => {
    expect(shape(buildTree([f('a/b/c/d.ts')]))).toEqual([{ 'a/b/c': ['d.ts'] }])
    expect(shape(buildTree([f('a/x.ts'), f('a/b/c.ts')]))).toEqual([{ a: [{ b: ['c.ts'] }, 'x.ts'] }])
  })
  it('keeps the full path in each node', () => {
    const [dir] = buildTree([f('a/b/c.ts')])
    expect(dir?.path).toBe('a/b')
    expect(dir?.type === 'dir' && dir.children[0]?.path).toBe('a/b/c.ts')
  })
})

describe('filterFiles', () => {
  it('filters by path text and keeps everything on an empty query', () => {
    const files = [f('src/App.tsx'), f('src/util.ts'), f('README.md')]
    expect(filterFiles(files, 'app').map((x) => x.path)).toEqual(['src/App.tsx'])
    expect(filterFiles(files, 'src/').map((x) => x.path)).toEqual(['src/App.tsx', 'src/util.ts'])
    expect(filterFiles(files, '  ')).toBe(files)
    expect(filterFiles(files, 'nada')).toEqual([])
  })
})
