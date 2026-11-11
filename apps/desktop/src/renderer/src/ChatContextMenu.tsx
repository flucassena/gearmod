import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Chat } from '@gearmod/contracts'
import { CardIcon, TrashIcon } from './icons'
import { useEscape } from './useEscape'
import { useT } from './i18n'

/** Chats linked to the card are part of its history and cannot be deleted individually. */
export function ChatContextMenu({ x, y, chat, cardTitle, openCard, remove, close }: { x: number; y: number; chat: Chat; cardTitle?: string; openCard?(): void; remove(): void; close(): void }): React.JSX.Element {
  const t = useT(), m = t.chat.contextMenu
  const root = useRef<HTMLDivElement>(null), [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect(); if (!box) return
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) })
    root.current?.focus()
  }, [x, y])
  useEscape(close)
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (chat.cardId && openCard && (event.key === 'Enter' || event.key.toLowerCase() === 'c')) { event.preventDefault(); openCard() }
      else if (!chat.cardId && (event.key === 'Enter' || event.key.toLowerCase() === 'a')) { event.preventDefault(); remove() }
    }
    const away = (event: MouseEvent): void => { if (!root.current?.contains(event.target as Node)) close() }
    document.addEventListener('keydown', key, true); document.addEventListener('mousedown', away); window.addEventListener('resize', close)
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', away); window.removeEventListener('resize', close) }
  }, [close, remove, openCard, chat.cardId])
  return <div className="ctxmenu" ref={root} role="menu" tabIndex={-1} aria-label={m.actionsFor(cardTitle || chat.title || m.freeConversation)} style={pos} onContextMenu={(event) => event.preventDefault()}>
    <div className="ctxtitle">{cardTitle || chat.title || (chat.purpose === 'constitution' ? m.projectConstitution : m.freeConversation)}</div>
    {chat.cardId && openCard && <button type="button" role="menuitem" className="ctxitem on" onClick={openCard}><CardIcon /><span>{m.openCard}</span><kbd>C</kbd></button>}
    <button type="button" role="menuitem" className={`ctxitem danger ${chat.cardId ? '' : 'on'}`} disabled={Boolean(chat.cardId)} data-tip={chat.cardId ? m.cardChatsTip : undefined} onClick={remove}><TrashIcon /><span>{m.deleteChat}</span>{!chat.cardId && <kbd>A</kbd>}</button>
    {chat.cardId && <p className="chat-menu-note">{m.cardChatNote}</p>}
  </div>
}
