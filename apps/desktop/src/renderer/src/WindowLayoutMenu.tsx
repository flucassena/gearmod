import React, { useEffect, useRef, useState } from 'react'
import { useFitInView } from './useFitInView'
import { useEscape } from './useEscape'
import { useT } from './i18n'
import { WindowIcon } from './icons'

export type LayoutPosition = 'left' | 'right' | 'top' | 'bottom'
export { WindowIcon }
/** Same design and same options for positioning panels and windows. Maximize and restore are left to the system button. */
export function WindowLayoutMenu({ move, detach, detachDisabled = false, closeWindow, className = '' }: { move(position: LayoutPosition): void; detach?(): void; detachDisabled?: boolean; closeWindow?(): void; className?: string }): React.JSX.Element {
  const t = useT(), labels: Record<LayoutPosition, string> = { left: t.shell.windowLayout.left, right: t.shell.windowLayout.right, top: t.shell.windowLayout.top, bottom: t.shell.windowLayout.bottom }
  const [open, setOpen] = useState(false), box = useRef<HTMLSpanElement>(null), menu = useRef<HTMLDivElement>(null)
  useFitInView(menu, open)
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent): void => { if (!box.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  useEscape(() => setOpen(false), open)
  const run = (action: () => void): void => { setOpen(false); action() }
  return <span className={`popwrap windowlayout ${className}`} ref={box}>
    <button type="button" className="ibtn tip" data-tip={t.shell.windowLayout.moveTip} aria-label={t.shell.windowLayout.windows} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><WindowIcon /></button>
    {open && <div className="popmenu" ref={menu} role="menu" aria-label={t.shell.windowLayout.menuLabel}>
      <div className="pm-label">{t.shell.windowLayout.move}</div><div className="pm-row">{(Object.keys(labels) as LayoutPosition[]).map((position) => <button type="button" role="menuitem" key={position} className="pm-ic tip" data-tip={labels[position]} aria-label={labels[position]} onClick={() => run(() => move(position))}><svg className="ico" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2.5" /><rect x={position === 'right' ? 11 : 3} y={position === 'bottom' ? 11 : 4} width={position === 'left' || position === 'right' ? 6 : 14} height={position === 'top' || position === 'bottom' ? 5 : 12} rx="1.5" fill="currentColor" /></svg></button>)}</div>
      {(detach || closeWindow) && <div className="pm-sep" />}
      {detach && <button type="button" role="menuitem" className="pm-item pm-ico" disabled={detachDisabled} onClick={() => run(detach)}><WindowIcon />{t.shell.windowLayout.openInNewWindow}</button>}
      {closeWindow && <button type="button" role="menuitem" className="pm-item" onClick={() => run(closeWindow)}>{t.shell.windowLayout.closeThisWindow}</button>}
    </div>}
  </span>
}
