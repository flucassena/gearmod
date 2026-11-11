import React, { useEffect, useRef, useState } from 'react'
import { useT } from './i18n'
import { activate, closeTab, dirtyTabs, nextSqlNumber, moveTab, openTab, placeTab, resize, sqlTab, type DropZone, type WsNode, type WsPane, type WsSplit, type WsTab } from './DbLayout'
import { CodeIcon } from './icons'

type Props = { layout: WsNode; change(next: (layout: WsNode) => WsNode): void; focus: string; setFocus(id: string): void; renderTab(tab: WsTab): React.ReactNode; sqlConnection?: string; tabNote?(tab: WsTab): string | undefined; confirmClose?(tab: WsTab): Promise<boolean>; tabState?(tab: WsTab): string | undefined }

/** Window area: drag a tab to a panel's edge to split the screen, or to the center to merge it. */
export function DbWorkspace({ layout, change, focus, setFocus, renderTab, sqlConnection, tabNote, tabState, confirmClose }: Props): React.JSX.Element {
  const [drag, setDrag] = useState<string>()
  // Table tabs only load (and connect to the database) after being opened; the one that was already open on entry waits for the click.
  const [visited, setVisited] = useState<Set<string>>(() => new Set()), ready = useRef(false)
  useEffect(() => { ready.current = true }, [])
  const visit = (id: string): void => setVisited((current) => current.has(id) ? current : new Set(current).add(id))
  const addSql = (paneId: string): void => { const tab = sqlTab(nextSqlNumber(layout), sqlConnection); change((current) => openTab(current, tab, paneId)); setFocus(paneId) }
  const node = (item: WsNode): React.ReactNode => item.type === 'pane'
    ? <PaneView key={item.id} pane={item} focused={focus === item.id} drag={drag} setDrag={setDrag} change={change} setFocus={setFocus} addSql={addSql} confirmClose={confirmClose} renderTab={renderTab} tabNote={tabNote} tabState={tabState} visited={visited} visit={visit} ready={ready} />
    : <SplitView key={item.id} split={item} change={change} render={node} />
  return <div className={`ws-root${drag ? ' dragging' : ''}`}>{node(layout)}</div>
}

function SplitView({ split, change, render }: { split: WsSplit; change: Props['change']; render(node: WsNode): React.ReactNode }): React.JSX.Element {
  const t = useT()
  const box = useRef<HTMLDivElement>(null), row = split.dir === 'row'
  const startDrag = (index: number) => (event: React.PointerEvent): void => {
    event.preventDefault(); const size = (row ? box.current?.clientWidth : box.current?.clientHeight) || 1, start = row ? event.clientX : event.clientY, base = split.sizes, min = 90 / size
    const move = (item: PointerEvent): void => {
      const delta = ((row ? item.clientX : item.clientY) - start) / size, pair = base[index]! + base[index + 1]!, first = Math.max(min, Math.min(pair - min, base[index]! + delta))
      change((current) => resize(current, split.id, base.map((value, i) => i === index ? first : i === index + 1 ? pair - first : value)))
    }
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  return <div ref={box} className={`ws-split ws-${split.dir}`}>{split.children.map((child, index) => <React.Fragment key={child.id}><div className="ws-cell" style={{ flexGrow: split.sizes[index] ?? 1 }}>{render(child)}</div>{index < split.children.length - 1 && <div className={`ws-gutter ws-${split.dir}`} role="separator" aria-orientation={row ? 'vertical' : 'horizontal'} data-tip={t.database.dragToResize} onPointerDown={startDrag(index)} />}</React.Fragment>)}</div>
}

function PaneView({ pane, focused, drag, setDrag, change, setFocus, addSql, confirmClose, renderTab, tabNote, tabState, visited, visit, ready }: { pane: WsPane; focused: boolean; drag: string | undefined; setDrag(id: string | undefined): void; change: Props['change']; setFocus(id: string): void; addSql(paneId: string): void; confirmClose?: Props['confirmClose']; renderTab: Props['renderTab']; tabNote?: Props['tabNote']; tabState?: Props['tabState']; visited: Set<string>; visit(id: string): void; ready: React.MutableRefObject<boolean> }): React.JSX.Element {
  const t = useT()
  const [zone, setZone] = useState<DropZone>(), [tabDrop, setTabDrop] = useState<{ id: string; after: boolean }>()
  useEffect(() => { if (ready.current) visit(pane.active) }, [pane.active])
  // Dropping onto a tab puts the dragged tab before (left half) or after (right half) it.
  const dropOnTab = (target: string): void => {
    const index = pane.tabs.findIndex((tab) => tab.id === target), before = tabDrop?.after ? pane.tabs[index + 1]?.id : target
    if (drag) change((current) => placeTab(current, drag, pane.id, before)); setTabDrop(undefined); setZone(undefined); setDrag(undefined); setFocus(pane.id)
  }
  const body = useRef<HTMLDivElement>(null)
  const zoneAt = (event: React.DragEvent): DropZone => {
    const box = body.current!.getBoundingClientRect(), x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height
    const edges: Array<[number, DropZone]> = [[x, 'left'], [1 - x, 'right'], [y, 'top'], [1 - y, 'bottom']], [distance, edge] = edges.sort((a, b) => a[0] - b[0])[0]!
    return distance < 0.28 ? edge : 'center'
  }
  const drop = (target: DropZone): void => { if (drag) change((current) => moveTab(current, drag, pane.id, target)); setZone(undefined); setDrag(undefined); setFocus(pane.id) }
  return <div className={`ws-pane${focused ? ' focus' : ''}`} onPointerDownCapture={() => setFocus(pane.id)}>
    <div className="ws-tabs" role="tablist" onDragOver={(event) => { if (drag) { event.preventDefault(); setZone('center') } }} onDragLeave={() => { setZone(undefined); setTabDrop(undefined) }} onDrop={(event) => { event.preventDefault(); drop('center') }}>
      {pane.tabs.map((tab) => <span key={tab.id} className={`ws-tab${pane.active === tab.id ? ' on' : ''}${tabDrop?.id === tab.id ? (tabDrop.after ? ' drop-after' : ' drop-before') : ''}`} draggable onDragOver={(event) => { if (!drag || drag === tab.id) return; event.preventDefault(); event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); setTabDrop({ id: tab.id, after: event.clientX > box.left + box.width / 2 }) }} onDrop={(event) => { if (!drag) return; event.preventDefault(); event.stopPropagation(); dropOnTab(tab.id) }} onDragStart={(event) => { event.dataTransfer.setData('text/plain', tab.id); event.dataTransfer.effectAllowed = 'move'; setDrag(tab.id) }} onDragEnd={() => { setDrag(undefined); setZone(undefined); setTabDrop(undefined) }}>
        <button type="button" role="tab" aria-selected={pane.active === tab.id} onClick={() => { visit(tab.id); change((current) => activate(current, pane.id, tab.id)) }}>{tabState?.(tab) && <span className={`ws-dot ${tabState(tab)}`} role="img" aria-label={tabState(tab) === 'ready' ? t.database.workspace.connected : t.database.workspace.notConnected} />}{tab.kind === 'sql' && <CodeIcon />}{tab.name}{tabNote?.(tab) && <small className="ws-note">{tabNote(tab)}</small>}</button>
        <button type="button" className="ws-x" aria-label={t.database.workspace.closeTab(tab.name)} onClick={() => { void (async () => { if (dirtyTabs.has(tab.id) && confirmClose && !(await confirmClose(tab))) return; dirtyTabs.delete(tab.id); change((current) => closeTab(current, tab.id)) })() }}>×</button></span>)}
      <button type="button" className="ws-add" data-tip={t.database.workspace.newConsole} aria-label={t.database.workspace.newConsole} onClick={() => addSql(pane.id)}>+</button>
    </div>
    <div className="ws-body" ref={body}>
      {pane.tabs.map((tab) => <div key={tab.id} className="ws-view" hidden={pane.active !== tab.id}>{tab.kind === 'sql' || visited.has(tab.id) ? renderTab(tab) : <div className="db-lazy"><p>{t.database.workspace.lazyNote}</p><button type="button" onClick={() => visit(tab.id)}>{t.database.workspace.connectAndLoad}</button></div>}</div>)}
      {drag && <div className="ws-drop" onDragOver={(event) => { event.preventDefault(); setZone(zoneAt(event)) }} onDragLeave={() => setZone(undefined)} onDrop={(event) => { event.preventDefault(); drop(zoneAt(event)) }}>{zone && <div className={`ws-hint ${zone}`} />}</div>}
    </div>
  </div>
}
