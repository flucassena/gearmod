import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Card } from '@gearmod/contracts'
import { BranchIcon, ChatIcon, EyeIcon, TrashIcon } from './icons'
import { useEscape } from './useEscape'
import { useT } from './i18n'

interface Item { key: string; label: string; hint: string; icon: React.ReactNode; danger?: boolean; run(): void }

/** Right-click menu on the card: open, go to chat/Git and delete, with letter shortcuts. */
export function CardContextMenu({ x, y, card, open, chat, git, remove, close }: { x: number; y: number; card: Card; open(): void; chat(): void; git(): void; remove(): void; close(): void }): React.JSX.Element {
  const t = useT().board
  const root = useRef<HTMLDivElement>(null), [pos, setPos] = useState({ left: x, top: y }), [active, setActive] = useState(0)
  const items: Item[] = [
    { key: 'a', label: t.contextMenu.openCard, hint: 'A', icon: <EyeIcon />, run: open },
    { key: 'c', label: t.contextMenu.goToChat, hint: 'C', icon: <ChatIcon />, run: chat },
    { key: 'g', label: t.contextMenu.openGit, hint: 'G', icon: <BranchIcon />, run: git },
    { key: 'e', label: t.contextMenu.deleteCard, hint: 'E', icon: <TrashIcon />, danger: true, run: remove }
  ]
  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect(); if (!box) return
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) })
  }, [x, y])
  useEscape(close)
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => (value + 1) % items.length); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => (value + items.length - 1) % items.length); return }
      if (event.key === 'Enter') { event.preventDefault(); items[active]!.run(); return }
      const hit = items.find((item) => item.key === event.key.toLowerCase()); if (hit && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); hit.run() }
    }
    const away = (event: MouseEvent): void => { if (!root.current?.contains(event.target as Node)) close() }
    document.addEventListener('keydown', key, true); document.addEventListener('mousedown', away); window.addEventListener('resize', close)
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', away); window.removeEventListener('resize', close) }
  })
  return <div className="ctxmenu" ref={root} role="menu" aria-label={t.contextMenu.cardActions(card.title || t.newCard)} style={pos} onContextMenu={(event) => event.preventDefault()}>
    <div className="ctxtitle">{card.title || t.newCard}</div>
    {items.map((item, index) => <React.Fragment key={item.key}>
      {item.danger && <div className="ctxsep" />}
      <button type="button" role="menuitem" className={`ctxitem ${item.danger ? 'danger' : ''} ${index === active ? 'on' : ''}`} onMouseEnter={() => setActive(index)} onClick={item.run}>{item.icon}<span>{item.label}</span><kbd>{item.hint}</kbd></button>
    </React.Fragment>)}
  </div>
}
