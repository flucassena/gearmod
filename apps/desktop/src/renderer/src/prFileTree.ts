export interface TreeFile { path: string; oldPath?: string; status: 'added' | 'modified' | 'removed' | 'renamed'; additions: number; deletions: number }
export type TreeNode = { type: 'dir'; name: string; path: string; children: TreeNode[] } | { type: 'file'; name: string; path: string; file: TreeFile }

/** Groups file paths into folders; folders with a single folder inside are compacted (`a/b/c`). Folders come first, then files, both alphabetical. */
export function buildTree(files: TreeFile[]): TreeNode[] {
  type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: TreeFile[] }
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let dir = root
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part)
      if (!next) { next = { name: part, path: dir.path ? `${dir.path}/${part}` : part, dirs: new Map(), files: [] }; dir.dirs.set(part, next) }
      dir = next
    }
    dir.files.push(file)
  }
  const convert = (dir: Dir): TreeNode[] => {
    const dirs: TreeNode[] = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((child) => {
      let node = child, name = child.name
      while (node.files.length === 0 && node.dirs.size === 1) { node = [...node.dirs.values()][0]!; name = `${name}/${node.name}` }
      return { type: 'dir' as const, name, path: node.path, children: convert(node) }
    })
    const leaves: TreeNode[] = [...dir.files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => ({ type: 'file' as const, name: file.path.split('/').at(-1)!, path: file.path, file }))
    return [...dirs, ...leaves]
  }
  return convert(root)
}

/** Keeps only the files whose path contains the text (case-insensitive); their folders stay because the tree is built after. */
export const filterFiles = (files: TreeFile[], query: string): TreeFile[] => {
  const needle = query.trim().toLowerCase()
  return needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files
}
