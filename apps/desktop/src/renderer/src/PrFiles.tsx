import React, { useMemo, useState } from 'react'
import { useT } from './i18n'
import { buildTree, filterFiles, type TreeFile, type TreeNode } from './prFileTree'
import { ChevronDownSmallIcon, ChevronRightSmallIcon, FolderGlyph } from './icons'

/** Left bar of the PR changes: the changed files as a folder tree (or a flat list of full paths), with search, status and +/− per file. */
export function PrFiles({ files, picked, onPick, view = 'tree' }: { files: TreeFile[]; picked?: string; onPick(path: string): void; view?: 'tree' | 'list' }): React.JSX.Element {
  const t = useT().git.pr
  const [query, setQuery] = useState(''), [closed, setClosed] = useState<Set<string>>(() => new Set())
  const shown = useMemo(() => filterFiles(files, query), [files, query])
  const tree = useMemo(() => buildTree(shown), [shown])
  const additions = files.reduce((sum, file) => sum + file.additions, 0), deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const toggle = (path: string): void => setClosed((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next })
  const render = (nodes: TreeNode[], depth: number): React.JSX.Element[] => nodes.map((node) => {
    const pad = { paddingLeft: 8 + depth * 12 }
    if (node.type === 'dir') {
      const open = query.trim() !== '' || !closed.has(node.path)
      return <React.Fragment key={`d:${node.path}`}>
        <button type="button" className="prf-row dir" style={pad} aria-expanded={open} onClick={() => toggle(node.path)}><span className="prf-caret" aria-hidden="true">{open ? <ChevronDownSmallIcon /> : <ChevronRightSmallIcon />}</span><FolderGlyph className="prf-folder" /><span className="prf-name">{node.name}</span></button>
        {open && render(node.children, depth + 1)}
      </React.Fragment>
    }
    const { file } = node, on = picked === node.path
    return <button type="button" key={`f:${node.path}`} className={`prf-row file ${on ? 'on' : ''}`} style={pad} aria-current={on} data-tip={file.oldPath && file.oldPath !== file.path ? t.renamedFrom(file.oldPath) : node.path} onClick={() => onPick(node.path)}>
      <span className={`prf-st ${file.status}`} aria-label={t.fileStatus[file.status]}>{file.status === 'added' ? 'A' : file.status === 'removed' ? 'D' : file.status === 'renamed' ? 'R' : 'M'}</span>
      <span className="prf-name">{node.name}</span>
      <span className="nums"><span className="p">+{file.additions}</span> <span className="m">−{file.deletions}</span></span>
    </button>
  })
  const flat = (): React.JSX.Element[] => shown.map((file) => { const on = picked === file.path
    return <button type="button" key={`l:${file.path}`} className={`prf-row file ${on ? 'on' : ''}`} style={{ paddingLeft: 8 }} aria-current={on} data-tip={file.oldPath && file.oldPath !== file.path ? t.renamedFrom(file.oldPath) : file.path} onClick={() => onPick(file.path)}>
      <span className={`prf-st ${file.status}`} aria-label={t.fileStatus[file.status]}>{file.status === 'added' ? 'A' : file.status === 'removed' ? 'D' : file.status === 'renamed' ? 'R' : 'M'}</span>
      <span className="prf-name path">{file.path}</span>
      <span className="nums"><span className="p">+{file.additions}</span> <span className="m">−{file.deletions}</span></span>
    </button> })
  return <aside className="prf">
    <div className="prf-head"><span className="cglabel">{t.filesTotal(files.length, additions, deletions)}</span>
      <input className="in" type="search" value={query} aria-label={t.searchFiles} placeholder={t.searchFiles} onChange={(event) => setQuery(event.target.value)} /></div>
    <div className="prf-tree">{shown.length ? view === 'list' ? flat() : render(tree, 0) : <p className="gempty">{t.noFileMatch}</p>}</div>
  </aside>
}
