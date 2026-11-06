import React, { useEffect, useMemo, useRef, useState } from 'react'
import { displayCombo, loadShortcuts } from '../shortcuts'
import { FileTypeIcon } from '../FileAppearance'
import { tabLabels, type ChangeRoot } from '../changes'
import { slashed } from './documents'
import { splitLineSuffix } from './position'
import { dropRecents, rankPaths } from './quickOpen'
import { ProjectSearch } from './ProjectSearch'
import { SymbolSearch } from './CodeNav'
import { useT } from '../i18n'

export type QuickMode = 'files' | 'content' | 'symbols'

/**
 * Ctrl+P box: with no text it lists recent files; with text it searches the project (fuzzy) and sorts in the renderer.
 * `name:42` opens directly at line 42. Symbols mode (Ctrl+T) searches the code index.
 */
export function QuickOpen({ context, roots, recents, open, close, initialMode = 'files', initialText = '' }: {
  context: { projectId: string; cardId: string | null }; roots: ChangeRoot[]; recents: string[]; open(path: string, line?: number, column?: number, length?: number): void; close(): void; initialMode?: QuickMode; initialText?: string
}): React.JSX.Element {
  const t = useT(), [text, setText] = useState(initialText), [mode, setMode] = useState(initialMode), [found, setFound] = useState<string[]>([]), [selected, setSelected] = useState(0), [error, setError] = useState('')
  const list = useRef<HTMLDivElement>(null), target = splitLineSuffix(text.trim())
  useEffect(() => {
    if (mode !== 'files' || !target.path) { setFound([]); return }
    let alive = true
    const timer = window.setTimeout(() => { void window.gearmod.invoke('workspace:search', { ...context, query: target.path, fuzzy: true }).then((result) => { if (alive) { setFound(result.paths); setError('') } }).catch(() => { if (alive) setError(t.files.editor.quickOpen.searchFailed) }) }, 120)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [target.path, mode, context.projectId, context.cardId])
  // Recents checked on disk (one listing per folder) before showing: deleted or renamed ones disappear.
  const [existing, setExisting] = useState<string[] | null>(null), recentKey = recents.join('\n')
  useEffect(() => {
    let current = true
    void existingRecents(context, recents).then(({ keep, gone }) => { if (!current) return; dropRecents(context.projectId, gone); setExisting(keep) })
    return () => { current = false }
  }, [recentKey, context.projectId, context.cardId])
  const ranked = useMemo(() => { const shown = existing ?? []; return (target.path ? rankPaths(target.path, found, shown) : rankPaths('', shown)).slice(0, 50) }, [target.path, found, existing])
  const labels = useMemo(() => tabLabels(ranked.map((item) => item.path), roots), [ranked, roots])
  useEffect(() => { setSelected(0) }, [target.path])
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected])
  const folderOf = (path: string): string => { const root = [...roots].sort((a, b) => b.path.length - a.path.length).find((item) => slashed(path).startsWith(`${slashed(item.path).replace(/\/$/, '')}/`)), relative = root ? path.replace(/\\/g, '/').slice(root.path.replace(/[\\/]+$/, '').length + 1) : path; return relative.split('/').slice(0, -1).join('/') }
  const choose = (index: number): void => { const item = ranked[index]; if (item) { close(); open(item.path, target.line, target.column) } }
  const keyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (mode !== 'files') return
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => Math.min(value + 1, ranked.length - 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => Math.max(value - 1, 0)) }
    else if (event.key === 'Enter') { event.preventDefault(); choose(selected) }
  }
  const keys = loadShortcuts()
  return <div className="qopen-back" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <div className="qopen" role="dialog" aria-modal="true" aria-label={t.files.editor.quickOpen.label} onKeyDown={keyDown}>
      <div className="qopen-modes" role="tablist" aria-label={t.files.editor.quickOpen.modes}><button type="button" role="tab" aria-selected={mode === 'files'} onClick={() => setMode('files')}>{t.files.editor.quickOpen.files} <small>{displayCombo(keys.quickOpenFile)}</small></button><button type="button" role="tab" aria-selected={mode === 'content'} onClick={() => setMode('content')}>{t.files.editor.quickOpen.content} <small>{displayCombo(keys.searchInFiles)}</small></button><button type="button" role="tab" aria-selected={mode === 'symbols'} onClick={() => setMode('symbols')}>{t.files.editor.codeNav.symbols} <small>{displayCombo(keys.searchSymbols)}</small></button><button type="button" className="qopen-close" aria-label={t.files.editor.quickOpen.closeSearch} onClick={close}>×</button></div>
      {mode === 'symbols' ? <SymbolSearch context={context} text={text} setText={setText} open={(path, line) => { close(); open(path, line) }} /> : mode === 'content' ? <ProjectSearch context={context} roots={roots} seed={{ text, at: 1 }} onQueryChange={setText} open={(path, line, column, length) => { close(); open(path, line, column, length) }} /> : <><input autoFocus className="in" placeholder={t.files.editor.quickOpen.placeholder} aria-label={t.files.editor.quickOpen.nameLabel} value={text} onChange={(event) => setText(event.target.value)} />
      <div className="qopen-list" role="listbox" ref={list}>
        {!target.path && ranked.length > 0 && <p className="qopen-note">{t.files.editor.quickOpen.recents}</p>}
        {ranked.map((item, index) => { const folder = folderOf(item.path), repo = labels[item.path]?.repo; return <button key={item.path} type="button" role="option" aria-selected={index === selected} className={`qopen-item ${index === selected ? 'on' : ''}`} data-tip={item.path} onMouseEnter={() => setSelected(index)} onClick={() => choose(index)}>
          <FileTypeIcon path={item.path} /><span className="qopen-name">{[...item.name].map((letter, at) => item.matched.includes(at) ? <mark key={at}>{letter}</mark> : letter)}</span><small>{[repo, folder].filter(Boolean).join(' › ')}</small></button> })}
        {!ranked.length && <p className="qopen-note">{error || (target.path ? t.files.editor.quickOpen.none : t.files.editor.quickOpen.hint)}</p>}
      </div></>}
    </div>
  </div>
}

/**
 * Separates the recents that still exist. Folder listed without the file = deleted (removed from storage);
 * folder that cannot be listed (gone or outside this context's roots) only hides it, without removing it from storage.
 */
async function existingRecents(context: { projectId: string; cardId: string | null }, recents: string[]): Promise<{ keep: string[]; gone: string[] }> {
  const split = (path: string): [string, string] => { const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')); return [path.slice(0, at), path.slice(at + 1).toLowerCase()] }
  const folders = [...new Set(recents.map((path) => split(path)[0]).filter(Boolean))]
  const listed = new Map(await Promise.all(folders.map(async (folder) => [folder, await window.gearmod.invoke('workspace:list', { ...context, path: folder }).then((entries) => new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.name.toLowerCase())), () => null)] as const)))
  const keep: string[] = [], gone: string[] = []
  for (const path of recents) {
    const [folder, name] = split(path), names = listed.get(folder)
    if (names?.has(name)) keep.push(path)
    else if (names) gone.push(path)
  }
  return { keep, gone }
}
