import React, { useEffect, useRef, useState } from 'react'
import { shortcutLabel } from './shortcuts'
import { DbContextMenu } from './DbContextMenu'
import { useT } from './i18n'

const autoOptions = (off: string): Array<[number, string]> => [[0, off], [5, '5 s'], [10, '10 s'], [30, '30 s'], [60, '1 min'], [300, '5 min']]

/** Icon button for the database grids' toolbar (table and SQL result). */
export function TbBtn({ label, keys, onClick, disabled, tone, on, children }: { label: string; keys?: string; onClick(): void; disabled?: boolean; tone?: 'danger' | 'ok'; on?: boolean; children: React.ReactNode }): React.JSX.Element {
  return <button type="button" className={`db-tb${tone ? ` ${tone}` : ''}${on ? ' on' : ''}`} data-tip={keys ? `${label} (${keys})` : label} aria-label={label} disabled={disabled} onClick={onClick}><svg className="ico" viewBox="0 0 16 16" aria-hidden="true">{children}</svg></button>
}

/** Reload (Ctrl+F5 by default), auto refresh (always off on open) and cancel (Ctrl+F2 by default): the same in the table and in the SQL result. */
export function RefreshTools({ busy, reload, cancel, autoBlocked }: { busy: boolean; reload(quiet: boolean): void; cancel(): void; autoBlocked?: string }): React.JSX.Element {
  const t = useT()
  const [autoSec, setAutoSec] = useState(0), [menu, setMenu] = useState<{ x: number; y: number }>()
  const live = useRef({ busy, reload }); live.current = { busy, reload }
  useEffect(() => {
    if (!autoSec || autoBlocked) return
    const timer = window.setInterval(() => { if (!live.current.busy) live.current.reload(true) }, autoSec * 1000)
    return () => window.clearInterval(timer)
  }, [autoSec, autoBlocked])
  const options = autoOptions(t.database.tools.autoOff), label = options.find(([value]) => value === autoSec)?.[1]
  return <>
    <TbBtn label={t.database.tools.reloadPage} keys={shortcutLabel('dbReload')} disabled={busy} onClick={() => reload(false)}><path d="M13 8a5 5 0 1 1-1.600-3.700M13 2.500V5h-2.500" /></TbBtn>
    <TbBtn label={autoBlocked ?? (autoSec ? t.database.tools.autoRefreshWith(label ?? '') : t.database.tools.autoRefresh)} on={autoSec > 0 && !autoBlocked} disabled={Boolean(autoBlocked)} onClick={() => { const box = (document.activeElement as HTMLElement).getBoundingClientRect(); setMenu({ x: box.left, y: box.bottom + 4 }) }}><circle cx="8" cy="8" r="5.500" /><path d="M8 5v3.200l2 1.300" /></TbBtn>
    {autoSec > 0 && !autoBlocked && <span className="db-tb-tag">{label}</span>}
    <TbBtn label={t.database.tools.cancelRun} keys={shortcutLabel('dbCancel')} tone="danger" disabled={!busy} onClick={cancel}><rect x="4" y="4" width="8" height="8" rx="1.500" fill="currentColor" /></TbBtn>
    {menu && <DbContextMenu x={menu.x} y={menu.y} title={t.database.tools.autoRefresh} items={options.map(([value, text]) => ({ label: `${value === autoSec ? '✓' : '  '} ${text}`, run: () => { setAutoSec(value); setMenu(undefined) } }))} close={() => setMenu(undefined)} />}
  </>
}
