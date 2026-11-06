import React, { useEffect, useMemo, useRef, useState } from 'react'
import { isShortcut } from './shortcuts'
import type { ChatMessage } from '@gearmod/contracts'
import { useFitInView } from './useFitInView'
import { useT } from './i18n'

/** Text as it appears on screen: without the Markdown formatting marks. */
export function visibleText(body: string): string {
  return body
    .replace(/```[^\n]*\n?/g, '').replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*>\s?/gm, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2').replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, '$1$2')
}

/** Excerpt of the message around the first occurrence, for the results list. */
export function snippet(body: string, query: string, radius = 48): string {
  const flat = visibleText(body).replace(/\s+/g, ' ').trim(), at = flat.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return flat.slice(0, radius * 2)
  const from = Math.max(0, at - radius), to = Math.min(flat.length, at + query.length + radius)
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`
}

/** Messages that contain the text (case-insensitive); tools are left out, what is searched is the conversation. */
export function searchMessages(messages: ChatMessage[], query: string): ChatMessage[] {
  const needle = query.trim().toLowerCase()
  if (needle.length < 2) return []
  return messages.filter((message) => message.role !== 'tool' && (message.body.toLowerCase().includes(needle) || visibleText(message.body).toLowerCase().includes(needle)))
}

/** The shortcut belongs to the focused chat; in fullscreen it also works when focus is on the window body. */
export function useChatSearchShortcut(expanded: boolean): { ref: React.RefObject<HTMLElement | null>; request: number } {
  const ref = useRef<HTMLElement>(null), [request, setRequest] = useState(0)
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !isShortcut(event, 'find') || document.querySelector('.overlay')) return
      const active = document.activeElement
      if (!ref.current || !(active && ref.current.contains(active)) && !(expanded && (active === document.body || active === document.documentElement))) return
      if (active instanceof HTMLElement && active.closest('.wf-document, .term-screen')) return
      event.preventDefault(); event.stopPropagation(); setRequest((value) => value + 1)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [expanded])
  return { ref, request }
}

/** Chat magnifier: searches what was said (me and the agent); clicking a result scrolls to the message and highlights it. */
export function ChatSearch({ messages, log, reveal, request = 0 }: { messages: ChatMessage[]; log: React.RefObject<HTMLDivElement | null>; reveal?(): void; request?: number }): React.JSX.Element {
  const t = useT(), roleLabel: Record<string, string> = t.chat.roles, [open, setOpen] = useState(false), [query, setQuery] = useState(''), box = useRef<HTMLSpanElement>(null), input = useRef<HTMLInputElement>(null), pop = useRef<HTMLDivElement>(null)
  useFitInView(pop, open)
  const results = useMemo(() => searchMessages(messages, query), [messages, query])
  useEffect(() => { if (!request || !box.current?.getClientRects().length) return; setOpen(true); window.setTimeout(() => { input.current?.focus(); input.current?.select() }, 0) }, [request])
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const away = (event: PointerEvent): void => { if (!box.current?.contains(event.target as Node)) setOpen(false) }
    const esc = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  const go = (id: string): void => {
    reveal?.(); setOpen(false)
    window.setTimeout(() => {
      const target = [...(log.current?.querySelectorAll<HTMLElement>('[data-mid]') ?? [])].find((el) => el.dataset.mid === id)
      if (!target) return
      target.scrollIntoView({ block: 'center', behavior: 'smooth' })
      target.classList.add('searchhit'); window.setTimeout(() => target.classList.remove('searchhit'), 1800)
    }, reveal ? 80 : 0)
  }
  return <span className="popwrap chatsearch" ref={box}>
    <button type="button" className="ibtn tip" data-tip={t.chat.search.tip} aria-label={t.chat.search.label} aria-expanded={open} onClick={() => setOpen(!open)}><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="M13.2 13.2L17 17" /></svg></button>
    {open && <div className="popmenu cs-pop" ref={pop} role="dialog" aria-label={t.chat.search.label}>
      <input ref={input} className="in" value={query} placeholder={t.chat.search.label} aria-label={t.chat.search.label} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) go(results[0].id) }} />
      <div className="cs-list">{query.trim().length < 2 ? <p className="ch-muted">{t.chat.search.minLetters}</p> : !results.length ? <p className="ch-muted">{t.chat.search.nothingFound}</p>
        : results.slice(0, 40).map((message) => <button type="button" key={message.id} className="cs-item" onClick={() => go(message.id)}><b>{roleLabel[message.role] ?? message.role}</b><span>{snippet(message.body, query.trim())}</span></button>)}</div>
      {results.length > 40 && <p className="ch-muted">{t.chat.search.moreResults(results.length - 40)}</p>}
    </div>}
  </span>
}
