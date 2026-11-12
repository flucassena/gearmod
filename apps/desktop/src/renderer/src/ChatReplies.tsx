import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from './icons'
import { useFitInView } from './useFitInView'
import { splitChatReplies, type ChatReply } from './chatReplyContext'
import { useT } from './i18n'

export function useChatReplies(): { items: ChatReply[]; add(reply: ChatReply): void; remove(id: string): void; clear(): void; restore(prompt: string): string } {
  const [items, setItems] = useState<ChatReply[]>([])
  const add = useCallback((reply: ChatReply) => setItems((current) => [...current.filter((item) => item.id !== reply.id), reply]), [])
  const restore = (prompt: string): string => { const parsed = splitChatReplies(prompt); parsed.replies.forEach(add); return parsed.text }
  return { items, add, remove: (id) => setItems((current) => current.filter((item) => item.id !== id)), clear: () => setItems([]), restore }
}

/** `top`: opens below that point; `bottom`: opens above it (distance from the bottom of the window). */
type Anchor = { left: number; top?: number; bottom?: number }

function ReplyPopover({ anchor, close, children, label, dismissOnScroll = true }: { anchor: Anchor; close(): void; children: React.ReactNode; label: string; dismissOnScroll?: boolean }): React.JSX.Element {
  const t = useT(), box = useRef<HTMLDivElement>(null)
  useFitInView(box, true)
  useEffect(() => {
    const away = (event: PointerEvent): void => { if (!box.current?.contains(event.target as Node)) close() }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
    const scroll = (event: Event): void => { if (dismissOnScroll && (!(event.target instanceof Node) || !box.current?.contains(event.target))) close() }
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', escape, true); document.addEventListener('scroll', scroll, true); window.addEventListener('resize', close)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape, true); document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', close) }
  }, [close, dismissOnScroll])
  return createPortal(<div className="chat-reply-popover" ref={box} role="dialog" aria-label={label} style={{ left: anchor.left, top: anchor.top, bottom: anchor.bottom }}>
    <button type="button" className="chat-reply-close" aria-label={t.chat.replies.closeReply} onClick={close}><CloseIcon /></button>{children}
  </div>, document.body)
}

/** Selection stays in its own message; interacting with the floating panel never replaces the captured quote. */
export function ChatReplySelection({ log, add, scope }: { log: React.RefObject<HTMLDivElement | null>; add(reply: ChatReply): void; scope: string }): React.JSX.Element | null {
  const t = useT()
  const [selected, setSelected] = useState<{ quote: string; messageId?: string; anchor: Anchor }>(), [editing, setEditing] = useState(false), [response, setResponse] = useState('')
  const button = useRef<HTMLButtonElement>(null), field = useRef<HTMLTextAreaElement>(null)
  const close = useCallback(() => { setSelected(undefined); setEditing(false); setResponse('') }, [])
  useFitInView(button, Boolean(selected) && !editing)
  useEffect(close, [scope, close])
  useEffect(() => { if (editing) field.current?.focus() }, [editing])
  useEffect(() => {
    if (editing) return
    const read = (): void => {
      const selection = window.getSelection(), root = log.current
      if (!selection || selection.isCollapsed || !selection.rangeCount || !root) { setSelected(undefined); return }
      const range = selection.getRangeAt(0)
      const elementAt = (node: Node): Element | null => node instanceof Element ? node : node.parentElement
      const first = elementAt(range.startContainer), last = elementAt(range.endContainer)
      const message = first?.closest<HTMLElement>('.msg.agent,.msg.user')
      if (!message || !root.contains(message) || last?.closest('.msg.agent,.msg.user') !== message || first?.closest('button,textarea,input,[contenteditable="true"]') || last?.closest('button,textarea,input,[contenteditable="true"]')) { setSelected(undefined); return }
      const quote = selection.toString().trim(), rects = range.getClientRects(), rect = rects[rects.length - 1] ?? range.getBoundingClientRect(), bounds = root.getBoundingClientRect()
      if (!quote || rect.bottom < bounds.top || rect.top > bounds.bottom || !root.getClientRects().length) { setSelected(undefined); return }
      setSelected({ quote, messageId: message.dataset.mid, anchor: { left: rect.left, top: rect.bottom + 6 } })
    }
    const collapsed = (): void => { if (window.getSelection()?.isCollapsed) setSelected(undefined) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); else read() }
    const hide = (): void => setSelected(undefined)
    document.addEventListener('pointerup', read); document.addEventListener('keyup', escape); document.addEventListener('selectionchange', collapsed); document.addEventListener('scroll', hide, true); window.addEventListener('resize', hide); window.addEventListener('blur', hide)
    return () => { document.removeEventListener('pointerup', read); document.removeEventListener('keyup', escape); document.removeEventListener('selectionchange', collapsed); document.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); window.removeEventListener('blur', hide) }
  }, [log, editing, close])
  // The reply field grows with the text (up to its max-height, then it scrolls).
  useLayoutEffect(() => { const box = field.current; if (!box) return; box.style.height = 'auto'; box.style.height = `${box.scrollHeight + 2}px` }, [response, editing])
  if (!selected) return null
  const submit = (): void => {
    if (!response.trim()) return
    add({ id: crypto.randomUUID(), quote: selected.quote, response: response.trim(), ...(selected.messageId ? { messageId: selected.messageId } : {}) })
    window.getSelection()?.removeAllRanges(); close()
  }
  return editing ? <ReplyPopover anchor={selected.anchor} close={close} label={t.chat.replies.replyToSelection} dismissOnScroll={false}>
    <blockquote className="chat-reply-quote" data-tip={selected.quote}>{selected.quote}</blockquote>
    <textarea ref={field} rows={2} value={response} placeholder={t.chat.replies.placeholder} aria-label={t.chat.replies.yourReply} onChange={(event) => setResponse(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }} />
    <div className="chat-reply-actions"><small>{t.chat.replies.enterToAdd}</small><button type="button" disabled={!response.trim()} onClick={submit}>{t.chat.replies.addToChat}</button></div>
  </ReplyPopover> : createPortal(<button ref={button} type="button" className="chat-reply-trigger" style={{ left: selected.anchor.left, top: selected.anchor.top }} onPointerDown={(event) => event.preventDefault()} onClick={() => setEditing(true)}>{t.chat.replies.reply}</button>, document.body)
}

export function ReplyContextCards({ replies, remove }: { replies: ChatReply[]; remove?(id: string): void }): React.JSX.Element | null {
  const t = useT()
  const [opened, setOpened] = useState<{ reply: ChatReply; anchor: Anchor }>()
  const close = useCallback(() => setOpened(undefined), [])
  if (!replies.length) return null
  return <div className="chat-reply-cards" aria-label={t.chat.replies.addedAsContext}>
    {replies.map((reply) => <div className="chat-reply-card" key={reply.id}>
      <button type="button" className="chat-reply-card-body" aria-label={t.chat.replies.viewReply(reply.response.slice(0, 100))} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setOpened({ reply, anchor: { left: rect.left, bottom: window.innerHeight - rect.top + 6 } }) }}>
        <span className="chat-reply-card-preview">{reply.response}</span><span className="chat-reply-card-label">{t.chat.replies.cardLabel}</span>
      </button>
      {remove && <button type="button" className="attcard-x" aria-label={t.chat.replies.removeReply(reply.quote.slice(0, 80))} onClick={() => { setOpened(undefined); remove(reply.id) }}>×</button>}
    </div>)}
    {opened && replies.some((reply) => reply.id === opened.reply.id) && <ReplyPopover anchor={opened.anchor} close={close} label={t.chat.replies.addedOneAsContext}><blockquote className="chat-reply-fullquote">{opened.reply.quote}</blockquote><p className="chat-reply-fullresponse">{opened.reply.response}</p></ReplyPopover>}
  </div>
}
