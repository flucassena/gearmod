import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isShortcut, shortcutLabel } from './shortcuts'
import { Decoration, EditorView } from '@codemirror/view'
import { ConfirmDialog } from './ConfirmDialog'
import { plainError } from './NoticeDialog'
import { CodeEditor } from './editor/CodeEditor'
import { ConflictPanes } from './ConflictPanes'
import { ConflictAiDialog } from './ConflictAiDialog'
import type { AgentProfile, Effort } from '@gearmod/contracts'
import { blockOffset, composePicks, parsePicks, pickedLines, pickEvery, sideFullyPicked, togglePick, type Picks } from './editor/conflictPicks'
import { findConflicts, hasConflicts, nextConflict, previousConflict } from './editor/conflicts'
import { usePreferences } from './editor/preferences'
import { useT } from './i18n'
import { toast } from './toasts'
import { ArrowDownIcon, ArrowUpIcon } from './icons'

/** `stash` = stash apply/pop that conflicted: there is no operation to continue/cancel, only files to resolve. */
export type ConflictState = { operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'stash' | null; files: string[] }
export const operationLabel: Record<NonNullable<ConflictState['operation']>, string> = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert', stash: 'Stash' }
export interface ConflictTarget { sourceId: string; cardId: string | null; repo: string; cardTitle: string | null }

/**
 * Conflict resolution inside the Git page, repository by repository (including a card's worktree): the conflicted files on the left and,
 * on the right, the whole file in the editor with "Accept current · incoming · both · Compare" on each block. Nothing is written without "Save".
 */
export function ConflictsView({ target, profiles, changed, back, setDirty }: { target: ConflictTarget; profiles: AgentProfile[]; changed(): void; back(): void; setDirty(value: boolean): void }): React.JSX.Element {
  const { common, git: { conflicts: t } } = useT()
  const { sourceId, cardId } = target, tail = { sourceId, cardId }
  const [state, setState] = useState<ConflictState>({ operation: null, files: [] }), [path, setPath] = useState(''), [drafts, setDrafts] = useState<Record<string, { text: string; saved: string }>>({})
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState<{ title: string; text: string; run(): void }>()
  const [preferences] = usePreferences(), view = useRef<EditorView | null>(null)
  // Per file: the text as Git left it (the panes are built from it), what was ticked line by line, and which block the arrows are on.
  const [bases, setBases] = useState<Record<string, string>>({}), [picks, setPicks] = useState<Record<string, Picks>>({}), [version, setVersion] = useState(0), [active, setActive] = useState(0)
  const rebase = state.operation === 'rebase', oursLabel = rebase ? t.oursBase : t.oursCurrent, theirsLabel = rebase ? t.theirsYourCommit : t.theirsIncoming
  const draft = drafts[path], dirty = (file: string): boolean => Boolean(drafts[file] && drafts[file]!.text !== drafts[file]!.saved)
  // The stash conflict disappears from Git as soon as the last file is marked; keeps the type so the screen does not turn into "Operation".
  const [kind, setKind] = useState<ConflictState['operation']>(null)
  const reload = useCallback(async (): Promise<ConflictState> => { const next = await window.gearmod.invoke('git:conflicts', tail); setState(next); if (next.operation) setKind(next.operation); return next }, [sourceId, cardId])
  useEffect(() => { void reload().catch((reason: unknown) => setError(plainError(reason))) }, [reload])
  useEffect(() => { if (!state.files.includes(path)) setPath(state.files[0] ?? '') }, [state.files, path])
  useEffect(() => {
    if (!path || drafts[path]) return
    let alive = true
    void window.gearmod.invoke('git:conflict-file', { ...tail, path }).then((text) => { if (alive) setDrafts((all) => ({ ...all, [path]: { text, saved: text } })); setBases((all) => ({ ...all, [path]: text })) }).catch((reason: unknown) => { if (alive) setError(plainError(reason)) })
    return () => { alive = false }
  }, [path, sourceId, cardId])
  const anyDirty = Object.values(drafts).some((item) => item.text !== item.saved)
  useEffect(() => { setDirty(anyDirty); return () => setDirty(false) }, [anyDirty])
  const model = useMemo(() => parsePicks(bases[path] ?? ''), [bases[path]]), filePicks = picks[path] ?? {}
  useEffect(() => { setActive(0) }, [path])
  const remaining = useMemo(() => draft ? findConflicts(draft.text).length : 0, [draft?.text])
  const options = useMemo(() => ({ wrap: preferences.wrap, tabSize: preferences.tabSize, indentWithTab: preferences.indent, whitespace: preferences.whitespace, guides: preferences.guides, scrollPastEnd: preferences.beyond }), [preferences.wrap, preferences.tabSize, preferences.indent, preferences.whitespace, preferences.guides, preferences.beyond])
  const act = async (task: () => Promise<unknown>): Promise<void> => { setBusy(true); setError(''); try { await task() } catch (reason) { setError(plainError(reason)) } finally { setBusy(false) } }
  const forget = (file: string): void => { const drop = <T,>(all: Record<string, T>): Record<string, T> => { const next = { ...all }; delete next[file]; return next }; setDrafts(drop); setBases(drop); setPicks(drop) }
  /** Asks before abandoning an edit that has not been saved. */
  const guard = (file: string, title: string, run: () => void): void => { if (dirty(file)) setPending({ title, text: t.unsavedIn(file), run }); else run() }
  const save = (): Promise<void> => act(async () => { if (!draft) return; await window.gearmod.invoke('git:conflict-save', { ...tail, path, content: draft.text }); setDrafts((all) => ({ ...all, [path]: { text: draft.text, saved: draft.text } })) })
  const resolve = (side: 'ours' | 'theirs' | 'marked'): Promise<void> => act(async () => { await window.gearmod.invoke('git:conflict-resolve', { ...tail, path, side }); forget(path); await reload(); changed() })
  const saveAndMark = (): Promise<void> => act(async () => { if (!draft) return; await window.gearmod.invoke('git:conflict-save', { ...tail, path, content: draft.text }); await window.gearmod.invoke('git:conflict-resolve', { ...tail, path, side: 'marked' }); forget(path); await reload(); changed() })
  /** Ticking lines rebuilds the draft (the output) from the original blocks; the output editor is remounted to show it. */
  const applyPicks = (next: Picks): void => { setPicks((all) => ({ ...all, [path]: next })); setVersion((value) => value + 1); setDrafts((all) => ({ ...all, [path]: { text: composePicks(model, next), saved: all[path]?.saved ?? '' } })) }
  // Output lines that came from a picked line are painted with that side's color (only while the text is still exactly what the picks build).
  const pickColors = useMemo(() => {
    if (!draft || !model.blocks.length || draft.text !== composePicks(model, filePicks)) return []
    const lines = pickedLines(model, filePicks)
    return lines.length ? [EditorView.decorations.of(Decoration.set(lines.map((line) => Decoration.line({ class: `cm-pick-${line.side}` }).range(line.at))))] : []
  }, [draft?.text, model, filePicks])
  const pickAll = (side: 'ours' | 'theirs'): void => applyPicks(pickEvery(model, filePicks, side, !sideFullyPicked(model, filePicks, side)))
  const useBoth = (): void => applyPicks(pickEvery(model, filePicks, 'both', true))
  // The output opens (and follows the arrows) on the conflict being worked on.
  useEffect(() => {
    if (!draft || !model.blocks.length) return
    const timer = window.setTimeout(() => { const editor = view.current; if (editor) editor.dispatch({ effects: EditorView.scrollIntoView(Math.min(blockOffset(model, filePicks, active), editor.state.doc.length), { y: 'start', yMargin: 24 }) }) }, 40)
    return () => window.clearTimeout(timer)
  }, [path, version, active, Boolean(draft), model.blocks.length])
  const pick = (index: number, side: 'ours' | 'theirs', line?: number): void => { setActive(index); applyPicks(togglePick(model, filePicks, index, side, line)) }
  // "Resolve with AI": a hidden run in a chat of its own; when it ends the file is read again from disk and shown for review.
  const [aiDialog, setAiDialog] = useState(false), [ai, setAi] = useState<{ runId: string; file: string }>(), [notice, setNotice] = useState('')
  const startAi = (config: { profileId: string; model: string | null; effort: Effort | null }): void => {
    setAiDialog(false); setError(''); setNotice('')
    void act(async () => { const started = await window.gearmod.invoke('git:conflict-ai', { ...tail, path, ...config }); setAi({ runId: started.runId, file: path }) })
  }
  useEffect(() => {
    if (!ai) return
    return window.gearmod.onRunEvent((event) => {
      if (event.runId !== ai.runId || event.eventType !== 'gearmod/run-completed') return
      const result = event.payload as { status?: string; error?: string | null }
      setAi(undefined)
      if (result.status !== 'completed') { setError(t.aiFailed(result.error || result.status || '')); return }
      void window.gearmod.invoke('git:conflict-file', { ...tail, path: ai.file }).then((text) => {
        const drop = <T,>(all: Record<string, T>): Record<string, T> => { const next = { ...all }; delete next[ai.file]; return next }
        setPicks(drop); setBases((all) => ({ ...all, [ai.file]: text })); setDrafts((all) => ({ ...all, [ai.file]: { text, saved: text } })); setVersion((value) => value + 1); setNotice(t.aiDone)
      }).catch((reason: unknown) => setError(plainError(reason)))
    })
  }, [ai?.runId])
  const stash = kind === 'stash'
  // Stash: the files were already marked with git add; there is no "continue" in Git, so finishing just goes back to the graph.
  const finish = (action: 'continue' | 'abort'): Promise<void> => act(async () => { if (!stash) await window.gearmod.invoke('git:conflict-finish', { ...tail, action }); else toast.success(t.stashDone, t.stashKept); changed(); back() })
  const open = (file: string): void => { if (file !== path) guard(path, t.switchFileTitle, () => { setPath(file) }) }
  const label = kind ? operationLabel[kind] : t.operation
  const marked = draft ? hasConflicts(draft.text) : false
  // Ctrl+S with markers: saves the draft, but warns that it cannot yet be marked as resolved.
  const keySave = (): void => { if (!draft) return; if (!marked) { void save(); return } void (draft.text === draft.saved ? Promise.resolve() : save()).then(() => toast.warning(t.markersLeft, t.markersLeftKey)) }
  return <section className="cflview" style={{ gridColumn: '1 / -1' }} aria-label={t.resolveAria} onKeyDown={(event) => { if (isShortcut(event.nativeEvent, 'save')) { event.preventDefault(); keySave() } }}>
    <header className="cflview-head"><div><div className="eyebrow">{stash ? t.stashHead : t.inProgress(label)}</div><h2>{target.repo}{target.cardTitle ? <small>{t.worktreeOf(target.cardTitle)}</small> : null}</h2></div><span className="cflview-count">{state.files.length ? t.filesInConflict(state.files.length) : t.allResolved}</span><button type="button" className="mini secondary" onClick={() => guard(path, t.backToGraphTitle, back)}>{t.backToGraph}</button></header>
    <div className="cflview-body">
      <ul className="cfl-files" aria-label={t.filesAria}>{state.files.map((file) => <li key={file}><button type="button" className={file === path ? 'on' : ''} data-tip={file} onClick={() => open(file)}>{file}{dirty(file) && <i className="cflview-dot" data-tip={t.unsavedChanges} />}</button></li>)}{!state.files.length && <li className="cfl-ok">{stash ? t.stashNothingLeft : t.nothingLeft}</li>}</ul>
      <div className="cflview-main">{path ? <>
        <div className="cfl-actions"><span className="cflview-left">{draft ? t.remaining(remaining) : common.loading}</span>
          <button type="button" className="wf-findnav" aria-label={t.previous} data-tip={t.previousTip} disabled={!remaining && !model.blocks.length} onClick={() => (model.blocks.length ? setActive((active + model.blocks.length - 1) % model.blocks.length) : view.current && previousConflict(view.current))}><ArrowUpIcon /></button>
          <button type="button" className="wf-findnav" aria-label={t.next} data-tip={t.nextTip} disabled={!remaining && !model.blocks.length} onClick={() => (model.blocks.length ? setActive((active + 1) % model.blocks.length) : view.current && nextConflict(view.current))}><ArrowDownIcon /></button>
          <span className="grow1" />
          <button type="button" className="mini" disabled={busy} onClick={() => guard(path, t.useWholeTitle(oursLabel), () => void resolve('ours'))}>{t.useWhole(oursLabel)}</button>
          <button type="button" className="mini" disabled={busy} onClick={() => guard(path, t.useWholeTitle(theirsLabel), () => void resolve('theirs'))}>{t.useWhole(theirsLabel)}</button>
          <button type="button" className="mini" disabled={busy || !model.blocks.length} onClick={useBoth}>{t.useBoth}</button></div>
        {draft ? <div className={`cflview-split ${model.blocks.length ? '' : 'single'}`}>
          {model.blocks.length > 0 && <ConflictPanes model={model} picks={filePicks} change={pick} changeAll={pickAll} oursLabel={oursLabel} theirsLabel={theirsLabel} active={active} setActive={setActive} />}
          <div className="cp-out"><header><b>{t.output}</b>{remaining > 0 && model.blocks.length > 0 && <small>{t.unresolvedOutput}</small>}<span className="grow1" />
            <button type="button" className="mini secondary" disabled={busy || Boolean(ai)} onClick={() => setAiDialog(true)}>{t.aiResolve}</button>
            <button type="button" className="mini secondary" disabled={busy || draft.text === draft.saved} data-tip={shortcutLabel('save')} onClick={() => void save()}>{common.save}</button>
            <button type="button" className="mini" disabled={busy || marked} data-tip={marked ? t.markersLeft : undefined} onClick={() => void saveAndMark()}>{t.saveAndMark}</button></header>
            <div className="cflview-editor"><CodeEditor key={`${path}:${version}`} value={draft.text} path={path} options={options} ariaLabel={t.conflictsIn(path)} conflictLabels={{ ours: oursLabel, theirs: theirsLabel }} conflictActions={false} extensions={pickColors} onChange={(text) => setDrafts((all) => ({ ...all, [path]: { text, saved: all[path]?.saved ?? '' } }))} onReady={(editor) => { view.current = editor }} /></div></div>
        </div> : <div className="cgnote">{common.loading}</div>}
      </> : <div className="cgnote">{t.noConflictFiles}</div>}</div>
    </div>
    {ai && <div className="cx-note" role="status"><span className="spin sm" /> {t.aiWorking} <button type="button" className="mini secondary" onClick={() => void window.gearmod.invoke('agents:cancel', { runId: ai.runId }).catch(() => undefined)}>{t.aiStop}</button></div>}
    {notice && !ai && <p className="cx-note" role="status">{notice}</p>}
    {error && <p className="error">{error}</p>}
    {aiDialog && <ConflictAiDialog file={path} profiles={profiles} unsaved={dirty(path)} close={() => setAiDialog(false)} start={startAi} />}
    <div className="actions">{stash ? <span className="cgnote">{t.stashKept}</span> : <button type="button" className="danger" disabled={busy} onClick={() => setPending({ title: t.cancelTitle(label.toLowerCase()), text: t.cancelText, run: () => void finish('abort') })}>{t.cancelOperation(label.toLowerCase())}</button>}<span className="grow1" /><button type="button" disabled={busy || state.files.length > 0} onClick={() => void finish('continue')}>{stash ? t.stashFinish : t.continueOperation(label.toLowerCase())}</button></div>
    {pending && <ConfirmDialog eyebrow={t.eyebrow} title={pending.title} text={pending.text} ok={common.continue} danger cancel={() => setPending(undefined)} confirm={() => { const run = pending.run; setPending(undefined); run() }} />}
  </section>
}
