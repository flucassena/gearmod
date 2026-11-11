import React, { useCallback, useRef, useState } from 'react'
import { useAsk } from './useAsk'
import { useT } from './i18n'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'

const viewerMin = 320
const stored = (): number => { try { return Number(localStorage.getItem('gearmod.viewerWidth')) || 520 } catch { return 520 } }
const viewerState = { width: stored() }
const clampViewer = (value: number, chatWidth: number): number => Math.max(viewerMin, Math.min(window.innerWidth - chatWidth - 260, value))

/**
 * File panel beside the chat: opens what the agent cited (path or link) without leaving the conversation. Here lives only the open request
 * and the width; the file itself is the `FocusedFile`. The middle divider redistributes the space between the chat and the file; `chatWidth` is the
 * chat's current width, which the divider also adjusts.
 */
export function useFileViewer(chatWidth: number, setChatWidth: (value: number) => void): {
  request: { path: string; at: number } | null; requested: string | null; dialog: React.ReactNode; open(path: string): void; close(): void; setDirty(value: boolean): void
  width: number; dragging: boolean; startResize(event: React.PointerEvent<HTMLDivElement>): void; startSplit(event: React.PointerEvent<HTMLDivElement>): void; expand(): void; restore(): void
} {
  const [request, setRequest] = useState<{ path: string; at: number } | null>(null), dirty = useRef(false)
  const { ask, dialog } = useAsk(), t = useT()
  const [width, setWidthState] = useState(() => viewerState.width), [dragging, setDragging] = useState(false)
  const open = useCallback(async (path: string) => {
    if (dirty.current && !(await ask({ eyebrow: t.files.viewer.openFile, title: t.files.workspace.discardTitle, text: t.files.viewer.discardText, ok: t.files.workspace.discard, danger: true }))) return
    setRequest({ path, at: Date.now() })
  }, [ask, t])
  const close = useCallback(() => setRequest(null), [])
  const setDirty = useCallback((value: boolean) => { dirty.current = value }, [])
  const drag = (apply: (x: number) => void, finish?: () => void) => (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault(); setDragging(true)
    const move = (e: PointerEvent): void => apply(e.clientX)
    const up = (): void => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); setDragging(false); finish?.() }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
  }
  const remember = (): void => { try { localStorage.setItem('gearmod.viewerWidth', String(viewerState.width)) } catch { /* only valid for this session */ } }
  // Outer edge: changes only the file's width. Middle divider: trades space between the chat and the file, keeping the total.
  const startResize = drag((x) => { const next = clampViewer(window.innerWidth - x - chatWidth, chatWidth); viewerState.width = next; setWidthState(next) }, remember)
  const startSplit = drag((x) => {
    const total = viewerState.width + chatWidth, nextChat = Math.max(440, Math.min(total - viewerMin, window.innerWidth - x))
    setChatWidth(nextChat); viewerState.width = total - nextChat; setWidthState(total - nextChat)
  }, remember)
  const place = (value: number): void => { const next = clampViewer(value, chatWidth); viewerState.width = next; setWidthState(next); remember() }
  const expand = (): void => { setChatWidth(440); place(window.innerWidth - 440 - 260) }
  const restore = (): void => place(520)
  return { request, requested: request?.path ?? null, dialog, open, close, setDirty, width, dragging, startResize, startSplit, expand, restore }
}

/** Divider between the chat and the side panel (file or diff): wide handle to drag and expand/restore buttons. */
export function ViewGrip({ viewer }: { viewer: ReturnType<typeof useFileViewer> }): React.JSX.Element {
  const t = useT(), stop = (event: React.PointerEvent): void => event.stopPropagation()
  return <div className="viewgrip" role="separator" aria-orientation="vertical" aria-label={t.files.viewer.gripLabel} onPointerDown={viewer.startSplit} onDoubleClick={viewer.restore}>
    <span className="viewgrip-handle" aria-hidden="true" />
    <span className="viewgrip-btns" onPointerDown={stop}>
      <button type="button" className="tip" data-tip={t.files.viewer.expand} aria-label={t.files.viewer.expand} onClick={viewer.expand}><ChevronLeftIcon /></button>
      <button type="button" className="tip" data-tip={t.files.viewer.restoreWidth} aria-label={t.files.viewer.restoreWidth} onClick={viewer.restore}><ChevronRightIcon /></button>
    </span>
  </div>
}
