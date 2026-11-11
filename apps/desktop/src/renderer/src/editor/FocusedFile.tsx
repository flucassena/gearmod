import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { IpcOutput } from '@gearmod/contracts'
import { ConfirmDialog } from '../ConfirmDialog'
import { CloseIcon, ExternalIcon } from '../icons'
import { findChange, parseChanges, tabLabels, type FileChange } from '../changes'
import { nameOf, slashed } from './documents'
import { FilePane } from './FilePane'
import { splitLineSuffix } from './position'
import { usePreferences } from './preferences'
import { useFileDocuments } from './useFileDocuments'
import { QuickOpen, type QuickMode } from './QuickOpenDialog'
import { shortcutFor } from '../shortcuts'
import { pushRecent, readRecents } from './quickOpen'
import { useT } from '../i18n'

/** Path the way the agent usually writes it: accepts `file:///`, `?query`, `:line` and `#L42`. */
const requestedTarget = (path: string): { path: string; line?: number; column?: number } => splitLineSuffix(path.trim().replace(/^file:\/+/i, '').replace(/\?[^#]*/, ''))

/**
 * File panel beside the chat: the same `FilePane` as in Files mode, but one file at a time, with no tree or tabs.
 * Opens on the diff when the file was changed by the card and only allows typing after "Edit".
 */
export function FocusedFile({ projectId, cardId, chatId, request, close, setDirty, style }: {
  projectId: string; cardId: string | null; chatId?: string | undefined; request: { path: string; at: number }; close(): void; setDirty(value: boolean): void; style?: React.CSSProperties
}): React.JSX.Element {
  const t = useT(), context = useMemo(() => ({ projectId, cardId }), [projectId, cardId])
  const [picked, setPicked] = useState<{ path: string; at: number }>(), [quick, setQuick] = useState<QuickMode | null>(null)
  const openAt = (path: string, line?: number, column?: number): void => setPicked({ path: line ? `${path}:${line}${column ? `:${column}` : ''}` : path, at: Date.now() })
  const effective = picked && picked.at > request.at ? picked : request
  const [preferences, changePreferences] = usePreferences(), [roots, setRoots] = useState<IpcOutput<'workspace:roots'>>([]), [jump, setJump] = useState<{ line: number; column: number }>(), [leaving, setLeaving] = useState(false)
  const changes = useRef<FileChange[]>([])
  const { setDocuments, setActive, current, loading, error, setError, update, save, open, reload, dialog } = useFileDocuments({ projectId, cardId, autosave: preferences.autosave, diffFirst: (path) => Boolean(findChange(changes.current, path)?.diff), readOnlyChatId: chatId })
  useEffect(() => { void window.gearmod.invoke('workspace:roots', context).then(setRoots).catch(() => undefined) }, [context])
  useEffect(() => {
    let alive = true
    const target = requestedTarget(effective.path)
    void (async () => {
      // The diff only opens on its own if the file is in the card's changes; the list comes from the worktree snapshot.
      if (cardId) changes.current = await window.gearmod.invoke('worktrees:snapshot', { cardId }).then((snapshot) => snapshot.exists ? parseChanges(snapshot) : [], () => [])
      const opened = await open(target.path)
      if (!alive || !opened) return
      setDocuments((all) => all.filter((item) => item.path === opened)); setActive(opened)
      setJump(target.line ? { line: target.line, column: target.column ?? 1 } : undefined)
    })()
    return () => { alive = false }
  }, [effective.at, effective.path, cardId])
  const dirty = Boolean(current && current.content !== current.saved)
  useEffect(() => { setDirty(dirty); return () => setDirty(false) }, [dirty])
  const repoName = current ? tabLabels([current.path], roots)[current.path]?.repo ?? undefined : undefined
  const currentRoot = current ? [...roots].sort((a, b) => b.path.length - a.path.length).find((root) => slashed(current.path).startsWith(`${slashed(root.path).replace(/\/$/, '')}/`)) : undefined
  const leave = (): void => { if (dirty) setLeaving(true); else close() }
  const target = requestedTarget(effective.path)
  useEffect(() => { if (current) pushRecent(projectId, current.path) }, [current?.path])
  const keyDown = (event: React.KeyboardEvent): void => {
    const id = shortcutFor(event.nativeEvent)
    const mode: QuickMode | null = id === 'quickOpenFile' ? 'files' : id === 'searchSymbols' ? 'symbols' : null
    if (mode) { event.preventDefault(); event.stopPropagation(); setQuick(mode) }
  }
  return <aside className="fview" style={style} aria-label={t.files.editor.focused.label} onKeyDown={keyDown}>{dialog}
    {quick && <QuickOpen key={quick} context={context} roots={roots} recents={readRecents(projectId)} initialMode={quick} open={openAt} close={() => setQuick(null)} />}
    {current
      ? <FilePane doc={current} mode="focused" context={context} preferences={preferences} changePreferences={changePreferences} change={findChange(changes.current, current.path)} root={currentRoot} commentCardId={cardId} commentTarget={cardId ? t.files.editor.focused.commentCard : t.files.editor.focused.commentChat} update={update} save={save} reload={(path) => void reload(path)} afterComment={() => undefined} error={error} loading={loading} setError={setError} jump={jump} onJumped={() => setJump(undefined)} repoName={repoName} roots={roots} openAt={openAt}
        headerEnd={<><button type="button" className="wf-iconchip tip" data-tip={t.files.editor.focused.openInFiles} aria-label={t.files.editor.focused.openInFiles} onClick={() => window.dispatchEvent(new CustomEvent('gearmod:open-file', { detail: { projectId, cardId, path: current.path } }))}><ExternalIcon /></button><button type="button" className="x" aria-label={t.files.editor.focused.closeFile} onClick={leave}><CloseIcon /></button></>} />
      : <><div className="fv-head"><div className="fv-path" data-tip={target.path}><span className="fv-name">{nameOf(target.path)}</span></div><button type="button" className="x" aria-label={t.files.editor.focused.closeFile} onClick={close}><CloseIcon /></button></div>
        <div className="fv-body">{loading && <p className="fv-note"><span className="spin sm" /> {t.files.editor.focused.opening}</p>}{error && <p className="fv-note err">{error}</p>}</div></>}
    {leaving && current && <ConfirmDialog eyebrow={t.files.editor.focused.discardEyebrow} title={t.files.workspace.discardTitle} text={t.files.editor.focused.discardText(nameOf(current.path))} ok={t.files.editor.focused.discardOk} danger cancel={() => setLeaving(false)} confirm={() => { setLeaving(false); close() }} />}
  </aside>
}
