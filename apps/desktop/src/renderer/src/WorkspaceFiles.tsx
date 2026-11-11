import React, { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import { filesQuickEvent, isShortcut, shortcutFor } from './shortcuts'
import type { IpcOutput } from '@gearmod/contracts'
import { Checkbox } from './Checkbox'
import { Select } from './Select'
import { plainError } from './NoticeDialog'
import { BranchIcon, ChevronRightSmallIcon, CloseIcon, CollapseIcon, DiffIcon, DockIcon, ExpandIcon, FolderGlyph, ListIcon, NewFileIcon, NewFolderIcon, SearchIcon, TreeIcon } from './icons'
import { WindowLayoutMenu } from './WindowLayoutMenu'
import { ConfirmDialog } from './ConfirmDialog'
import { FileContextMenu, type FileMenuItem } from './FileContextMenu'
import { FileTypeIcon } from './FileAppearance'
import { terminal } from './terminalStore'
import { findChange, groupChanges, type FileChange } from './changes'
import { shortcutList } from './editor/keymap'
import { splitLineSuffix } from './editor/position'
import { FilePane, type PaneCommand } from './editor/FilePane'
import { GitContextChip } from './editor/GitContextChip'
import { nameOf, slashed, type Document } from './editor/documents'
import { usePreferences, type Preferences } from './editor/preferences'
import { useFileDocuments } from './editor/useFileDocuments'
import { withEol } from './editor/position'
import { QuickOpen, type QuickMode } from './editor/QuickOpenDialog'
import { pushRecent, readRecents } from './editor/quickOpen'
import { useAsk } from './useAsk'
import { useEscape } from './useEscape'
import { useT } from './i18n'

type Entry = IpcOutput<'workspace:list'>[number] & { branch?: string | null; worktree?: boolean; primary?: boolean; cardId?: string | null; cardTitle?: string | null }
type Position = 'left' | 'right' | 'top' | 'bottom'
const positionKey = 'gearmod.filePanelPosition'
/** Panel that currently reserves space beside the main content (only one at a time). */
let dockOwner: HTMLElement | null = null
/** The files panel opens on the left and remembers the position the user chose in "Move". */
const readPosition = (): Position => { try { const saved = localStorage.getItem(positionKey); return saved === 'right' || saved === 'top' || saved === 'bottom' ? saved : 'left' } catch { return 'left' } }
const pathKey = (path: string): string => path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase()

type TreeEdit = { type: 'create'; kind: 'file' | 'folder'; parent: string } | { type: 'rename'; path: string }
const parentOf = (path: string): string => path.replace(/[\\/][^\\/]*$/, '')

/** Field text without trimming: whitespace at the ends goes to main and becomes an invalid-name error. */
const typed = (value: string): string | null => value.trim() ? value : null

/** Text field in place of the row (new item or rename): Enter confirms, Esc cancels, losing focus confirms if there is text. */
function TreeInput({ initial, directory, depth, finish }: { initial: string; directory: boolean; depth: number; finish(name: string | null): void }): React.JSX.Element {
  const t = useT(), done = useRef(false), field = useRef<HTMLInputElement>(null)
  const end = (value: string | null): void => { if (done.current) return; done.current = true; finish(value) }
  useEffect(() => { const input = field.current; if (!input) return; input.focus(); const dot = initial.lastIndexOf('.'); input.setSelectionRange(0, !directory && dot > 0 ? dot : initial.length) }, [])
  return <div className="wf-treeitem editing" style={{ paddingLeft: 10 + depth * 13 }}><span className="wf-chevron" aria-hidden="true" /><FileTypeIcon path={initial || 'novo'} directory={directory} /><input ref={field} className="wf-treeinput" aria-label={initial ? t.files.tree.newName : directory ? t.files.tree.folderName : t.files.tree.fileName} defaultValue={initial} spellCheck={false} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); end(typed(event.currentTarget.value)) } else if (event.key === 'Escape') { event.preventDefault(); end(null) } }} onBlur={(event) => end(typed(event.currentTarget.value))} /></div>
}

function TreeFolder({ entry, context, contexts, selected, open, reveal, menu, editing, finish, ask, create, nonce, depth = 0 }: { entry: Entry; context: { projectId: string; cardId: string | null }; contexts: IpcOutput<'workspace:roots'>; selected?: string; open(path: string, pinned?: boolean): void; reveal?: { path: string; at: number }; menu(entry: Entry, event: React.MouseEvent): void; editing: TreeEdit | null; finish(name: string | null): void; ask(action: 'rename' | 'delete', entry: Entry): void; create(kind: 'file' | 'folder', entry: Entry): void; nonce: number; depth?: number }): React.JSX.Element {
  const t = useT(), [expanded, setExpanded] = useState(depth === 0), [entries, setEntries] = useState<Entry[]>(), [error, setError] = useState('')
  const row = useRef<HTMLButtonElement>(null), isRoot = entry.worktree !== undefined
  const creatingHere = editing?.type === 'create' && pathKey(editing.parent) === pathKey(entry.path), renaming = editing?.type === 'rename' && pathKey(editing.path) === pathKey(entry.path)
  useEffect(() => {
    if (!reveal) return
    const normalize = (value: string): string => value.replace(/\\/g, '/').toLowerCase()
    if (entry.directory && normalize(reveal.path).startsWith(`${normalize(entry.path)}/`)) setExpanded(true)
    if (normalize(reveal.path) === normalize(entry.path)) { if (entry.directory) setExpanded(true); row.current?.scrollIntoView({ block: 'nearest' }) }
  }, [reveal?.at, entry.path])
  useEffect(() => { if (creatingHere) setExpanded(true) }, [creatingHere])
  useEffect(() => {
    if (!expanded || !entry.directory) return
    let alive = true
    void window.gearmod.invoke('workspace:list', { ...context, path: entry.path }).then((items) => { if (alive) { setEntries(items); setError('') } }).catch((reason) => { if (alive) setError(plainError(reason)) })
    return () => { alive = false }
  }, [expanded, entry.path, context.projectId, context.cardId, entry.directory, nonce])
  return <div role="treeitem" aria-expanded={entry.directory ? expanded : undefined} aria-selected={selected === entry.path}>
    <div className="wf-tree-row">{renaming ? <TreeInput initial={entry.name} directory={entry.directory} depth={depth} finish={finish} /> : <button ref={row} type="button" className={`wf-treeitem ${selected === entry.path ? 'on' : ''}`} style={{ paddingLeft: 10 + depth * 13 }} data-tip={entry.path} onContextMenu={(event) => menu(entry, event)} onClick={() => entry.directory ? setExpanded(!expanded) : open(entry.path)} onDoubleClick={() => { if (!entry.directory) open(entry.path, true) }} onKeyDown={(event) => { if (isRoot) return; if (event.key === 'F2') { event.preventDefault(); ask('rename', entry) } else if (event.key === 'Delete') { event.preventDefault(); ask('delete', entry) } }}>
      <span className={`wf-chevron ${expanded ? 'open' : ''}`} aria-hidden="true">{entry.directory && <ChevronRightSmallIcon />}</span><FileTypeIcon path={entry.path} directory={entry.directory} /><span className="wf-tree-label"><span>{entry.name}</span>{entry.worktree !== undefined && <GitContextChip root={entry} />}</span>
    </button>}{entry.primary && !renaming && <div className="wf-root-actions"><button type="button" className="ibtn tip" data-tip={t.files.tree.newFile} aria-label={t.files.tree.newFileInRoot} onClick={() => create('file', entry)}><NewFileIcon /></button><button type="button" className="ibtn tip" data-tip={t.files.tree.newFolder} aria-label={t.files.tree.newFolderInRoot} onClick={() => create('folder', entry)}><NewFolderIcon /></button></div>}</div>
    {entry.directory && expanded && <div role="group">{creatingHere && editing?.type === 'create' && <TreeInput initial="" directory={editing.kind === 'folder'} depth={depth + 1} finish={finish} />}{error ? <p className="wf-note error">{error}</p> : !entries ? <p className="wf-note">{t.common.loading}</p> : !entries.length ? (creatingHere ? null : <p className="wf-note">{t.files.tree.emptyFolder}</p>) : entries.map((item) => { const root = contexts.find((candidate) => pathKey(candidate.path) === pathKey(item.path)); return <TreeFolder key={item.path} entry={root ? { ...item, ...root } : item} context={context} contexts={contexts} selected={selected} open={open} reveal={reveal} menu={menu} editing={editing} finish={finish} ask={ask} create={create} nonce={nonce} depth={depth + 1} /> })}</div>}
  </div>
}

/** Project/worktree explorer with editor, preview and a dedicated window per file. */
export function WorkspaceFiles({ projectId, cardId, initialPath, initialReveal, initialPaths = [], close, standalone = false, isolated = false, changes, startExpanded = false }: { projectId: string; cardId: string | null; initialPath?: string; initialReveal?: { path: string; at: number }; initialPaths?: string[]; close(): void; standalone?: boolean; isolated?: boolean; changes?: FileChange[]; startExpanded?: boolean }): React.JSX.Element {
  const t = useT(), context = { projectId, cardId }
  const [roots, setRoots] = useState<IpcOutput<'workspace:roots'>>([]), [query, setQuery] = useState(''), [results, setResults] = useState<IpcOutput<'workspace:search'>>(), [searching, setSearching] = useState(false)
  const [preferences, change] = usePreferences()
  const [menu, setMenu] = useState<'settings' | null>(null), [shortcutsOpen, setShortcutsOpen] = useState(false), [expanded, setExpanded] = useState(startExpanded), [position, setPositionState] = useState<Position>(readPosition), [treeVisible, setTreeVisible] = useState(!isolated)
  const selectionText = useRef<(() => string) | null>(null)
  const [editing, setEditing] = useState<TreeEdit | null>(null), [treeNonce, setTreeNonce] = useState(0), [deleting, setDeleting] = useState<Entry | null>(null)
  const [quick, setQuick] = useState<{ mode: QuickMode; text: string } | null>(null), mru = useRef<string[]>([]), [command, setCommand] = useState<PaneCommand>(), [jump, setJump] = useState<{ path: string; line: number; column: number; length?: number }>()
  const [tabMenu, setTabMenu] = useState<{ entry: Entry; x: number; y: number }>(), [reveal, setReveal] = useState<{ path: string; at: number }>()
  const [draggingTab, setDraggingTab] = useState<string>(), [tabDrop, setTabDrop] = useState<number>(), internalTabDrop = useRef(false), draggedTabWidth = useRef(110), tabGeometry = useRef<Array<{ center: number }>>([])
  const changeFor = (path: string): FileChange | undefined => findChange(changes, path)
  const changeTotals = useMemo(() => ({ added: changes?.reduce((sum, item) => sum + item.added, 0) ?? 0, removed: changes?.reduce((sum, item) => sum + item.removed, 0) ?? 0 }), [changes])
  const { documents, setDocuments, latest, active, setActive, current, loading, error, setError, update: updateDocument, save, open, reload, dialog: reloadDialog } = useFileDocuments({ projectId, cardId, autosave: preferences.autosave, diffFirst: (path) => Boolean(changeFor(path)?.diff) })
  const menuBox = useRef<HTMLDivElement>(null)
  const currentRoot = current ? [...roots].sort((a, b) => b.path.length - a.path.length).find((root) => { const path = slashed(current.path), base = slashed(root.path).replace(/\/$/, ''); return path === base || path.startsWith(`${base}/`) }) : undefined
  const commentCardId = currentRoot?.cardId ?? cardId, commentTarget = currentRoot?.cardTitle || (commentCardId ? t.files.workspace.openCard : t.files.workspace.newChat)
  const [treeWidth, setTreeWidth] = useState(() => { try { return Number(localStorage.getItem('gearmod.fileTreeWidth')) || 240 } catch { return 240 } }), [resizingTree, setResizingTree] = useState(false)
  // Tab usage order (Ctrl+Tab goes back to the previous one) and the project's recent files (Ctrl+P).
  useEffect(() => { if (!active) return; mru.current = [active, ...mru.current.filter((path) => path !== active)]; pushRecent(projectId, active) }, [active])
  useEffect(() => { mru.current = mru.current.filter((path) => documents.some((file) => file.path === path)) }, [documents])
  const openQuick = (path: string, line?: number, column?: number, length?: number): void => { void open(path).then((resolved) => { if (resolved && line) setJump({ path: resolved, line, column: column ?? 1, ...(length ? { length } : {}) }) }) }
  const startCreate = (kind: 'file' | 'folder', from?: Entry): void => {
    const parent = from ? (from.directory ? from.path : parentOf(from.path)) : roots.find((root) => root.primary)?.path ?? roots[0]?.path
    if (!parent) return
    setTreeVisible(true); change({ tree: true }); setQuery(''); setResults(undefined); setEditing({ type: 'create', kind, parent })
  }
  /** Renaming changes the path of open tabs (and of files inside a renamed folder) without losing pending edits. */
  const remapTabs = (from: string, to: string, name: string): void => {
    const base = slashed(from)
    const inside = (path: string): boolean => slashed(path) === base || slashed(path).startsWith(`${base}/`)
    setDocuments((all) => all.map((file) => { if (!inside(file.path)) return file; const tail = file.path.slice(from.length), relativeTail = tail.replace(/\\/g, '/'), oldRelative = file.relative.slice(0, file.relative.length - relativeTail.length); return { ...file, path: to + tail, relative: oldRelative.replace(/[^/]*$/, name) + relativeTail } }))
    if (inside(active)) setActive(to + active.slice(from.length))
  }
  const finishEdit = async (name: string | null): Promise<void> => {
    const edit = editing; setEditing(null)
    if (!edit || !name) return
    try {
      if (edit.type === 'create') { const created = await window.gearmod.invoke('workspace:create', { ...context, parent: edit.parent, name, kind: edit.kind }); setTreeNonce((value) => value + 1); setReveal({ path: created.path, at: Date.now() }); if (edit.kind === 'file') await open(created.path) }
      else if (name !== nameOf(edit.path)) { const renamed = await window.gearmod.invoke('workspace:rename', { ...context, path: edit.path, name }); remapTabs(edit.path, renamed.path, name); setTreeNonce((value) => value + 1) }
    } catch (reason) { setError(plainError(reason)) }
  }
  const askTree = (action: 'rename' | 'delete', entry: Entry): void => { if (action === 'rename') setEditing({ type: 'rename', path: entry.path }); else setDeleting(entry) }
  const trash = async (entry: Entry): Promise<void> => {
    setDeleting(null)
    try {
      await window.gearmod.invoke('workspace:trash', { ...context, path: entry.path })
      const gone = (path: string): boolean => slashed(path) === slashed(entry.path) || slashed(path).startsWith(`${slashed(entry.path)}/`)
      const rest = latest.current.filter((file) => !gone(file.path)); latest.current = rest; setDocuments(rest); if (gone(active)) setActive(rest.at(-1)?.path ?? '')
      setTreeNonce((value) => value + 1)
    } catch (reason) { setError(plainError(reason)) }
  }
  /** File deleted externally while its text is open: recreates it empty and writes the tab's text (the expected version becomes the new file's). */
  const restore = async (path: string): Promise<void> => {
    const file = latest.current.find((item) => item.path === path); if (!file) return
    try {
      await window.gearmod.invoke('workspace:create', { ...context, parent: parentOf(path), name: nameOf(path), kind: 'file' })
      const text = withEol(file.content, file.eol)
      await window.gearmod.invoke('workspace:write', { ...context, path, content: text, expected: '' })
      updateDocument(path, { deleted: false, saved: file.content, disk: text, error: '' }); setTreeNonce((value) => value + 1)
    } catch (reason) { updateDocument(path, { error: plainError(reason) }) }
  }
  const cycleTabs = (backwards: boolean): void => { const order = mru.current.filter((path) => documents.some((file) => file.path === path)); const next = backwards ? order.at(-1) : order[1]; if (next && next !== active) startTransition(() => setActive(next)) }
  const [collapsedRepos, setCollapsedRepos] = useState<string[]>([])
  // Panel docked to the left or right: reports the width it takes (--files-dock-left/right) and the main content makes room, side by side.
  const panel = useRef<HTMLElement>(null)
  useEffect(() => { const navigate = (): void => { if (expanded && !standalone && panel.current?.getClientRects().length) close() }; window.addEventListener('gearmod:select-view', navigate); return () => window.removeEventListener('gearmod:select-view', navigate) }, [expanded, standalone, close])
  const [dockWidth, setDockWidth] = useState<number | null>(() => { try { return Number(localStorage.getItem('gearmod.fileDockWidth')) || null } catch { return null } }), [dockHeight, setDockHeight] = useState<number | null>(() => { try { return Number(localStorage.getItem('gearmod.fileDockHeight')) || null } catch { return null } }), [resizingDock, setResizingDock] = useState(false)
  // The inner edge adjusts width or height depending on the side the panel is on.
  const resizeDock = (event: React.PointerEvent<HTMLDivElement>): void => {
    const element = panel.current; if (!element) return
    event.preventDefault()
    const vertical = position === 'top' || position === 'bottom', rect = element.getBoundingClientRect()
    const start = vertical ? event.clientY : event.clientX, initial = vertical ? rect.height : rect.width, sign = position === 'right' || position === 'bottom' ? -1 : 1
    const host = element.parentElement?.getBoundingClientRect(), limit = vertical ? (host?.height ?? window.innerHeight) : (host?.width ?? window.innerWidth)
    let latestSize = initial
    setResizingDock(true)
    const move = (next: PointerEvent): void => { const point = vertical ? next.clientY : next.clientX; latestSize = Math.round(Math.max(vertical ? 180 : 320, Math.min(limit * .75, initial + sign * (point - start)))); if (vertical) setDockHeight(latestSize); else setDockWidth(latestSize) }
    const up = (): void => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); setResizingDock(false); try { localStorage.setItem(vertical ? 'gearmod.fileDockHeight' : 'gearmod.fileDockWidth', String(latestSize)) } catch { /* only valid for this session */ } }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
  }
  const docked = !expanded && !standalone
  const sideDocked = docked && (position === 'left' || position === 'right')
  useEffect(() => {
    const element = panel.current
    if (!element || standalone) return
    const clear = (): void => { for (const edge of ['left', 'right', 'top', 'bottom']) document.documentElement.style.setProperty(`--files-dock-${edge}`, '0px') }
    const publish = (): void => {
      const rect = element.getBoundingClientRect(), size = element.getClientRects().length && !expanded ? Math.round(position === 'left' || position === 'right' ? rect.width : rect.height) : 0
      if (size > 0) { dockOwner = element; clear(); document.documentElement.style.setProperty(`--files-dock-${position}`, `${size}px`) }
      else if (dockOwner === element) { dockOwner = null; clear() }
    }
    publish(); const observer = new ResizeObserver(publish); observer.observe(element)
    return () => { observer.disconnect(); if (dockOwner === element) { dockOwner = null; clear() } }
  }, [position, expanded, standalone])
  const setPosition = (value: Position): void => { setPositionState(value); try { localStorage.setItem(positionKey, value) } catch { /* only valid for this session */ } }
  useEffect(() => { void window.gearmod.invoke('workspace:roots', context).then(setRoots).catch((reason) => setError(plainError(reason))) }, [projectId, cardId])
  useEffect(() => { if (initialReveal) { setTreeVisible(true); change({ tree: true }); setReveal(initialReveal) } }, [initialReveal?.at])
  const openedInitial = useRef('')
  useEffect(() => {
    const ordered = [...new Set([...initialPaths.filter((path) => path !== initialPath), ...(initialPath ? [initialPath] : [])])]
    const key = ordered.join('\n'); if (!key || openedInitial.current === key) return; openedInitial.current = key
    void (async () => { for (const path of ordered) { const target = splitLineSuffix(path), resolved = await open(target.path); if (resolved && target.line && path === initialPath) setJump({ path: resolved, line: target.line, column: target.column ?? 1 }) } })()
  }, [initialPath, initialPaths.join('\n'), open])
  const absolute = (relative: string, root?: string): string | undefined => { const base = root ?? roots[0]?.path; return base ? `${base.replace(/[\\/]+$/, '')}/${relative}` : undefined }
  const openClick = (path: string, pinned = false): Promise<string | undefined> => open(path, { transient: preferences.previewTabs && !pinned })
  const openChange = (item: FileChange, pinned = false): void => { const path = absolute(item.path, item.root); if (path) void openClick(path, pinned) }
  const firstChange = changes?.find((item) => !item.untracked) ?? changes?.[0]
  const autoOpened = useRef(false)
  useEffect(() => { if (autoOpened.current || !firstChange || !roots.length || initialPath) return; autoOpened.current = true; openChange(firstChange) }, [roots, firstChange])
  const openAllChanges = (): void => { (changes ?? []).slice(0, 20).forEach((item) => { const path = absolute(item.path, item.root); if (path) void open(path) }) }
  useEffect(() => {
    if (changes || !query.trim()) { setResults(undefined); setSearching(false); return }
    let alive = true; setSearching(true)
    const timer = window.setTimeout(() => { void window.gearmod.invoke('workspace:search', { ...context, query: query.trim() }).then((result) => { if (alive) setResults(result) }).catch((reason) => { if (alive) setError(plainError(reason)) }).finally(() => { if (alive) setSearching(false) }) }, 250)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [query, projectId, cardId])
  useEffect(() => {
    if (!menu) return
    const away = (event: PointerEvent): void => { if (!menuBox.current?.contains(event.target as Node)) setMenu(null) }
    document.addEventListener('pointerdown', away); return () => document.removeEventListener('pointerdown', away)
  }, [menu])
  const { ask: confirmAsk, dialog: confirmDialog } = useAsk()
  useEscape(() => setShortcutsOpen(false), shortcutsOpen)
  const closeTab = async (file: Document): Promise<void> => {
    if (file.content !== file.saved && !(await confirmAsk({ eyebrow: t.files.workspace.closeFile, title: t.files.workspace.discardTitle, text: t.files.workspace.discardOne(nameOf(file.path)), ok: t.files.workspace.discard, danger: true }))) return
    const rest = documents.filter((item) => item.path !== file.path); setDocuments(rest); if (active === file.path) setActive(rest.at(-1)?.path ?? '')
  }
  // Closes several at once (others, to the left, to the right, all); if any has unsaved changes, asks only once.
  const closeMany = async (files: Document[], keep?: Document): Promise<void> => {
    if (!files.length) return
    const dirty = files.filter((item) => item.content !== item.saved)
    if (dirty.length && !(await confirmAsk({ eyebrow: t.files.workspace.closeFiles, title: t.files.workspace.discardTitle, text: dirty.length === 1 ? t.files.workspace.discardOne(nameOf(dirty[0]!.path)) : t.files.workspace.discardMany(dirty.length), ok: t.files.workspace.discard, danger: true }))) return
    const gone = new Set(files.map((item) => item.path)), rest = documents.filter((item) => !gone.has(item.path))
    setDocuments(rest); if (gone.has(active)) setActive(keep?.path ?? rest.at(-1)?.path ?? '')
  }
  const leave = async (): Promise<void> => {
    if (standalone && documents.some((item) => item.content !== item.saved)) {
      if (!(await confirmAsk({ eyebrow: t.files.workspace.closeFiles, title: t.files.workspace.discardTitle, text: t.files.workspace.discardAllText, ok: t.files.workspace.discard, danger: true }))) return
      latest.current = []; setDocuments([])
    }
    close()
  }
  /** Asks the open file's panel to open find/replace/go to line (the state lives in `FilePane`). */
  const ask = (type: PaneCommand['type'], path = active): void => { setActive(path); setTabMenu(undefined); setCommand({ type, at: Date.now() }) }
  const perform = (action: () => Promise<unknown>): void => { void action().catch((reason) => setError(plainError(reason))) }
  const relative = (path: string): string => {
    const document = latest.current.find((item) => item.path === path); if (document) return document.relative
    const normalized = path.replace(/\\/g, '/'), root = roots.find((item) => normalized.toLowerCase().startsWith(`${item.path.replace(/\\/g, '/').toLowerCase()}/`))
    return root ? normalized.slice(root.path.length + 1) : nameOf(path)
  }
  const showContext = (entry: Entry, event: React.MouseEvent): void => { event.preventDefault(); event.stopPropagation(); setTabMenu({ entry, x: event.clientX, y: event.clientY }) }
  const fileMenu = (entry: Entry): FileMenuItem[] => {
    const document = latest.current.find((item) => item.path === entry.path), path = entry.path
    const external = (target: 'vscode' | 'default' | 'explorer'): void => perform(async () => { if (document && document.content !== document.saved && !await save(path)) return; await window.gearmod.invoke('workspace:external', { ...context, path, target }) })
    const isRoot = entry.worktree !== undefined
    return [
      { label: t.files.workspace.menu.newFile, action: () => startCreate('file', entry) },
      { label: t.files.workspace.menu.newFolder, action: () => startCreate('folder', entry) },
      ...(!isRoot ? [{ label: t.files.workspace.menu.rename, shortcut: 'F2', action: () => setEditing({ type: 'rename', path }) }, { label: t.files.workspace.menu.delete, shortcut: 'Del', action: () => setDeleting(entry) }] : []),
      ...(!entry.directory ? [{ label: t.files.workspace.menu.attach, separator: true, action: () => perform(async () => { if (document && document.content !== document.saved && !await save(path)) return; await window.gearmod.invoke('workspace:attach', { ...context, path }); if (!standalone) close() }) }] : []),
      { label: t.files.workspace.menu.copy, separator: entry.directory, children: [{ label: t.files.workspace.menu.copyAbsolute, action: () => perform(() => navigator.clipboard.writeText(path)) }, { label: t.files.workspace.menu.copyRelative, action: () => perform(() => navigator.clipboard.writeText(relative(path))) }, { label: t.files.workspace.menu.copyName, action: () => perform(() => navigator.clipboard.writeText(entry.name)) }] },
      { label: t.files.workspace.menu.openIn, separator: true, children: [{ label: 'VS Code', action: () => external('vscode') }, { label: t.files.workspace.menu.defaultApp, action: () => external('default') }] },
      { label: t.files.workspace.menu.showInExplorer, action: () => external('explorer') },
      { label: t.files.workspace.menu.openInTerminal, action: () => { terminal.setContext(context); void terminal.openPath({ ...context, path }) } },
      ...(!entry.directory ? [
        { label: t.files.workspace.menu.showInTree, separator: true, action: () => { setQuery(''); setResults(undefined); setTreeVisible(true); change({ tree: true, treeSide: 'left' }); setReveal({ path, at: Date.now() }) } },
        { label: t.files.workspace.menu.findInFile, separator: true, shortcut: 'Ctrl+F', disabled: document?.binary, action: () => { void open(path).then(() => ask('find', path)) } },
        { label: t.files.workspace.menu.copyContent, disabled: document?.binary, action: () => perform(async () => { const file = document ?? await window.gearmod.invoke('workspace:read', { ...context, path }); if (file.binary || file.truncated) throw new Error(t.files.workspace.menu.contentUnavailable); await navigator.clipboard.writeText(file.content) }) },
        { label: t.files.workspace.menu.reload, action: () => void reload(path) },
        ...(document && document.content !== document.saved ? [{ label: t.files.workspace.menu.compareSaved, action: () => { setActive(path); updateDocument(path, { compare: { before: document.saved, title: t.files.workspace.menu.unsavedChanges, split: false } }) } } as FileMenuItem] : []),
        ...(document ? (() => {
        const at = documents.findIndex((item) => item.path === document.path), left = documents.slice(0, at), right = documents.slice(at + 1)
        return [
          { label: t.files.workspace.closeFile, separator: true, action: () => { void closeTab(document) } } as FileMenuItem,
          ...(documents.length > 1 ? [{ label: t.files.workspace.menu.closeOthers, action: () => { void closeMany([...left, ...right], document) } } as FileMenuItem] : []),
          ...(left.length ? [{ label: t.files.workspace.menu.closeLeft, action: () => { void closeMany(left, document) } } as FileMenuItem] : []),
          ...(right.length ? [{ label: t.files.workspace.menu.closeRight, action: () => { void closeMany(right, document) } } as FileMenuItem] : []),
          ...(documents.length > 1 ? [{ label: t.files.workspace.menu.closeAll, action: () => { void closeMany(documents) } } as FileMenuItem] : [])
        ]
      })() : [])
      ] : [])
    ]
  }
  const outsideWindow = (event: React.DragEvent): { x: number; y: number } | null => {
    const x = Math.round(event.screenX), y = Math.round(event.screenY)
    if (x === 0 && y === 0) return null
    return x < window.screenX || y < window.screenY || x > window.screenX + window.outerWidth || y > window.screenY + window.outerHeight ? { x, y } : null
  }
  const detachPanel = async (point?: { x: number; y: number }): Promise<void> => {
    for (const file of latest.current) if (file.content !== file.saved && !await save(file.path)) return
    const paths = latest.current.map((file) => file.path).filter((path) => path !== active); if (active) paths.push(active)
    try { await window.gearmod.invoke('windows:open', { kind: 'files', projectId, cardId: cardId ?? undefined, path: active || undefined, paths, placement: 'new', ...point }); setMenu(null); close() } catch (reason) { setError(plainError(reason)) }
  }
  const detachFile = async (file: Document, point: { x: number; y: number }): Promise<void> => {
    if (!await save(file.path)) return
    try {
      await window.gearmod.invoke('windows:open', { kind: 'file', projectId, cardId: cardId ?? undefined, path: file.path, placement: 'new', ...point })
      const rest = latest.current.filter((item) => item.path !== file.path); latest.current = rest; setDocuments(rest); if (active === file.path) setActive(rest.at(-1)?.path ?? '')
    } catch (reason) { setError(plainError(reason)) }
  }
  const dropTab = (path: string, requestedIndex: number): void => {
    internalTabDrop.current = true; setTabDrop(undefined)
    setDocuments((all) => {
      const file = all.find((item) => item.path === path); if (!file) return all
      const rest = all.filter((item) => item.path !== path), index = Math.max(0, Math.min(requestedIndex, rest.length))
      const next = [...rest.slice(0, index), file, ...rest.slice(index)]; latest.current = next; return next
    })
  }
  const previewIndex = (clientX: number): number => {
    const index = tabGeometry.current.findIndex((item) => clientX < item.center)
    return index < 0 ? tabGeometry.current.length : index
  }
  const returnToMain = async (): Promise<void> => {
    if (!current || !await save(current.path)) return
    try { await window.gearmod.invoke('windows:return-file', { ...context, path: current.path }); window.close() } catch (reason) { setError(plainError(reason)) }
  }
  const resizeTree = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const body = event.currentTarget.parentElement, start = event.clientX, treeElement = event.currentTarget.parentElement?.querySelector<HTMLElement>('.wf-tree'), initial = treeElement?.getBoundingClientRect().width ?? treeWidth
    if (!body) return
    setResizingTree(true)
    const move = (next: PointerEvent): void => {
      const delta = preferences.treeSide === 'left' ? next.clientX - start : start - next.clientX
      setTreeWidth(Math.round(Math.max(160, Math.min(body.getBoundingClientRect().width * .45, initial + delta))))
    }
    const up = (): void => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); setResizingTree(false)
      const width = treeElement?.getBoundingClientRect().width; if (width) try { localStorage.setItem('gearmod.fileTreeWidth', String(Math.round(width))) } catch { /* only valid for this session */ }
    }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
  }
  const fill = (): void => { if (standalone) void window.gearmod.invoke('windows:place', { placement: expanded ? 'new' : 'fill' }); setExpanded(!expanded); setMenu(null) }
  // Quick search: files start with no initial text; content and symbols start with whatever is selected in the editor.
  const openQuickMode = (mode: QuickMode): void => { const picked = mode === 'files' ? '' : selectionText.current?.().split('\n')[0]?.trim() ?? ''; setQuick({ mode, text: picked }) }
  const openQuickRef = useRef(openQuickMode); openQuickRef.current = openQuickMode
  useEffect(() => {
    const handle = (event: Event): void => {
      const box = panel.current, host = box?.closest<HTMLElement>('.wf-host')
      if (!box || (host && host.style.display === 'none')) return
      const mode = (event as CustomEvent<{ mode: QuickMode }>).detail?.mode
      if (mode) openQuickRef.current(mode)
    }
    window.addEventListener(filesQuickEvent, handle); return () => window.removeEventListener(filesQuickEvent, handle)
  }, [])
  const keyDown = (event: React.KeyboardEvent): void => {
    const native = event.nativeEvent
    if (isShortcut(native, 'save')) { event.preventDefault(); if (current) void save(current.path) }
    if (current && !current.binary) {
      const type = isShortcut(native, 'find') ? 'find' : isShortcut(native, 'replace') ? 'replace' : isShortcut(native, 'goToLine') ? 'goto' : null
      if (type) { event.preventDefault(); event.stopPropagation(); ask(type) }
    }
    const quickFor = { quickOpenFile: 'files', searchInFiles: 'content', searchSymbols: 'symbols' } as const, id = shortcutFor(event.nativeEvent)
    if (id && id in quickFor && !(id === 'searchInFiles' && changes)) { event.preventDefault(); event.stopPropagation(); openQuickMode(quickFor[id as keyof typeof quickFor]) }
    if (event.ctrlKey && event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); cycleTabs(event.shiftKey) }
    if (event.key === 'Escape') setMenu(null)
  }
  const tree = treeVisible && preferences.tree
  return <section ref={panel} className={`workspacefiles ${standalone ? 'standalone' : ''} ${expanded ? 'expanded' : position} ${resizingTree ? 'tree-resizing' : ''} ${resizingDock ? 'dock-resizing' : ''}`} style={sideDocked && dockWidth ? { width: dockWidth } : docked && !sideDocked && dockHeight ? { height: dockHeight } : undefined} aria-label={t.files.workspace.panelLabel} onKeyDown={keyDown}>{reloadDialog}{confirmDialog}
    {docked && <div className={`wf-dockgrip ${position}`} role="separator" aria-orientation={sideDocked ? "vertical" : "horizontal"} aria-label={sideDocked ? t.files.workspace.resizeWidth : t.files.workspace.resizeHeight} onPointerDown={resizeDock} onDoubleClick={() => { if (sideDocked) setDockWidth(null); else setDockHeight(null); try { localStorage.removeItem(sideDocked ? 'gearmod.fileDockWidth' : 'gearmod.fileDockHeight') } catch { /* only valid for this session */ } }} />}
    <header className="wf-header" draggable={!standalone} onDragStart={(event) => { if ((event.target as HTMLElement).closest('.wf-actions')) { event.preventDefault(); return }; event.preventDefault(); void detachPanel({ x: Math.round(event.screenX), y: Math.round(event.screenY) }) }}><FolderGlyph /><b>{isolated ? nameOf(active || initialPath || t.files.workspace.header.file) : changes ? t.files.workspace.header.changes : t.files.workspace.header.files}</b>{changes ? <span className="wf-context wf-totals" data-tip={roots.map((root) => root.path).join('\n')}><span className="ch-add">+{changeTotals.added}</span> <span className="ch-del">−{changeTotals.removed}</span> · {t.files.workspace.header.fileCount(changes.length)}</span> : <span className="wf-context" data-tip={roots.map((root) => root.path).join('\n')}>{cardId ? t.files.workspace.header.cardWorktree : t.common.project}</span>}{!changes && !isolated && <button type="button" className="wf-unified-search" data-tip={t.files.workspace.header.searchTip} onClick={() => setQuick({ mode: 'files', text: '' })}><SearchIcon /><span>{t.files.workspace.header.search}</span><kbd>Ctrl+P</kbd></button>}<div className="wf-actions">
      {isolated && <button type="button" className="ibtn" data-tip={t.files.workspace.header.backToMain} aria-label={t.files.workspace.header.backToMain} onClick={() => void returnToMain()}><DockIcon /></button>}
      {changes && <button type="button" className="ibtn tip" data-tip={t.files.workspace.header.openAllChanges} aria-label={t.files.workspace.header.openAllChanges} disabled={!changes.length} onClick={openAllChanges}><DiffIcon /></button>}
      <div className="wf-menus" ref={menuBox}>
        <button type="button" className="ibtn" aria-label={t.files.workspace.header.fileSettings} aria-expanded={menu === 'settings'} onClick={() => setMenu(menu === 'settings' ? null : 'settings')}>···</button>
        {menu === 'settings' && <div className="popmenu wf-settings" role="dialog" aria-label={t.files.workspace.header.editorSettings}>
          {(['previewTabs', 'autosave', 'indent', 'wrap', 'guides', 'whitespace', 'beyond'] as const).map((key) => <label key={key}><Checkbox checked={preferences[key]} onChange={(value) => { change({ [key]: value }); }} />{t.files.workspace.settingLabels[key]}</label>)}
          <label>{t.files.workspace.header.treePosition}<Select label={t.files.workspace.header.treePosition} value={preferences.treeSide} options={[{ value: 'left', label: t.files.workspace.header.left }, { value: 'right', label: t.files.workspace.header.right }]} onChange={(value) => change({ treeSide: value as Preferences['treeSide'] })} /></label>
          <label>{t.files.workspace.header.tabSize}<Select label={t.files.workspace.header.tabSize} value={String(preferences.tabSize)} options={[2, 4, 8].map((value) => ({ value: String(value), label: String(value) }))} onChange={(value) => change({ tabSize: Number(value) })} /></label>
          <button type="button" className="secondary wf-shortcuts-btn" onClick={() => { setMenu(null); setShortcutsOpen(true) }}>{t.files.workspace.header.shortcuts}</button>
        </div>}
      </div><WindowLayoutMenu move={(value) => { if (standalone) void window.gearmod.invoke('windows:place', { placement: value }); else { setPosition(value); setExpanded(false) } }} detach={!standalone ? () => void detachPanel() : undefined} />{!standalone && <><button type="button" className="ibtn" aria-label={expanded ? t.files.workspace.header.restore : t.files.workspace.header.expand} data-tip={expanded ? t.files.workspace.header.restore : t.files.workspace.header.expand} onClick={fill}>{expanded ? <CollapseIcon /> : <ExpandIcon />}</button><button type="button" className="ibtn" aria-label={t.files.workspace.closeFiles} onClick={leave}><CloseIcon /></button></>}
    </div></header>
    {shortcutsOpen && <div className="overlay top" role="dialog" aria-modal="true" aria-labelledby="wf-shortcuts-title" onMouseDown={(event) => { if (event.target === event.currentTarget) setShortcutsOpen(false) }}><div className="modal wf-shortcuts-dialog"><header><div><div className="eyebrow">{t.files.workspace.shortcutsDialog.eyebrow}</div><h2 id="wf-shortcuts-title">{t.files.workspace.shortcutsDialog.title}</h2><p>{t.files.workspace.shortcutsDialog.description}</p></div><button type="button" className="x" autoFocus aria-label={t.files.workspace.shortcutsDialog.close} onClick={() => setShortcutsOpen(false)}>×</button></header><div className="wf-shortcuts">{shortcutList().map((item) => <div className="wf-shortcut" key={item.keys + item.label}><span>{item.label}</span><kbd>{item.keys}</kbd></div>)}</div></div></div>}
    {deleting && <ConfirmDialog eyebrow={t.files.workspace.trash.eyebrow} title={t.files.workspace.trash.title(deleting.name)} text={t.files.workspace.trash.text(deleting.directory, documents.some((file) => (slashed(file.path) === slashed(deleting.path) || slashed(file.path).startsWith(`${slashed(deleting.path)}/`)) && file.content !== file.saved))} ok={t.files.workspace.trash.ok} danger cancel={() => setDeleting(null)} confirm={() => void trash(deleting)} />}
    {quick && <QuickOpen key={quick.mode} context={context} roots={roots} recents={readRecents(projectId)} open={openQuick} initialMode={quick.mode} initialText={quick.text} close={() => setQuick(null)} />}
    {tabMenu && <FileContextMenu x={tabMenu.x} y={tabMenu.y} items={fileMenu(tabMenu.entry)} close={() => setTabMenu(undefined)} find={() => ask('find', tabMenu.entry.path)} />}
    <div className="wf-tabbar">
      <button type="button" className={`ibtn wf-treebtn ${tree ? 'on' : ''}`} data-tip={tree ? t.files.workspace.tabs.hideTree : t.files.workspace.tabs.showTree} aria-label={t.files.workspace.tabs.tree} aria-pressed={tree} onClick={() => { setTreeVisible(true); change({ tree: !tree }) }}><ListIcon /></button>
      {preferences.tabs && documents.length > 0 && <div className="wf-tabs" role="tablist" aria-label={t.files.workspace.tabs.open}
        onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-gearmod-file')) { event.preventDefault(); const index = previewIndex(event.clientX); setTabDrop((current) => current === index ? current : index) } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTabDrop(undefined) }}
        onDrop={(event) => { event.preventDefault(); const path = event.dataTransfer.getData('application/x-gearmod-file'); if (path) dropTab(path, tabDrop ?? previewIndex(event.clientX)) }}>
        {(() => { let visibleIndex = 0; const dragged = documents.find((file) => file.path === draggingTab); const placeholder = dragged ? <span className="wf-tab-placeholder" style={{ width: draggedTabWidth.current }} aria-hidden="true"><span><FileTypeIcon path={dragged.path} />{nameOf(dragged.path)}{dragged.saved !== dragged.content ? ' •' : ''}</span><i>×</i></span> : null; return <>
        {documents.map((file) => {
          const index = file.path === draggingTab ? -1 : visibleIndex++
          return <React.Fragment key={file.path}>
            {index >= 0 && tabDrop === index && placeholder}
            <div draggable={!isolated} data-file-tab={file.path} className={`wf-tab ${file.path === active ? 'on' : ''} ${draggingTab === file.path ? 'dragging' : ''} ${file.transient ? 'transient' : ''}`} onDoubleClick={() => { if (file.transient) updateDocument(file.path, { transient: false }) }}
              onDragStart={(event) => { internalTabDrop.current = false; const source = event.currentTarget, sourceRect = source.getBoundingClientRect(), tabs = [...source.parentElement!.querySelectorAll<HTMLElement>('[data-file-tab]')], sourceIndex = tabs.indexOf(source); draggedTabWidth.current = Math.round(sourceRect.width); tabGeometry.current = tabs.filter((tab) => tab !== source).map((tab, index) => { const rect = tab.getBoundingClientRect(), wasAfterSource = index >= sourceIndex; return { center: rect.left + rect.width / 2 - (wasAfterSource ? sourceRect.width + 9 : 0) } }); const dragged = file.path, startIndex = Math.max(0, sourceIndex); window.setTimeout(() => { setDraggingTab(dragged); setTabDrop(startIndex) }, 0); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-gearmod-file', file.path) }}
              onDragEnd={(event) => { tabGeometry.current = []; setDraggingTab(undefined); setTabDrop(undefined); const point = internalTabDrop.current ? null : outsideWindow(event); internalTabDrop.current = false; const draggedFile = latest.current.find((item) => item.path === file.path); if (point && draggedFile) void detachFile(draggedFile, point) }}
              onContextMenu={(event) => showContext({ path: file.path, name: nameOf(file.path), directory: false }, event)}>
              <button type="button" role="tab" aria-selected={file.path === active} data-tip={file.path} onClick={() => startTransition(() => setActive(file.path))}><FileTypeIcon path={file.path} />{nameOf(file.path)}{file.saved !== file.content ? ' •' : ''}</button><button type="button" aria-label={t.files.workspace.tabs.close(nameOf(file.path))} onClick={() => closeTab(file)}>×</button>
            </div>
          </React.Fragment>
        })}
        {draggingTab && tabDrop === visibleIndex && placeholder}</> })()}
      </div>}
    </div>
    <div className={`wf-body ${tree ? `tree-${preferences.treeSide}` : ''}`} style={{ '--wf-tree-width': `${treeWidth}px` } as React.CSSProperties}>
      {tree && <nav className="wf-tree" aria-label={t.files.workspace.tabs.tree}>{changes && <div className="wf-treesearch"><input className="in" aria-label={t.files.workspace.changed.searchLabel} placeholder={t.files.workspace.changed.searchPlaceholder} value={query} onChange={(event) => setQuery(event.target.value)} /></div>}{searching && <p className="wf-note">{t.files.workspace.searching}</p>}{changes ? (() => {
        const filtered = changes.filter((item) => item.path.toLowerCase().includes(query.trim().toLowerCase())), groups = groupChanges(filtered, roots), grouped = groupChanges(changes, roots).length > 1
        const row = (item: FileChange): React.JSX.Element => { const slash = item.path.lastIndexOf('/'), name = item.path.slice(slash + 1), dir = slash > 0 ? item.path.slice(0, slash) : '', path = absolute(item.path, item.root), detail = [grouped ? '' : item.root ? nameOf(item.root) : '', dir].filter(Boolean).join('/'); return <button key={`${item.root ?? ''}:${item.path}`} type="button" role="listitem" className={`wf-result wf-changed ${path && slashed(active) === slashed(path) ? 'on' : ''}`} data-tip={path ?? item.path} onContextMenu={(event) => { if (path) showContext({ path, name, directory: false }, event) }} onClick={() => openChange(item)} onDoubleClick={() => openChange(item, true)}><b><FileTypeIcon path={item.path} />{name}{item.untracked ? <span className="ch-new">{t.files.workspace.changed.newBadge}</span> : <span className="wf-nums"><span className="ch-add">+{item.added}</span><span className="ch-del">−{item.removed}</span></span>}</b>{detail && <small>{detail}</small>}</button> }
        return <div role="list" aria-label={t.files.workspace.changed.listLabel}>{grouped ? groups.map((group) => { const closed = collapsedRepos.includes(group.root ?? ''); return <div key={group.root ?? ''} className="wf-repogroup"><div className="wf-repohead"><button type="button" className="wf-repotoggle" aria-expanded={!closed} data-tip={group.root ?? group.name} onClick={() => setCollapsedRepos((all) => closed ? all.filter((key) => key !== (group.root ?? '')) : [...all, group.root ?? ''])}><span className={`wf-chevron ${closed ? '' : 'open'}`} aria-hidden="true"><ChevronRightSmallIcon /></span>{group.worktree ? <TreeIcon /> : <BranchIcon />}<b>{group.name}</b>{group.branch && <small>{group.branch}</small>}<span className="wf-nums"><span className="ch-add">+{group.added}</span><span className="ch-del">−{group.removed}</span></span></button><button type="button" className="ibtn tip" data-tip={t.files.workspace.changed.openRepoFiles(group.files.length)} aria-label={t.files.workspace.changed.openRepoFilesLabel(group.name)} onClick={() => group.files.slice(0, 20).forEach((item) => openChange(item, true))}><DiffIcon /></button></div>{!closed && group.files.map(row)}</div> }) : filtered.map(row)}{!changes.length && <p className="wf-note">{t.files.workspace.changed.none}</p>}</div>
      })() : results ? <div>{results.paths.map((path) => <button key={path} type="button" className={`wf-result ${active === path ? 'on' : ''}`} data-tip={path} onContextMenu={(event) => showContext({ path, name: nameOf(path), directory: false }, event)} onClick={() => void openClick(path)} onDoubleClick={() => void openClick(path, true)}><b><FileTypeIcon path={path} />{nameOf(path)}</b><small>{path}</small></button>)}{!results.paths.length && !searching && <p className="wf-note">{t.files.workspace.notFound}</p>}{results.limited && <p className="wf-note">{t.files.workspace.searchLimited}</p>}</div> : <div role="tree">{roots.filter((root) => root.primary).map((root) => <TreeFolder key={root.path} entry={{ ...root, directory: true }} context={context} contexts={roots} selected={active} open={(path, pinned) => { void openClick(path, pinned) }} reveal={reveal} menu={showContext} editing={editing} finish={(name) => void finishEdit(name)} ask={askTree} create={startCreate} nonce={treeNonce} />)}</div>}</nav>}
      {tree && <div className="wf-treesplit" role="separator" aria-label={t.files.workspace.resizeTree} aria-orientation="vertical" onPointerDown={resizeTree} onDoubleClick={() => { setTreeWidth(240); try { localStorage.setItem('gearmod.fileTreeWidth', '240') } catch { /* only valid for this session */ } }} />}
      {current ? <FilePane doc={current} mode="full" context={context} preferences={preferences} changePreferences={change} change={changeFor(current.path)} root={currentRoot} commentCardId={commentCardId} commentTarget={commentTarget} update={updateDocument} save={save} reload={(path) => void reload(path)} afterComment={() => { if (!standalone) close() }} error={error} loading={loading} setError={setError} roots={roots} selectionText={selectionText} closeDocument={() => closeTab(current)} restore={(path) => void restore(path)} command={command} jump={jump && slashed(jump.path) === slashed(current.path) ? jump : undefined} onJumped={() => setJump(undefined)} openAt={(path, line) => openQuick(path, line)} />
        : <div className="wf-document">{(error) && <div className="wf-error" role="alert">{error}</div>}{loading && <p className="wf-note">{t.files.workspace.opening}</p>}<div className="wf-empty"><FolderGlyph /><p>{changes ? t.files.workspace.pickChanged : t.files.workspace.pickInTree}</p>{!tree && <button type="button" className="mini secondary" onClick={() => { change({ tree: true }); setTreeVisible(true) }}>{t.files.workspace.showFiles}</button>}</div></div>}
    </div>
  </section>
}
