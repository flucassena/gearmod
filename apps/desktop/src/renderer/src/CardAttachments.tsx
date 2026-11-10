import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { CardAttachment } from '@gearmod/contracts'
import { ConfirmDialog } from './ConfirmDialog'
import { Checkbox } from './Checkbox'
import { Loading } from './Loading'
import { FolderGlyph, ListIcon, PlusIcon, TrashIcon } from './icons'
import { FileTypeIcon, extensionOf } from './FileAppearance'
import { ImagePreview, hasAttachmentTarget, queueContextFile } from './Attachments'
import { formatSize, onCardAttachments, selectAll, selectionSummary, sortAttachments, toggleSelection } from './cardAttachmentsLogic'
import { plainError } from './NoticeDialog'
import { toast } from './toasts'
import { dateLocale, useT } from './i18n'

/** The card's attachments, reloaded when a message with files leaves the card chat. */
export function useCardAttachments(cardId: string | undefined): { items: CardAttachment[]; loading: boolean; reload(): Promise<void> } {
  const t = useT().chat.cardAttachments
  const [items, setItems] = useState<CardAttachment[]>([]), [loading, setLoading] = useState(Boolean(cardId))
  const reload = useCallback(async (): Promise<void> => {
    if (!cardId) { setItems([]); setLoading(false); return }
    try { setItems(sortAttachments(await window.gearmod.invoke('cards:attachments', { cardId }))) } catch (reason) { toast.error(t.loadFailed, plainError(reason)) } finally { setLoading(false) }
  }, [cardId, t.loadFailed])
  useEffect(() => { setLoading(Boolean(cardId)); void reload(); return cardId ? onCardAttachments(cardId, () => void reload()) : undefined }, [cardId, reload])
  return { items, loading, reload }
}

/** Tiny preview of an attachment in the documents list: the image itself, or the file extension. */
function MiniThumb({ item }: { item: CardAttachment }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (item.available && item.mediaType?.startsWith('image/')) window.gearmod.invoke('files:preview', { path: item.path }).then((url) => { if (alive) setSrc(url) }).catch(() => undefined)
    return () => { alive = false }
  }, [item.path, item.available, item.mediaType])
  return <span className="at-mini" title={item.fileName}>{src ? <img src={src} alt="" /> : <FileTypeIcon path={item.fileName} />}</span>
}

/** Item below the card's documents: one line (folder icon, name, count) and, with files, a row of tiny previews of the first ones. Opens the folder in the middle area. */
export function AttachmentsDocButton({ items, on, open }: { items: CardAttachment[]; on: boolean; open(): void }): React.JSX.Element {
  const t = useT().chat.cardAttachments, shown = items.slice(0, 5), extra = items.length - shown.length
  return <button type="button" className={`docbtn atdoc ${on ? 'on' : ''} ${items.length ? '' : 'empty'}`} aria-pressed={on} onClick={open}>
    <span className="atdoc-line"><FolderGlyph /><span className="dn">{t.count(items.length)}</span></span>
    {shown.length > 0 && <span className="atdoc-row">{shown.map((item) => <MiniThumb key={item.id} item={item} />)}{extra > 0 && <em>+{extra}</em>}</span>}
  </button>
}

const extOf = (name: string): string => (name.includes('.') ? name.split('.').pop()! : '').slice(0, 5).toUpperCase()

/** Text and code files open in the app's own file viewer; everything else goes to the system's default app. */
const viewable = new Set(['md', 'markdown', 'mdx', 'txt', 'text', 'json', 'jsonc', 'jsonl', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env', 'xml', 'csv', 'tsv', 'log', 'prompt', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'sh', 'ps1', 'sql', 'go', 'rs', 'java', 'cs', 'cpp', 'c', 'h', 'rb', 'php', 'lua'])
const isViewable = (name: string): boolean => viewable.has(extensionOf(name))

function Tile({ item, selected, toggle, remove, projectId, cardId, list, viewed }: { item: CardAttachment; selected: boolean; toggle(): void; remove(): void; projectId: string; cardId: string; list: boolean; viewed(): void }): React.JSX.Element {
  const t = useT().chat.cardAttachments
  const [src, setSrc] = useState<string | null>(null), [zoom, setZoom] = useState(false)
  useEffect(() => {
    let alive = true
    if (item.available && item.mediaType?.startsWith('image/')) window.gearmod.invoke('files:preview', { path: item.path }).then((url) => { if (alive) setSrc(url) }).catch(() => undefined)
    return () => { alive = false }
  }, [item.path, item.available, item.mediaType])
  const open = (): void => {
    if (!item.available) return
    if (src) { setZoom(true); return }
    if (isViewable(item.fileName)) { window.dispatchEvent(new CustomEvent('gearmod:open-file', { detail: { projectId, cardId, path: item.path } })); viewed(); return }
    window.gearmod.invoke('files:open', { path: item.path }).catch((reason) => toast.error(t.openFailed, plainError(reason)))
  }
  const target = { projectId, cardId }, canUse = item.available && hasAttachmentTarget(target)
  const sourceLabel = item.source === 'import' ? t.imported : item.source === 'chat' ? t.fromChat : t.manual
  return <li className={`cafile ${list ? 'row' : ''} ${selected ? 'on' : ''} ${item.available ? '' : 'gone'}`}>
    <span className="cafile-ck"><Checkbox checked={selected} onChange={toggle} label={t.select(item.fileName)} /></span>
    <button type="button" className="cafile-open" aria-label={t.open(item.fileName)} data-tip={item.available ? undefined : t.unavailableTip} onClick={open}>
      <span className="cafile-thumb">{src ? <img src={src} alt="" /> : <><FileTypeIcon path={item.fileName} />{!list && <span className="cafile-ext">{extOf(item.fileName)}</span>}</>}</span>
      <span className="cafile-name">{item.fileName}</span>
      <small className="cafile-meta">{item.available ? `${formatSize(item.sizeBytes)} · ${new Date(item.createdAt).toLocaleDateString(dateLocale())} · ${sourceLabel}` : t.unavailable}</small>
    </button>
    <div className="cafile-actions">
      <button type="button" className="mini secondary tip" disabled={!canUse} data-tip={canUse ? t.useInChatTip : t.useInChatOff} onClick={() => queueContextFile({ ...target, path: item.path })}>{t.useInChat}</button>
      <button type="button" className="trashbtn tip" data-tip={t.removeOne(item.fileName)} aria-label={t.removeOne(item.fileName)} onClick={remove}><TrashIcon /></button>
    </div>
    {zoom && src && <ImagePreview src={src} name={item.fileName} onClose={() => setZoom(false)} />}
  </li>
}

/** Middle area as a folder: the card's files with add (button, drag, Ctrl+V), multiple selection, removal and use in the chat. */
export function AttachmentsFolder({ projectId, cardId, data, viewed }: { projectId: string; cardId: string; data: ReturnType<typeof useCardAttachments>; viewed: () => void }): React.JSX.Element {
  const t = useT().chat.cardAttachments, { items, loading, reload } = data
  const [list, setListState] = useState(() => { try { return localStorage.getItem('gearmod.attachmentsView') === 'list' } catch { return false } })
  const setList = (value: boolean): void => { setListState(value); try { localStorage.setItem('gearmod.attachmentsView', value ? 'list' : 'grid') } catch { /* remembering the view is optional */ } }
  const [selected, setSelected] = useState<string[]>([]), [asking, setAsking] = useState<string[]>([]), [adding, setAdding] = useState(false), [dragging, setDragging] = useState(false)
  useEffect(() => { setSelected((current) => current.filter((id) => items.some((item) => item.id === id))) }, [items])

  const addPaths = async (paths: string[]): Promise<void> => {
    const clean = paths.filter(Boolean)
    if (!clean.length) return
    setAdding(true)
    try {
      for (let at = 0; at < clean.length; at += 20) {
        const result = await window.gearmod.invoke('cards:attachments-add', { cardId, paths: clean.slice(at, at + 20) })
        for (const failure of result.failed) toast.error(t.addFailed(failure.name), failure.reason)
      }
    } catch (reason) { toast.error(t.addFailed(''), plainError(reason)) } finally { setAdding(false); await reload() }
  }
  const addPasted = async (files: File[]): Promise<void> => {
    const withPath: string[] = []
    setAdding(true)
    try {
      for (const file of files) {
        let path = ''
        try { path = window.gearmod.getDroppedFilePath(file) } catch { /* no path: a pasted image */ }
        if (path) { withPath.push(path); continue }
        try {
          const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file) })
          await window.gearmod.invoke('cards:attachments-add-pasted', { cardId, name: file.name || `colado.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, base64 })
        } catch (reason) { toast.error(t.addFailed(file.name), plainError(reason)) }
      }
    } finally { setAdding(false) }
    await addPaths(withPath); await reload()
  }
  const choose = async (): Promise<void> => { try { await addPaths(await window.gearmod.invoke('files:choose', undefined)) } catch (reason) { toast.error(t.addFailed(''), plainError(reason)) } }

  // Ctrl+V anywhere in the editor while the folder is open (but never while typing in a field).
  const latest = useRef(addPasted); latest.current = addPasted
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length) { event.preventDefault(); void latest.current(files) }
    }
    document.addEventListener('paste', onPaste); return () => document.removeEventListener('paste', onPaste)
  }, [])

  const confirmRemove = async (): Promise<void> => {
    const ids = asking; setAsking([])
    try {
      const result = await window.gearmod.invoke('cards:attachments-remove', { cardId, ids })
      for (const failure of result.failed) toast.error(t.removeFailed, `${items.find((item) => item.id === failure.id)?.fileName ?? ''} ${failure.reason}`.trim())
      setSelected((current) => current.filter((id) => !result.removed.includes(id)))
    } catch (reason) { toast.error(t.removeFailed, plainError(reason)) } finally { await reload() }
  }
  const summary = selectionSummary(asking, items), chosen = selectionSummary(selected, items)
  const allSelected = items.length > 0 && items.every((item) => selected.includes(item.id))
  return <div className={`cafolder ${dragging ? 'dragging' : ''}`}
    onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true) } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
    onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); setDragging(false); void addPaths(Array.from(event.dataTransfer.files).map((file) => { try { return window.gearmod.getDroppedFilePath(file) } catch { return '' } })) }}>
    <div className="cafolder-head">
      <span className="sectitle">{t.folderTitle} · {items.length}</span>
      <div className="cafolder-tools">
        {items.length > 0 && <div className="viewtoggle sm" role="group" aria-label={t.viewLabel}>
          <button type="button" className={list ? '' : 'on'} aria-pressed={!list} data-tip={t.viewGrid} aria-label={t.viewGrid} onClick={() => setList(false)}><svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6.5" height="6.5" rx="1" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" /></svg></button>
          <button type="button" className={list ? 'on' : ''} aria-pressed={list} data-tip={t.viewList} aria-label={t.viewList} onClick={() => setList(true)}><ListIcon /></button>
        </div>}
        {items.length > 0 && <button type="button" className="mini secondary" onClick={() => setSelected(selectAll(selected, items))}>{allSelected ? t.clearSelection : t.selectAll}</button>}
        {chosen.count > 0 && <button type="button" className="mini secondary danger-text" onClick={() => setAsking(selected)}>{t.removeSelected(chosen.count)}</button>}
        {items.length > 0 && <button type="button" className="mini" disabled={adding} onClick={() => void choose()}><PlusIcon />{adding ? t.adding : t.add}</button>}
      </div>
    </div>
    {loading ? <Loading /> : items.length === 0 ? <div className="cafolder-empty"><b>{t.empty}</b><span>{t.emptyDrop}</span><button type="button" className="mini" disabled={adding} onClick={() => void choose()}><PlusIcon />{adding ? t.adding : t.add}</button></div>
      : <ul className={list ? 'calist' : 'cagrid'}>{items.map((item) => <Tile key={item.id} list={list} viewed={viewed} item={item} projectId={projectId} cardId={cardId} selected={selected.includes(item.id)} toggle={() => setSelected(toggleSelection(selected, item.id))} remove={() => setAsking([item.id])} />)}</ul>}
    {dragging && <div className="cafolder-drop">{t.dropHere}</div>}
    {asking.length > 0 && <ConfirmDialog eyebrow={t.confirmEyebrow} title={t.confirmTitle(summary.count)} text={t.confirmText(summary.count, formatSize(summary.bytes))} ok={t.confirmOk} danger cancel={() => setAsking([])} confirm={() => void confirmRemove()} />}
  </div>
}
