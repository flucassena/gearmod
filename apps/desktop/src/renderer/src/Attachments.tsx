import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon, PlusIcon } from './icons'
import { toast } from './toasts'
import { plainError } from './NoticeDialog'
import { tr, useT } from './i18n'
import { notifyCardAttachments } from './cardAttachmentsLogic'

const fileName = (path: string): string => path.split(/[\\/]/).pop() || path
type ContextTarget = { projectId: string; cardId: string | null }
const contextKey = (target: ContextTarget): string => `${target.projectId}:${target.cardId}`
const contextQueue = new Map<string, string[]>(), contextListeners = new Map<string, Set<() => void>>()
export function hasAttachmentTarget(target: ContextTarget): boolean { return Boolean(contextListeners.get(contextKey(target))?.size) }
export function queueContextFile(target: ContextTarget & { path: string }): void {
  const key = contextKey(target); contextQueue.set(key, [...new Set([...(contextQueue.get(key) ?? []), target.path])]); contextListeners.get(key)?.forEach((listener) => listener())
}

const textQueue = new Map<string, string[]>(), textListeners = new Map<string, Set<() => void>>()
/** Comment on an editor excerpt: becomes a draft in the chat message field, without sending anything. */
export function queueContextText(target: ContextTarget & { text: string }): void {
  const key = contextKey(target); textQueue.set(key, [...(textQueue.get(key) ?? []), target.text]); textListeners.get(key)?.forEach((listener) => listener())
}
export function hasCommentTarget(target: ContextTarget): boolean { return Boolean(textListeners.get(contextKey(target))?.size) }
/** Receives the comments sent by the file editor to this chat. */
export function useContextText(target: ContextTarget, receive: (text: string) => void): void {
  const latest = useRef(receive); latest.current = receive
  useEffect(() => {
    const key = contextKey(target), take = (): void => { const texts = textQueue.get(key); if (texts) { textQueue.delete(key); texts.forEach((text) => latest.current(text)) } }
    const listeners = textListeners.get(key) ?? new Set(); listeners.add(take); textListeners.set(key, listeners); take()
    return () => { listeners.delete(take) }
  }, [target.projectId, target.cardId])
}

/**
 * Attachments for the chat's next message: pick with the "+", drag or paste (Ctrl+V) into the field. They are kept until the message leaves
 * (including when it waits in the queue) and the agent receives the paths to read as context.
 */
export function useAttachments(target?: ContextTarget): { files: string[]; add(paths: string[]): void; remove(path: string): void; take(): string[]; choose(): Promise<void>; dropProps: React.HTMLAttributes<HTMLElement>; dragging: boolean } {
  const [files, setFiles] = useState<string[]>([]), [dragging, setDragging] = useState(false), ref = useRef<string[]>([])
  const update = (next: string[]): void => { ref.current = next; setFiles(next) }
  const add = useCallback((paths: string[]) => update([...new Set([...ref.current, ...paths.filter(Boolean)])].slice(0, 20)), [])
  useEffect(() => {
    if (!target) return
    const key = contextKey(target), receive = (): void => { const paths = contextQueue.get(key); if (paths) { contextQueue.delete(key); add(paths) } }
    const listeners = contextListeners.get(key) ?? new Set(); listeners.add(receive); contextListeners.set(key, listeners); receive()
    return () => { listeners.delete(receive) }
  }, [target?.projectId, target?.cardId, add])
  const remove = (path: string): void => update(ref.current.filter((item) => item !== path))
  // A message with attachments left: the main process copies them into the card's folder in the background, so the folder reloads a bit later.
  const take = (): string[] => {
    const taken = ref.current; update([])
    if (taken.length && target?.cardId) { const cardId = target.cardId; for (const delay of [600, 3000, 12000]) window.setTimeout(() => notifyCardAttachments(cardId), delay) }
    return taken
  }
  const choose = async (): Promise<void> => { try { add(await window.gearmod.invoke('files:choose', undefined)) } catch (reason) { toast.error(tr().chat.attachments.attachFailed, plainError(reason)) } }
  // Ctrl+V: files copied in Explorer go in by path; pasted images (screenshots) are saved in the app's attachments folder.
  const paste = async (files: File[]): Promise<void> => {
    const paths: string[] = []
    for (const file of files) {
      let path = ''
      try { path = window.gearmod.getDroppedFilePath(file) } catch { /* no path */ }
      if (!path) {
        try {
          const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file) })
          path = await window.gearmod.invoke('files:save-pasted', { name: file.name || `colado.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, base64 })
        } catch { /* file too large or unreadable */ }
      }
      if (path) paths.push(path)
    }
    add(paths)
  }
  const dropProps: React.HTMLAttributes<HTMLElement> = {
    onPaste: (event) => { const pasted = Array.from(event.clipboardData.files); if (!pasted.length) return; event.preventDefault(); void paste(pasted) },
    onDragOver: (event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true) } },
    onDragLeave: () => setDragging(false),
    onDrop: (event) => {
      if (!event.dataTransfer.files.length) return
      event.preventDefault(); setDragging(false)
      add(Array.from(event.dataTransfer.files).map((file) => window.gearmod.getDroppedFilePath(file)))
    }
  }
  return { files, add, remove, take, choose, dropProps, dragging }
}

export function AttachButton({ onClick, disabled }: { onClick(): void; disabled?: boolean }): React.JSX.Element {
  const t = useT().chat.attachments
  return <button type="button" className="attachbtn tip" data-tip={t.attachTip} aria-label={t.attach} disabled={disabled} onClick={onClick}><PlusIcon /></button>
}

const extLabel = (path: string): string => (path.split('.').pop() || tr().chat.attachments.fileExt).slice(0, 5).toUpperCase()

function AttachmentCard({ path, remove }: { path: string; remove?(path: string): void }): React.JSX.Element {
  const t = useT().chat.attachments
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    window.gearmod.invoke('files:preview', { path }).then((url) => { if (alive) setSrc(url) }).catch(() => undefined)
    return () => { alive = false }
  }, [path])
  const [zoom, setZoom] = useState(false)
  // Image: opens a preview over the chat. Any other file: opens in the system's app (the app only allows documents and images).
  const open = (): void => {
    if (src) { setZoom(true); return }
    window.gearmod.invoke('files:open', { path }).catch((reason) => toast.error(t.openFailed, plainError(reason)))
  }
  return <div className={`attcard tip ${src ? 'image' : 'file'}`} data-tip={path}>
    <button type="button" className="attcard-open" aria-label={t.open(fileName(path))} onClick={open}>
      {src ? <img src={src} alt={fileName(path)} /> : <><span className="attcard-name">{fileName(path)}</span><span className="attcard-ext">{extLabel(path)}</span></>}
    </button>
    {remove && <button type="button" className="attcard-x" aria-label={t.remove(fileName(path))} onClick={() => remove(path)}>×</button>}
    {zoom && src && <ImagePreview src={src} name={fileName(path)} onClose={() => setZoom(false)} />}
  </div>
}

/** Preview of an attached image over the whole window: closes with Esc, a click outside the image or the × button. */
export function ImagePreview({ src, name, onClose }: { src: string; name: string; onClose(): void }): React.JSX.Element {
  const t = useT().chat.attachments
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(<div className="imgpreview" role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
    {/* The close button sits on the image's own corner, away from the window's close button. */}
    <div className="imgpreview-frame" onClick={(event) => event.stopPropagation()}>
      <img src={src} alt={name} />
      <button type="button" className="imgpreview-x" data-tip={t.close} aria-label={t.close} onClick={onClose}><CloseIcon /></button>
    </div>
    <span className="imgpreview-name">{name}</span>
  </div>, document.body)
}

export function AttachmentChips({ files, remove }: { files: string[]; remove?(path: string): void }): React.JSX.Element | null {
  const t = useT().chat.attachments
  if (!files.length) return null
  return <div className="attachments" aria-label={t.attachedFiles}>{files.map((path) => <AttachmentCard key={path} path={path} remove={remove} />)}</div>
}

const noteMarker = 'Arquivos anexados (leia antes de responder; são contexto deste pedido):'

/**
 * Splits the message that went to the agent from the block of paths the app appends (orchestrator.attachmentNote):
 * the chat shows only what the user wrote, with the attachments as thumbnails on top.
 */
export function splitAttachmentNote(body: string): { text: string; files: string[] } {
  const at = body.indexOf(noteMarker)
  if (at < 0) return { text: body, files: [] }
  const files = body.slice(at + noteMarker.length).split('\n').map((line) => /^-\s+(.+)$/.exec(line.trim())?.[1]).filter((path): path is string => Boolean(path))
  return files.length ? { text: body.slice(0, at).trim(), files } : { text: body, files: [] }
}
