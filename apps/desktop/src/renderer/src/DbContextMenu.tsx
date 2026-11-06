import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useEscape } from './useEscape'
import { useT } from './i18n'

export type DbMenuItem = { label: string; run(): void; danger?: boolean }

/** Context menu for database connections (right-click or ⋯ button). */
export function DbContextMenu({ x, y, title, items, close }: { x: number; y: number; title: string; items: DbMenuItem[]; close(): void }): React.JSX.Element {
  const t = useT()
  const root = useRef<HTMLDivElement>(null), [pos, setPos] = useState({ left: x, top: y }), [index, setIndex] = useState(0)
  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect(); if (!box) return
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) })
    root.current?.focus()
  }, [x, y])
  useEscape(close)
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((current) => (current + 1) % items.length) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((current) => (current - 1 + items.length) % items.length) }
      else if (event.key === 'Enter') { event.preventDefault(); items[index]?.run() }
    }
    const away = (event: MouseEvent): void => { if (!root.current?.contains(event.target as Node)) close() }
    document.addEventListener('keydown', key, true); document.addEventListener('mousedown', away); window.addEventListener('resize', close)
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', away); window.removeEventListener('resize', close) }
  }, [close, items, index])
  return <div className="ctxmenu" ref={root} role="menu" tabIndex={-1} aria-label={t.database.actionsOf(title)} style={pos} onContextMenu={(event) => event.preventDefault()}>
    <div className="ctxtitle">{title}</div>
    {items.map((item, i) => <button key={item.label} type="button" role="menuitem" className={`ctxitem${item.danger ? ' danger' : ''}${index === i ? ' on' : ''}`} onMouseEnter={() => setIndex(i)} onClick={item.run}><span>{item.label}</span></button>)}
  </div>
}
