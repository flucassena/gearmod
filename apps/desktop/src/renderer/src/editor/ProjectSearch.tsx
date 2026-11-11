import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { IpcOutput } from '@gearmod/contracts'
import { FileTypeIcon } from '../FileAppearance'
import { plainError } from '../NoticeDialog'
import { slashed, nameOf } from './documents'
import { useT } from '../i18n'
import { ChevronRightSmallIcon } from '../icons'

type Result = IpcOutput<'workspace:grep'>['results'][number]
type Root = { path: string; name: string; worktree: boolean }
const repoName = (root: Root | undefined, path: string): string => root ? (root.worktree ? root.name.replace(/^\d+-/, '') : root.name) : nameOf(path)

/**
 * Search in the project's content (side of Files mode): field, Aa / whole word / regex, file filter and the results
 * grouped by repository (when there is more than one) and by file. Clicking opens the file at the line, with the match selected.
 */
export function ProjectSearch({ context, roots, seed, open, onQueryChange }: {
  context: { projectId: string; cardId: string | null }; roots: Root[]; seed: { text: string; at: number } | undefined; open(path: string, line: number, column: number, length: number): void; onQueryChange?(value: string): void
}): React.JSX.Element {
  const t = useT(), [query, setQuery] = useState(''), [include, setInclude] = useState(''), [options, setOptions] = useState({ caseSensitive: false, wholeWord: false, regex: false })
  const [data, setData] = useState<IpcOutput<'workspace:grep'>>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [closed, setClosed] = useState<string[]>([])
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => { if (seed) { if (seed.text) setQuery(seed.text); field.current?.focus(); field.current?.select() } }, [seed?.at])
  useEffect(() => {
    if (!query.trim()) { setData(undefined); setError(''); setBusy(false); return }
    let alive = true; setBusy(true)
    const timer = window.setTimeout(() => {
      void window.gearmod.invoke('workspace:grep', { ...context, query, ...options, ...(include.trim() ? { include: include.trim() } : {}) })
        .then((result) => { if (alive) { setData(result); setError('') } }).catch((reason) => { if (alive) { setData(undefined); setError(plainError(reason)) } }).finally(() => { if (alive) setBusy(false) })
    }, 300)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [query, include, options.caseSensitive, options.wholeWord, options.regex, context.projectId, context.cardId])
  const groups = useMemo(() => {
    const byRoot = new Map<string, Map<string, Result[]>>()
    for (const item of data?.results ?? []) { const files = byRoot.get(item.root) ?? new Map<string, Result[]>(); files.set(item.path, [...(files.get(item.path) ?? []), item]); byRoot.set(item.root, files) }
    return [...byRoot.entries()].map(([root, files]) => ({ root, name: repoName(roots.find((item) => slashed(item.path) === slashed(root)), root), files: [...files.entries()] }))
  }, [data, roots])
  const total = data?.results.length ?? 0, fileCount = groups.reduce((sum, group) => sum + group.files.length, 0)
  const relativeTo = (root: string, path: string): string => path.replace(/\\/g, '/').slice(root.replace(/[\\/]+$/, '').length + 1)
  return <div className="wf-psearch">
    <div className={`wf-findbox ${error ? 'invalid' : ''}`}><input ref={field} placeholder={t.files.editor.projectSearch.placeholder} aria-label={t.files.editor.projectSearch.inputLabel} value={query} onChange={(event) => { setQuery(event.target.value); onQueryChange?.(event.target.value) }} />
      {([['caseSensitive', t.files.find.caseSensitive, 'Aa'], ['wholeWord', t.files.find.wholeWord, 'ab'], ['regex', t.files.find.regex, '.*']] as const).map(([key, label, text]) => <button key={key} type="button" className={`wf-findopt ${options[key] ? 'on' : ''}`} data-tip={label} aria-label={label} aria-pressed={options[key]} onClick={() => setOptions({ ...options, [key]: !options[key] })}>{text}</button>)}
    </div>
    <input className="in wf-include" placeholder={t.files.editor.projectSearch.includePlaceholder} aria-label={t.files.editor.projectSearch.includeLabel} value={include} onChange={(event) => setInclude(event.target.value)} />
    <div className="wf-psearch-list" role="tree" aria-label={t.files.editor.projectSearch.resultsLabel}>
      {busy && <p className="wf-note">{t.files.editor.projectSearch.searching}</p>}
      {error && <p className="wf-note error">{error}</p>}
      {data && !busy && !error && <p className="wf-note">{total ? t.files.editor.projectSearch.summary(total, data.limited, fileCount) : t.files.editor.projectSearch.none}</p>}
      {groups.map((group) => <div key={group.root} className="wf-psearch-repo">
        {groups.length > 1 && <div className="wf-psearch-repohead" data-tip={group.root}>{group.name}<span>{group.files.reduce((sum, [, items]) => sum + items.length, 0)}</span></div>}
        {group.files.map(([path, items]) => { const shut = closed.includes(path); return <div key={path} role="treeitem" aria-expanded={!shut}>
          <button type="button" className="wf-psearch-file" data-tip={path} onClick={() => setClosed((all) => shut ? all.filter((item) => item !== path) : [...all, path])}><span className={`wf-chevron ${shut ? '' : 'open'}`} aria-hidden="true"><ChevronRightSmallIcon /></span><FileTypeIcon path={path} /><b>{nameOf(path)}</b><small>{relativeTo(group.root, path).split('/').slice(0, -1).join('/')}</small><span className="wf-psearch-count">{items.length}</span></button>
          {!shut && items.map((item) => <button key={`${item.line}:${item.column}`} type="button" className="wf-psearch-hit" onClick={() => open(item.path, item.line, item.column, item.matchEnd - item.matchStart)}><span className="wf-psearch-line">{item.line}</span><span className="wf-psearch-text">{item.preview.slice(0, item.matchStart).trimStart()}<mark>{item.preview.slice(item.matchStart, item.matchEnd)}</mark>{item.preview.slice(item.matchEnd)}</span></button>)}
        </div> })}
      </div>)}
    </div>
  </div>
}
