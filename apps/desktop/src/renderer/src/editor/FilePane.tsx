import React, { useEffect, useMemo, useRef, useState } from 'react'
import { isShortcut } from '../shortcuts'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { findNext, findPrevious, replaceAll, replaceNext } from '@codemirror/search'
import { Markdown } from '../markdown'
import { markdownImages } from './markdownImages'
import { headingTrail, markdownHeadings } from './markdownOutline'
import { CodeIcon, CommentIcon, CompareIcon, DiffIcon, EyeIcon, OutlineIcon, PencilIcon, RefreshIcon, RowsIcon, SaveIcon, SearchIcon, SendIcon, SplitIcon } from '../icons'
import { FileFind, GoToLine, fileMatches, type FindOptions } from '../FileFind'
import { fileKind } from '../FileAppearance'
import { plainError } from '../NoticeDialog'
import { ConfirmDialog } from '../ConfirmDialog'
import type { FileChange } from '../changes'
import { CodeEditor } from './CodeEditor'
import { DiffEditor } from './DiffEditor'
import { ConflictCompare } from './ConflictCompare'
import { GitContextChip } from './GitContextChip'
import { applyFind, hiddenSearch } from './search'
import { linePicker, setPicked } from './picks'
import { editorKeymap } from './keymap'
import { languageName } from './languages'
import { detectIndent, normalizeEol, parseGoto } from './position'
import { cursorInfo, isHtml, isMarkdown, nameOf, readViewState, slashed, writeViewState, type Document } from './documents'
import type { Preferences } from './preferences'
import { CodeNavDialog, KindMark, type NavItem } from './CodeNav'
import { nameAtCursor, symbolTrail, type OutlineItem } from './codeNavigation'
import { useT } from '../i18n'

export type PaneCommand = { type: 'find' | 'replace' | 'goto' | 'toggle-find'; at: number }
export interface FilePaneProps {
  doc: Document; mode: 'full' | 'focused'; context: { projectId: string; cardId: string | null }
  preferences: Preferences; changePreferences(patch: Partial<Preferences>): void
  change?: FileChange | undefined; root?: { path: string; branch?: string | null; worktree?: boolean } | undefined
  commentCardId: string | null; commentTarget: string
  update(path: string, patch: Partial<Document>): void; save(path: string): Promise<boolean>; reload(path: string): void
  afterComment(): void; error: string; loading: boolean; setError(value: string): void
  command?: PaneCommand | undefined; jump?: { line: number; column: number; length?: number } | undefined; onJumped?(): void
  /** Focused mode only: repository name shown before the path and extra buttons at the end of the header. */
  repoName?: string | undefined; headerEnd?: React.ReactNode
  /** Close the tab (deleted-file banner) and recreate the deleted file with the current text; without `restore` the button does not appear. */
  closeDocument?(): void; restore?(path: string): void
  /** The panel fills this with a function that returns the text selected in the editor (to seed the project search). */
  selectionText?: React.MutableRefObject<(() => string) | null>
  /** Project roots: a dropped image that is already inside them becomes just a relative link. */
  roots?: Array<{ path: string }>
  /** Opens another file at a line (go to definition, who uses it); without this it only navigates within the open file. */
  openAt?(path: string, line: number): void
}

/**
 * Area of an open file: actions header, find/replace, go to line, editor, diff, preview, line comments and status bar.
 * `full` is the Files mode (inside a tab); `focused` is the panel beside the chat, which opens on the diff and only edits after "Edit".
 */
export function FilePane({ doc, mode, context, preferences, changePreferences, change, root, commentCardId, commentTarget, update, save, reload, afterComment, error, loading, setError, command, jump, onJumped, repoName, headerEnd, closeDocument, restore, selectionText, roots, openAt }: FilePaneProps): React.JSX.Element {
  const t = useT(), focused = mode === 'focused'
  const view = useRef<EditorView | null>(null), codeBox = useRef<HTMLDivElement>(null), statusBox = useRef<HTMLSpanElement>(null), searchField = useRef<HTMLInputElement>(null), commentField = useRef<HTMLTextAreaElement>(null), pickDrag = useRef<number | null>(null)
  const [find, setFind] = useState(false), [needle, setNeedle] = useState(''), [findOptions, setFindOptions] = useState<FindOptions>({ caseSensitive: false, wholeWord: false, regex: false }), [matchIndex, setMatchIndex] = useState(-1), [replaceOpen, setReplaceOpen] = useState(false), [replacement, setReplacement] = useState('')
  const [goto, setGoto] = useState(false), [cursor, setCursor] = useState({ line: 1, column: 1, selected: 0, ranges: 1 }), [indentMenu, setIndentMenu] = useState(false), [image, setImage] = useState(''), [edit, setEdit] = useState(false), [discarding, setDiscarding] = useState(false), [outlineOpen, setOutlineOpen] = useState(false), [conflictView, setConflictView] = useState<{ ours: string; theirs: string; oursLabel: string; theirsLabel: string }>()
  const previewRef = useRef<HTMLDivElement>(null), outlineBox = useRef<HTMLSpanElement>(null)
  const [lines, setLines] = useState<[number, number] | null>(null), [composing, setComposing] = useState(false), [comment, setComment] = useState(''), [buttonTop, setButtonTop] = useState(4), [commentError, setCommentError] = useState('')
  const linesRef = useRef(lines), composingRef = useRef(composing); linesRef.current = lines; composingRef.current = composing
  const search = useMemo(() => fileMatches(doc.content, needle, findOptions), [doc.content, needle, findOptions])
  const indent = useMemo(() => detectIndent(doc.saved), [doc.path, doc.saved])
  const editorOptions = useMemo(() => ({ tabs: indent.kind === 'tab', wrap: preferences.wrap, tabSize: preferences.tabSize, indentWithTab: preferences.indent, whitespace: preferences.whitespace, guides: preferences.guides, scrollPastEnd: preferences.beyond }), [indent.kind, preferences.wrap, preferences.tabSize, preferences.indent, preferences.whitespace, preferences.guides, preferences.beyond])
  const readOnly = doc.truncated || Boolean(doc.locked) || (focused && !edit), canDiff = Boolean(change?.diff)
  // Diff view ("after" side): serves as the target for jumping to a line when the file opens on the changes.
  const diffView = useRef<EditorView | null>(null), [viewReady, setViewReady] = useState(0)
  const liveView = (): EditorView | null => view.current?.dom.isConnected ? view.current : null
  const jumpView = (): EditorView | null => liveView() ?? (diffView.current?.dom.isConnected ? diffView.current : null)
  if (selectionText) selectionText.current = () => { const editor = view.current?.dom.isConnected ? view.current : null; if (!editor) return ''; const range = editor.state.selection.main; return range.empty ? '' : editor.state.sliceDoc(range.from, Math.min(range.to, range.from + 200)) }
  const showFind = (withReplace?: boolean): void => { if (withReplace !== undefined) setReplaceOpen(withReplace); else if (!find) setReplaceOpen(false); setFind(true); window.setTimeout(() => { searchField.current?.focus(); searchField.current?.select() }, 0) }
  const showGoto = (): void => { if (doc.binary) return; if (doc.preview) update(doc.path, { preview: false }); setGoto(true) }
  const gotoLine = (line: number, column = 1, length = 0): boolean => {
    const editor = jumpView(); if (!editor) return false
    const text = editor.state.doc, target = text.line(Math.min(Math.max(1, line), text.lines)), at = target.from + Math.min(column - 1, target.length)
    const head = Math.min(at + length, target.to)
    editor.dispatch({ selection: { anchor: at, head }, effects: EditorView.scrollIntoView(at, { y: 'center' }) }); editor.focus()
    // If the editor is recreated right after (tab switch, document reload), it goes back to this position, not the old one.
    const path = doc.path
    writeViewState(path, { anchor: at, head, scrollTop: editor.scrollDOM.scrollTop })
    window.requestAnimationFrame(() => { if (editor.dom.isConnected) writeViewState(path, { anchor: at, head, scrollTop: editor.scrollDOM.scrollTop }) })
    return true
  }
  const searchInFile = (direction = 1): void => {
    if (!search.matches.length) return
    const run = (): void => { const editor = liveView(); if (!editor) return; (direction > 0 ? findNext : findPrevious)(editor); const at = editor.state.selection.main.from; setMatchIndex(search.matches.findIndex(([start]) => start === at)) }
    if (doc.preview) { update(doc.path, { preview: false }); window.setTimeout(run, 80) } else run()
  }
  const replaceWith = (all: boolean): void => { const editor = liveView(); if (editor && !readOnly) (all ? replaceAll : replaceNext)(editor) }
  const pickLine = (index: number, extend: boolean): void => {
    if (extend && linesRef.current) { setLines([linesRef.current[0], index]); return }
    pickDrag.current = index; setComposing(false); setLines([index, index])
  }
  /** The comment button follows the last chosen line, also when scrolling. */
  const placeButton = (): void => { const editor = liveView(), box = codeBox.current, picked = linesRef.current; if (!editor || !box || !picked) return; const line = editor.state.doc.line(Math.min(Math.max(...picked) + 1, editor.state.doc.lines)); setButtonTop(Math.max(4, Math.round(editor.documentTop + editor.lineBlockAt(line.from).bottom - box.getBoundingClientRect().top - 14))) }
  // Code index: file structure (re-read after saving) and the F12 / Shift+F12 lists.
  const [codeOutline, setCodeOutline] = useState<OutlineItem[]>([]), [nav, setNav] = useState<{ title: string; items: NavItem[]; note?: string } | null>(null)
  const goItem = (item: { path: string; line: number }): void => { if (slashed(item.path) === slashed(doc.path)) gotoLine(item.line); else openAt?.(item.path, item.line) }
  const lookUp = async (what: 'definition' | 'references'): Promise<void> => {
    const editor = liveView(), codeNav = t.files.editor.codeNav
    if (!editor) return
    const name = nameAtCursor(editor.state)
    if (!name) { setNav({ title: what === 'definition' ? t.files.editor.shortcuts.definition : t.files.editor.shortcuts.references, items: [], note: codeNav.noWord }); return }
    try {
      if (what === 'definition') {
        const found = await window.gearmod.invoke('code-index:definition', { ...context, name, path: doc.path })
        // A single definition: goes straight there, as in VS Code; several open the list.
        if (found.length === 1) { goItem(found[0]!); return }
        setNav({ title: codeNav.definitionsOf(name), items: found.map((hit) => ({ path: hit.path, relative: hit.relative, line: hit.line, title: hit.qname || hit.name, kind: hit.kind, detail: hit.signature.slice(0, 80) })), note: codeNav.noDefinition(name) })
      } else {
        const found = await window.gearmod.invoke('code-index:references', { ...context, name, path: doc.path })
        setNav({ title: codeNav.referencesOf(name, found.length), items: found.map((hit) => ({ path: hit.path, relative: hit.relative, line: hit.line, title: hit.caller })), note: codeNav.noReferences(name) })
      }
    } catch { setNav({ title: name, items: [], note: codeNav.failed }) }
  }
  const actions = useRef({ save: (): void => undefined, find: (): void => undefined, replace: (): void => undefined, goto: (): void => undefined, place: (): void => undefined, definition: (): void => undefined, references: (): void => undefined, outline: (): void => undefined })
  actions.current = { save: () => { void save(doc.path) }, find: () => showFind(), replace: () => showFind(true), goto: showGoto, place: placeButton, definition: () => { void lookUp('definition') }, references: () => { void lookUp('references') }, outline: () => { if (outlineItems.length) setOutlineOpen(true) } }
  const extensions = useMemo<Extension[]>(() => [
    hiddenSearch,
    linePicker((index, extend) => pickLine(index, extend), (index) => { if (pickDrag.current !== null) setLines([pickDrag.current, index]) }, () => { pickDrag.current = null }),
    EditorView.updateListener.of((updated) => {
      if (updated.selectionSet || updated.docChanged) setCursor(cursorInfo(updated.state))
      if (!updated.selectionSet) return
      const { from, to } = updated.state.selection.main, text = updated.state.doc
      if (from === to) { if (!composingRef.current) setLines(null); return }
      setComposing(false); setLines([text.lineAt(from).number - 1, text.lineAt(text.sliceString(to - 1, to) === '\n' ? to - 1 : to).number - 1])
    }),
    EditorView.domEventHandlers({ scroll: () => { actions.current.place() } }),
    editorKeymap({ save: () => actions.current.save(), find: () => actions.current.find(), replace: () => actions.current.replace(), goto: () => actions.current.goto(), definition: () => actions.current.definition(), references: () => actions.current.references(), outline: () => actions.current.outline() })
  ], [])
  const markdown = isMarkdown(doc.path)
  const headings = useMemo(() => markdown ? markdownHeadings(doc.content) : [], [markdown, doc.content])
  const codeFile = !markdown && !doc.binary && !doc.truncated && fileKind(doc.path) !== 'image'
  useEffect(() => {
    setCodeOutline([])
    if (!codeFile) return
    let alive = true
    // After saving, waits for the index to re-read the file (its watcher has a small delay).
    const timer = window.setTimeout(() => { void window.gearmod.invoke('code-index:outline', { ...context, path: doc.path }).then((found) => { if (alive) setCodeOutline(found.map((hit) => ({ line: hit.line, endLine: hit.endLine, text: hit.name, depth: hit.depth, kind: hit.kind }))) }).catch(() => undefined) }, 700)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [codeFile, doc.path, doc.saved, context.projectId, context.cardId])
  const outlineItems = useMemo<OutlineItem[]>(() => markdown ? headings.map((heading) => ({ line: heading.line, endLine: heading.line, text: heading.text, depth: heading.level - 1 })) : codeOutline, [markdown, headings, codeOutline])
  const trail = useMemo<Array<{ line: number; text: string }>>(() => doc.preview ? [] : markdown ? headingTrail(headings, cursor.line) : symbolTrail(codeOutline, cursor.line), [markdown, doc.preview, headings, codeOutline, cursor.line])
  const outlineLabel = markdown ? t.files.editor.pane.outline : t.files.editor.codeNav.outline
  const goHeading = (heading: { line: number }): void => { setOutlineOpen(false); if (doc.preview) previewRef.current?.querySelector(`[data-line="${heading.line - 1}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); else gotoLine(heading.line) }
  /** Pasting or dropping an image only in editable Markdown: saves to `imagens/` and inserts the link. */
  const editorExtensions = useMemo<Extension[]>(() => markdown && !readOnly ? [...extensions, markdownImages({
    markdownPath: doc.path, fail: (message) => setError(message), droppedPath: (file) => { try { return window.gearmod.getDroppedFilePath(file) } catch { return '' } },
    inProject: (path) => (roots ?? []).some((root) => slashed(path).startsWith(`${slashed(root.path).replace(/\/$/, '')}/`)),
    save: (data, mime) => window.gearmod.invoke('workspace:save-image', { ...context, markdownPath: doc.path, data, mime })
  })] : extensions, [markdown, readOnly, extensions, doc.path, roots, context.projectId, context.cardId])
  useEffect(() => {
    if (!outlineOpen) return
    const away = (event: PointerEvent): void => { if (!outlineBox.current?.contains(event.target as Node)) setOutlineOpen(false) }
    document.addEventListener('pointerdown', away); return () => document.removeEventListener('pointerdown', away)
  }, [outlineOpen])
  useEffect(() => { liveView()?.dispatch({ effects: setPicked.of(lines) }); placeButton() }, [lines, doc.path])
  useEffect(() => { const editor = liveView(); if (editor) applyFind(editor, find && !doc.preview, { search: needle, caseSensitive: findOptions.caseSensitive, regexp: findOptions.regex, wholeWord: findOptions.wholeWord, replace: replacement }) }, [find, needle, findOptions, replacement, doc.path, doc.preview])
  useEffect(() => { setMatchIndex(-1) }, [needle, findOptions, doc.path])
  useEffect(() => { setLines(null); setComposing(false); setComment(''); setCommentError(''); setGoto(false); setEdit(false); setConflictView(undefined) }, [doc.path])
  useEffect(() => { const up = (): void => { pickDrag.current = null }; document.addEventListener('mouseup', up); return () => document.removeEventListener('mouseup', up) }, [])
  useEffect(() => { if (composing) commentField.current?.focus() }, [composing])
  useEffect(() => { setImage(''); if (fileKind(doc.path) !== 'image') return; let alive = true; void window.gearmod.invoke('workspace:image', { ...context, path: doc.path }).then((url) => { if (alive) setImage(url) }).catch((reason) => { if (alive) setError(plainError(reason)) }); return () => { alive = false } }, [doc.path])
  useEffect(() => { if (!command) return; if (command.type === 'find') showFind(); else if (command.type === 'replace') showFind(true); else if (command.type === 'goto') showGoto(); else if (find) setFind(false); else showFind() }, [command?.at])
  useEffect(() => {
    if (!jump) return
    // Line requested in a Markdown/HTML preview: shows the code so the cursor can land on it.
    if (doc.preview) { if (fileKind(doc.path) !== 'image' && !doc.binary) update(doc.path, { preview: false }); return }
    // The view may not exist yet (diff loading the versions, editor mounting): runs again when it is ready.
    // While the file is still loading, the editor has only empty text and the line would land on 1: waits for the content to arrive.
    const live = liveView()
    if (loading || (live && typeof doc.content === 'string' && live.state.doc.length !== doc.content.replace(/\r\n?/g, '\n').length)) return
    if (gotoLine(jump.line, jump.column, jump.length)) onJumped?.()
  }, [jump, doc.path, doc.preview, doc.diffView, Boolean(doc.versions), Boolean(doc.compare), loading, viewReady, doc.content])
  useEffect(() => {
    if (!indentMenu) return
    const away = (event: PointerEvent): void => { if (!statusBox.current?.contains(event.target as Node)) setIndentMenu(false) }
    document.addEventListener('pointerdown', away); return () => document.removeEventListener('pointerdown', away)
  }, [indentMenu])
  const sendComment = async (): Promise<void> => {
    if (!lines || !comment.trim()) return
    const from = Math.min(...lines), to = Math.max(...lines), code = doc.content.split('\n').slice(from, to + 1).join('\n')
    const fence = '`'.repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((run) => run.length + 1))), language = /\.([A-Za-z0-9]+)$/.exec(doc.path)?.[1] ?? ''
    const span = from === to ? `linha ${from + 1}` : `linhas ${from + 1}–${to + 1}`
    const text = `Comentário em \`${doc.relative}\` (${span}${doc.content !== doc.saved ? ', texto atual do editor, com alterações ainda não salvas' : ''}):\n\n${fence}${language}\n${code}\n${fence}\n\n${comment.trim()}`
    try { setCommentError(''); await window.gearmod.invoke('workspace:comment', { ...context, cardId: commentCardId, text }); setLines(null); setComposing(false); setComment(''); afterComment() } catch (reason) { setCommentError(plainError(reason)) }
  }
  const keyDown = (event: React.KeyboardEvent): void => {
    const native = event.nativeEvent, stop = (): void => { event.preventDefault(); event.stopPropagation() }
    if (isShortcut(native, 'save')) { stop(); void save(doc.path) } else if (isShortcut(native, 'find')) { stop(); showFind() } else if (isShortcut(native, 'replace') && !doc.binary) { stop(); showFind(true) } else if (isShortcut(native, 'goToLine') && !doc.binary) { stop(); showGoto() }
  }
  // Esc closes search/go to line and returns focus to the editor (the capture prevents the field's onKeyDown).
  const escape = (event: React.KeyboardEvent): void => { if (event.key === 'Escape' && (find || goto)) { event.preventDefault(); event.stopPropagation(); setFind(false); setGoto(false); liveView()?.focus() } }
  const dirty = doc.content !== doc.saved, previewable = isMarkdown(doc.path) || isHtml(doc.path) || fileKind(doc.path) === 'image'
  const reviewTarget = { path: doc.relative, send: async (prompt: string): Promise<boolean> => { try { await window.gearmod.invoke('workspace:comment', { ...context, cardId: commentCardId, text: prompt }); afterComment(); return true } catch (reason) { setError(plainError(reason)); return false } } }
  const actionsRow = <>
    {!doc.binary && !doc.truncated && <>
      {/* Always there, so the bar does not jump when the outline arrives: disabled while it loads (or when the file has none). */}
      <span className="wf-outlinewrap" ref={outlineBox}><button type="button" className="wf-iconchip" disabled={outlineItems.length === 0} aria-label={outlineLabel} aria-expanded={outlineOpen} data-tip={markdown ? outlineLabel : `${outlineLabel} (Ctrl+Shift+O)`} onClick={() => setOutlineOpen(!outlineOpen)}><OutlineIcon /></button>{outlineOpen && <div className={`popmenu wf-outline ${markdown ? '' : 'code'}`} role="menu" aria-label={outlineLabel}>{outlineItems.map((item) => <button key={`${item.line}:${item.text}`} type="button" role="menuitem" style={{ paddingLeft: 8 + item.depth * 12 }} onClick={() => goHeading(item)}>{!markdown && <KindMark kind={item.kind} />}{item.text}</button>)}</div>}</span>
      {previewable && <button type="button" className="wf-iconchip" aria-label={doc.preview ? t.files.editor.pane.viewSource : t.files.editor.pane.preview} data-tip={doc.preview ? t.files.editor.pane.viewSource : t.files.editor.pane.preview} onClick={() => update(doc.path, { preview: !doc.preview })}>{doc.preview ? <CodeIcon /> : <EyeIcon />}</button>}
      {!focused && doc.diffView && canDiff && <button type="button" className="wf-iconchip" aria-label={preferences.diffLayout === 'split' ? t.files.editor.diff.oneColumnLabel : t.files.editor.diff.sideBySideLabel} data-tip={preferences.diffLayout === 'split' ? t.files.editor.diff.oneColumn : t.files.editor.diff.sideBySide} onClick={() => changePreferences({ diffLayout: preferences.diffLayout === 'split' ? 'unified' : 'split' })}>{preferences.diffLayout === 'split' ? <RowsIcon /> : <SplitIcon />}</button>}
      {canDiff && <button type="button" className={`wf-iconchip ${doc.diffView ? 'on' : ''}`} aria-label={doc.diffView ? (focused ? t.files.editor.pane.viewCode : t.files.editor.pane.editFile) : t.files.editor.pane.viewChanges} data-tip={doc.diffView ? (focused ? t.files.editor.pane.viewCode : t.files.editor.pane.editFile) : t.files.editor.pane.viewChangesTip} onClick={() => update(doc.path, { diffView: !doc.diffView })}><DiffIcon /></button>}
      {focused && !doc.locked && <button type="button" className={`wf-iconchip ${edit ? 'on' : ''}`} aria-pressed={edit} aria-label={edit ? t.files.editor.pane.backToReadOnly : t.files.editor.pane.editFile} data-tip={edit ? t.files.editor.pane.editingTip : t.files.editor.pane.editFile} onClick={() => { setEdit(!edit); if (!edit && !doc.preview) window.setTimeout(() => liveView()?.focus(), 0) }}><PencilIcon /></button>}
      {dirty && !doc.compare && <button type="button" className="wf-iconchip" aria-label={t.files.editor.pane.compareSaved} data-tip={t.files.editor.pane.compareSaved} onClick={() => update(doc.path, { compare: { before: doc.saved, title: t.files.editor.pane.unsavedTitle, split: false } })}><CompareIcon /></button>}
      <button type="button" className="wf-iconchip" aria-label={t.files.editor.pane.save} data-tip={t.files.editor.pane.saveTip} disabled={!dirty} onClick={() => void save(doc.path)}><SaveIcon /></button></>}
    <button type="button" className="wf-iconchip" aria-label={t.files.editor.pane.reload} data-tip={t.files.editor.pane.reload} onClick={() => reload(doc.path)}><RefreshIcon /></button>
    {!doc.binary && <button type="button" className="wf-iconchip" aria-label={t.files.editor.pane.searchInFile} data-tip={t.files.editor.pane.searchInFileTip} onClick={() => find ? setFind(false) : showFind()}><SearchIcon /></button>}
  </>
  const parts = doc.relative.split('/')
  return <div className={`wf-document ${focused ? 'focused' : ''}`} onKeyDown={keyDown} onKeyDownCapture={escape}>
    {focused
      ? <div className="fv-head"><div className="fv-path" data-tip={doc.path}>{repoName && <><span className="fv-repo">{repoName}</span><span className="fv-sep">›</span></>}{parts.map((part, index) => <React.Fragment key={index}>{index > 0 && <span className="fv-sep">›</span>}<span className={index === parts.length - 1 ? 'fv-name' : ''}>{part}</span></React.Fragment>)}{trail.map((heading) => <React.Fragment key={heading.line}><span className="fv-sep">›</span><button type="button" className="wf-crumb" data-tip={t.files.editor.pane.openOutline} onClick={() => setOutlineOpen(true)}>{heading.text}</button></React.Fragment>)}</div>{dirty && <small className="fv-size" data-tip={t.files.editor.pane.unsavedMark}>•</small>}{actionsRow}{headerEnd}</div>
      : <div className="wf-filebar"><span data-tip={doc.path}>{doc.relative}{trail.map((heading) => <React.Fragment key={heading.line}> › <button type="button" className="wf-crumb" data-tip={t.files.editor.pane.openOutline} onClick={() => setOutlineOpen(true)}>{heading.text}</button></React.Fragment>)}</span>{root && <GitContextChip root={root} title={root.path} />}{actionsRow}</div>}
    {find && <FileFind input={searchField} query={needle} setQuery={setNeedle} options={findOptions} setOptions={setFindOptions} count={search.matches.length} index={matchIndex} error={search.error} previous={() => searchInFile(-1)} next={() => searchInFile(1)} close={() => setFind(false)} replace={{ open: replaceOpen, setOpen: setReplaceOpen, text: replacement, setText: setReplacement, disabled: readOnly || doc.binary, one: () => replaceWith(false), all: () => replaceWith(true) }} />}
    {goto && <GoToLine close={() => { setGoto(false); liveView()?.focus() }} submit={(text) => { const target = parseGoto(text); return target ? gotoLine(target.line, target.column) : false }} />}
    {doc.conflict && <div className="wf-banner" role="alert"><span>{t.files.editor.pane.changedOnDisk}</span><button type="button" onClick={() => update(doc.path, { compare: { before: doc.conflict!.content, title: t.files.editor.pane.diskVsYours, split: true } })}>{t.files.editor.pane.compare}</button><button type="button" data-tip={t.files.editor.pane.keepMineTip} onClick={() => { update(doc.path, { saved: doc.conflict!.content, disk: doc.conflict!.disk, eol: doc.conflict!.eol, conflict: undefined }); window.setTimeout(() => liveView()?.focus(), 0) }}>{t.files.editor.pane.keepMine}</button><button type="button" onClick={() => setDiscarding(true)}>{t.files.editor.pane.reloadAction}</button></div>}
    {doc.deleted && <div className="wf-banner" role="alert"><span>{t.files.editor.pane.deleted}</span>{restore && <button type="button" onClick={() => restore(doc.path)}>{t.files.editor.pane.saveAnyway}</button>}{closeDocument && <button type="button" onClick={closeDocument}>{t.common.close}</button>}</div>}
    {(error || doc.error) && <div className="wf-error" role="alert">{error || doc.error}</div>}{loading && <p className="wf-note">{t.files.workspace.opening}</p>}
    {conflictView ? <ConflictCompare info={conflictView} path={doc.path} options={editorOptions} back={() => setConflictView(undefined)} />
      : doc.compare ? <div className="wf-diffview"><DiffEditor key={`${doc.path}:compare`} before={doc.compare.before} after={doc.content} path={doc.path} layout={doc.compare.split ? 'split' : focused ? 'unified' : preferences.diffLayout} editable={!readOnly && !doc.binary} onChange={(text) => update(doc.path, { content: text })} options={editorOptions} title={doc.compare.title} onBack={() => update(doc.path, { compare: undefined })} /></div>
      : doc.diffView && canDiff ? <div className="wf-diffview">{doc.versions ? <DiffEditor key={doc.path} before={doc.versions.before === null ? null : normalizeEol(doc.versions.before)} after={doc.versions.after === null ? null : doc.content} path={doc.path} layout={focused ? 'unified' : preferences.diffLayout} editable={!readOnly && !doc.binary} onChange={(text) => update(doc.path, { content: text })} options={editorOptions} {...(doc.versions.binary ? { unavailable: 'binary' as const } : doc.versions.truncated ? { unavailable: 'truncated' as const } : {})} fallbackDiff={change!.diff} review={reviewTarget} onReady={(editor) => { diffView.current = editor; setViewReady((value) => value + 1) }} title={t.files.editor.pane.changesSince(doc.versions.baseLabel)} /> : <p className="wf-note">{t.files.editor.pane.loadingChanges}</p>}</div>
      : fileKind(doc.path) === 'image' && (doc.binary || doc.preview) ? <div className="wf-imagepreview">{image ? <img src={image} alt={nameOf(doc.path)} /> : <p className="wf-note">{error || t.files.editor.pane.loadingPreview}</p>}</div>
        : doc.binary ? <p className="wf-note">{t.files.editor.pane.noPreview}</p>
          : doc.preview ? isMarkdown(doc.path) ? <div className="md wf-preview" ref={previewRef}><Markdown source={doc.content} base={{ ...context, path: doc.path }} runnable={false} /></div> : <iframe className="wf-html" title={t.files.editor.pane.htmlPreview(nameOf(doc.path))} sandbox="" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">${doc.content}`} />
            : <div ref={codeBox} className="wf-code">{lines && !composing && !readOnly && <button type="button" className="gdl-chatbtn tip" data-tip={t.files.editor.diff.commentLines(Math.abs(lines[1] - lines[0]) + 1)} aria-label={t.files.editor.diff.commentLinesLabel} style={{ top: buttonTop }} onClick={() => setComposing(true)}><CommentIcon /></button>}
              <CodeEditor key={doc.path} value={doc.content} path={doc.path} readOnly={readOnly} options={editorOptions} extensions={editorExtensions} onCompareConflict={setConflictView} ariaLabel={t.files.editor.pane.sourceLabel(nameOf(doc.path))} onChange={(text) => update(doc.path, { content: text })} onReady={(editor) => { view.current = editor; setCursor(cursorInfo(editor.state)); setViewReady((value) => value + 1) }} initialSelection={readViewState(doc.path)} initialScroll={jump ? undefined : readViewState(doc.path)?.scrollTop} onViewState={(state) => writeViewState(doc.path, state)} />
            </div>}
    {lines && composing && <div className="gdl-compose" role="group" aria-label={t.files.editor.diff.commentLinesLabel}>
      <div className="gdl-askhead"><span>{t.files.editor.pane.linesSelected(Math.abs(lines[1] - lines[0]) + 1, nameOf(doc.path))}</span><span className={`wf-comment-target ${commentCardId ? 'card' : 'new'}`}>{commentTarget}</span><button type="button" className="ghost" onClick={() => { setComposing(false); setLines(null); setComment('') }}>{t.common.cancel}</button></div>
      <div className="cbox"><textarea ref={commentField} value={comment} rows={1} placeholder={t.files.editor.diff.commentPlaceholder} aria-label={t.files.editor.diff.commentLabel} onChange={(event) => setComment(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendComment() } else if (event.key === 'Escape') { event.stopPropagation(); setComposing(false); setLines(null); setComment('') } }} />
        <button type="button" className="sendbtn tip" data-tip={t.files.editor.diff.sendTip} aria-label={t.files.editor.diff.send} disabled={!comment.trim()} onClick={() => void sendComment()}><SendIcon /></button></div>
      {commentError && <p className="error">{commentError}</p>}</div>}
    {doc.truncated && <p className="wf-note">{t.files.editor.pane.truncated}</p>}
    {nav && <CodeNavDialog title={nav.title} items={nav.items} note={nav.note} open={goItem} close={() => { setNav(null); window.setTimeout(() => liveView()?.focus(), 0) }} />}
    {discarding && doc.conflict && <ConfirmDialog eyebrow={t.files.editor.pane.reloadDisk.eyebrow} title={t.files.editor.pane.reloadDisk.title} text={t.files.editor.pane.reloadDisk.text(nameOf(doc.path))} ok={t.files.editor.pane.reloadDisk.ok} danger cancel={() => setDiscarding(false)} confirm={() => { setDiscarding(false); update(doc.path, { content: doc.conflict!.content, saved: doc.conflict!.content, disk: doc.conflict!.disk, eol: doc.conflict!.eol, conflict: undefined }) }} />}
    <footer className="wf-status"><b className={`wf-state ${doc.binary || doc.truncated ? '' : dirty ? 'dirty' : 'saved'}`}>{doc.binary ? t.files.editor.pane.status.binary : doc.truncated || doc.locked ? t.files.editor.pane.status.readOnly : dirty ? t.files.editor.pane.status.unsaved : focused && !edit ? t.files.editor.pane.status.readOnly : t.files.editor.pane.status.saved}</b>{doc.notice && <em className="wf-notice" role="status">{doc.notice}</em>}<span>{preferences.autosave ? t.files.editor.pane.status.autosave : t.files.editor.pane.status.saveHint}{!doc.binary && !(doc.preview && fileKind(doc.path) === 'image') && <> · {t.files.editor.pane.status.cursor(cursor.line, cursor.column, cursor.ranges, cursor.selected)} · <span className="wf-statusmenubox" ref={statusBox}><button type="button" className="wf-statusbtn" data-tip={t.files.editor.pane.status.indentTip} aria-expanded={indentMenu} onClick={() => setIndentMenu(!indentMenu)}>{indent.kind === 'tab' ? t.files.editor.pane.status.tab : t.files.editor.pane.status.spaces(preferences.tabSize)}</button>{indentMenu && <span className="popmenu wf-statusmenu" role="menu" aria-label={t.files.editor.pane.status.indentMenu}>{[2, 4, 8].map((size) => <button key={size} type="button" role="menuitemradio" aria-checked={preferences.tabSize === size} className={preferences.tabSize === size ? 'on' : ''} onClick={() => { changePreferences({ tabSize: size }); setIndentMenu(false) }}>{t.files.editor.pane.status.spacesCount(size)}</button>)}</span>}</span> · {doc.eol === 'crlf' ? 'CRLF' : 'LF'} · {languageName(doc.path)}</>}</span></footer>
  </div>
}
