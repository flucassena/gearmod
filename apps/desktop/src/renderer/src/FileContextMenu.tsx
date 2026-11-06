import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isShortcut } from './shortcuts'
import { createPortal } from 'react-dom'
import { useEscape } from './useEscape'
import { useT } from './i18n'
export interface FileMenuItem { label: string; icon?: React.ReactNode; action?(): void; children?: FileMenuItem[]; separator?: boolean; shortcut?: string; disabled?: boolean }
export function FileContextMenu({ x, y, items, close, find, label }: { x: number; y: number; items: FileMenuItem[]; close(): void; find?(): void; label?: string }): React.JSX.Element {
  const t = useT(), root = useRef<HTMLDivElement>(null), sub = useRef<HTMLDivElement>(null), rows = useRef<Array<HTMLButtonElement | null>>([]), [position, setPosition] = useState({ left: x, top: y }), [opened, setOpened] = useState<number | null>(null), [subposition, setSubposition] = useState({ left: x, top: y }), [index, setIndex] = useState(0), [subindex, setSubindex] = useState(0), [inSub, setInSub] = useState(false)
  useLayoutEffect(() => { const box = root.current?.getBoundingClientRect(); if (!box) return; setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)), top: Math.max(40, Math.min(y, window.innerHeight - box.height - 8)) }); root.current?.focus() }, [x, y])
  useLayoutEffect(() => {
    if (opened === null) return
    const box = rows.current[opened]?.getBoundingClientRect(), child = sub.current?.getBoundingClientRect()
    if (box && child) setSubposition({ left: box.right + child.width + 8 < window.innerWidth ? box.right : Math.max(8, box.left - child.width), top: Math.max(40, Math.min(box.top, window.innerHeight - child.height - 8)) })
  }, [opened, position])
  const run = (item: FileMenuItem): void => { if (!item.disabled && item.action) { close(); item.action() } }
  useEscape(close)
  useEffect(() => {
    const away = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node) && !sub.current?.contains(event.target as Node)) close() }
    const key = (event: KeyboardEvent): void => {
      if (isShortcut(event, 'find') && find) { event.preventDefault(); event.stopPropagation(); close(); find(); return }
      if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter', ' '].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const list = inSub && opened !== null ? items[opened]!.children ?? [] : items
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { const move = event.key === 'ArrowDown' ? 1 : -1; if (inSub) setSubindex((value) => (value + move + list.length) % list.length); else { setIndex((value) => (value + move + list.length) % list.length); setOpened(null) } }
      else if (event.key === 'ArrowLeft') { setInSub(false); setOpened(null) }
      else if (items[index]?.children && !inSub) { setOpened(index); setInSub(true); setSubindex(0) }
      else if (event.key === 'Enter' || event.key === ' ') run(list[inSub ? subindex : index]!)
    }
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', key, true); window.addEventListener('resize', close)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', close) }
  })
  return createPortal(<>
    <div ref={root} className="ctxmenu filectx" role="menu" aria-label={label ?? t.files.contextMenu.label} tabIndex={-1} style={position} onContextMenu={(event) => event.preventDefault()}>
      {items.map((item, i) => <React.Fragment key={item.label}>{item.separator && <div className="ctxsep" />}<button ref={(node) => { rows.current[i] = node }} type="button" role="menuitem" className={`ctxitem ${index === i ? 'on' : ''}`} disabled={item.disabled} aria-haspopup={item.children ? 'menu' : undefined} aria-expanded={item.children ? opened === i : undefined} onMouseEnter={() => { setIndex(i); setOpened(item.children ? i : null); setInSub(false) }} onClick={() => { if (item.children) { setOpened(opened === i ? null : i); setInSub(true) } else run(item) }}>{item.icon && <span className="ctxitem-icon">{item.icon}</span>}<span>{item.label}</span>{item.children ? <span className="ctxarrow" aria-hidden="true">›</span> : item.shortcut && <kbd>{item.shortcut}</kbd>}</button></React.Fragment>)}
    </div>
    {opened !== null && items[opened]?.children && <div ref={sub} className="ctxmenu filectx" role="menu" aria-label={items[opened]!.label} style={subposition}>{items[opened]!.children!.map((item, i) => <button key={item.label} type="button" role="menuitem" className={`ctxitem ${inSub && subindex === i ? 'on' : ''}`} disabled={item.disabled} onMouseEnter={() => { setInSub(true); setSubindex(i) }} onClick={() => run(item)}>{item.label}</button>)}</div>}
  </>, document.body)
}
