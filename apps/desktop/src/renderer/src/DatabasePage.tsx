import React, { useEffect, useState } from 'react'
import type { DbConnection, IpcOutput } from '@gearmod/contracts'
import { plainError } from './NoticeDialog'
import { DbContextMenu, type DbMenuItem } from './DbContextMenu'
import { DbTree, viaChevron } from './DbTree'
import { DatabaseIcon, ServerIcon, type ConnState } from './DbIcons'
import { DbScopePicker, type ScopeItem } from './DbScopePicker'
import { Select } from './Select'
import { toast } from './toasts'
import { DbWorkspace } from './DbWorkspace'
import { DbTableView } from './DbTableView'
import { DbSqlView } from './DbSqlView'
import { defaultLayout, dropConnections, openTab, panesOf, parseLayout, setSql as setTabSql, setTabConnection, tableTab, type WsNode, type WsTab } from './DbLayout'
import { useEscape } from './useEscape'
import { Switch } from './Switch'
import { useAsk } from './useAsk'
import { useT } from './i18n'
import { ChevronRightSmallIcon, DatabaseIcon as DatabaseGlyph, EyeIcon, EyeOffIcon } from './icons'

type Tree = { schemas: Array<{ oid: number; name: string; system?: boolean }>; tables: Record<number, Array<{ oid: number; name: string; kind: string }>>; expanded: number[] }
const read = (key: string, fallback: string): string => { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }
const write = (key: string, value: string): void => { try { localStorage.setItem(key, value) } catch { /* local preference */ } }

export function DatabasePage({ projectId }: { projectId: string }): React.JSX.Element {
  const t = useT()
  const [connections, setConnections] = useState<DbConnection[]>([]), [selected, setSelected] = useState(''), [trees, setTrees] = useState<Record<string, Tree>>({}), [openConns, setOpenConns] = useState<string[]>([]), [collapsed, setCollapsed] = useState<string[]>([])
  const [treeQuery, setTreeQuery] = useState('')
  const { ask, dialog: askDialog } = useAsk()
  const [scopes, setScopes] = useState<Record<string, string[]>>({}), [totals, setTotals] = useState<Record<string, number>>({}), [scopePick, setScopePick] = useState<{ x: number; y: number; connection: DbConnection; items: ScopeItem[] }>()
  const patchTree = (id: string, change: (tree: Tree) => Tree): void => setTrees((current) => ({ ...current, [id]: change(current[id] ?? { schemas: [], tables: {}, expanded: [] }) }))
  const [layout, setLayout] = useState<WsNode>(() => defaultLayout()), [focus, setFocus] = useState('')
  const [side, setSide] = useState<'left' | 'right'>(() => read('gearmod.db.dock', 'left') === 'right' ? 'right' : 'left'), [sideWidth, setSideWidth] = useState(() => Math.max(200, Math.min(640, Number(read('gearmod.db.sideWidth', '')) || 280))), [dockDrag, setDockDrag] = useState<'left' | 'right'>()
  const [editing, setEditing] = useState<DbConnection>(), [newDbFor, setNewDbFor] = useState<DbConnection>(), [menu, setMenu] = useState<{ x: number; y: number; connection: DbConnection }>()
  const [passwordFor, setPasswordFor] = useState<string>(), [sessionPassword, setSessionPassword] = useState('')
  const [connectionState, setConnectionState] = useState<IpcOutput<'db:state'>>('disconnected')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [showNew, setShowNew] = useState(false)
  const [layoutProject, setLayoutProject] = useState(''), [states, setStates] = useState<Record<string, string>>({})
  const dropTabs = (ids: string[]): void => setLayout((current) => dropConnections(current, ids))
  const reload = (): void => { void window.gearmod.invoke('db:connections:list', { projectId }).then(setConnections).catch((reason) => setError(plainError(reason))) }
  useEffect(reload, [projectId])
  useEffect(() => { if (layoutProject === projectId) write(`gearmod.db.layout.${projectId}`, JSON.stringify(layout)) }, [layout, layoutProject, projectId])
  useEffect(() => { setLayout(loadLayout()); setFocus(''); setLayoutProject(projectId) }, [projectId])
  useEffect(() => { for (const [id, tree] of Object.entries(trees)) write(`gearmod.db.expanded.${projectId}.${id}`, JSON.stringify(tree.expanded)) }, [trees, projectId])
  useEffect(() => { if (!selected) return; const refresh = (): void => { void window.gearmod.invoke('db:state', { connectionId: selected }).then(setConnectionState).catch(() => setConnectionState('error')) }; refresh(); const timer = window.setInterval(refresh, 5000); return () => window.clearInterval(timer) }, [selected])
  /** A single tab space per project: each tab is tied to a database and opening another database does not close the other databases' tabs. */
  const loadLayout = (): WsNode => {
    try { const saved = parseLayout(JSON.parse(read(`gearmod.db.layout.${projectId}`, 'null'))); if (saved) return saved } catch { /* invalid local preference */ }
    return defaultLayout()
  }
  const closePassword = (): void => { setPasswordFor(undefined); setSessionPassword('') }
  useEscape(closePassword, Boolean(passwordFor))
  const connect = async (id: string): Promise<void> => { setBusy(true); setError(''); setSelected(id); setConnectionState('connecting'); try { await window.gearmod.invoke('db:connect', { connectionId: id }); const parentId = connections.find((item) => item.id === id)?.parentId; if (parentId) void window.gearmod.invoke('db:databases', { connectionId: parentId }).then((list) => setTotals((current) => ({ ...current, [parentId]: list.length }))).catch(() => undefined); const list = await window.gearmod.invoke('db:schemas', { connectionId: id, all: true }); let open: number[] = trees[id]?.expanded ?? []; if (!trees[id]) { try { const expandedValue: unknown = JSON.parse(read(`gearmod.db.expanded.${projectId}.${id}`, '[]')); if (Array.isArray(expandedValue)) open = expandedValue.filter((item): item is number => Number.isSafeInteger(item)).slice(0, 100) } catch { /* invalid local preference */ } } setTrees((current) => ({ ...current, [id]: { schemas: list, tables: {}, expanded: open } })); setOpenConns((current) => current.includes(id) ? current : [...current, id]); for (const oid of open) void listTables(id, oid); setConnectionState('ready'); } catch (reason) { setConnectionState('error'); setError(plainError(reason)); if (!connections.find((item) => item.id === id)?.hasSecret) { setSessionPassword(''); setPasswordFor(id) } } finally { setBusy(false) } }
  const listTables = async (id: string, oid: number): Promise<void> => { try { const result = await window.gearmod.invoke('db:tables', { connectionId: id, schemaOid: oid }); patchTree(id, (tree) => ({ ...tree, tables: { ...tree.tables, [oid]: result } })) } catch (reason) { setError(plainError(reason)) } }
  const toggleSchema = (id: string, oid: number, opened: boolean): void => { patchTree(id, (tree) => ({ ...tree, expanded: opened ? [...new Set([...tree.expanded, oid])] : tree.expanded.filter((item) => item !== oid) })); if (opened && !trees[id]?.tables[oid]) void listTables(id, oid) }
  const openFrom = async (id: string, item: { oid: number; name: string }): Promise<void> => { if (id !== selected) await connect(id); setLayout((current) => openTab(current, tableTab(item.oid, item.name, id), focus)) }
  const removeConnection = async (connection: DbConnection): Promise<void> => {
    const children = connections.filter((item) => item.parentId === connection.id)
    if (!(await ask({ eyebrow: connection.parentId ? t.database.page.removeDb : t.database.page.removeServer, title: connection.name, text: connection.parentId ? t.database.page.removeDbText : t.database.page.removeServerText(children.length), ok: t.common.remove, danger: true }))) return
    void window.gearmod.invoke('db:connections:delete', { connectionId: connection.id }).then(() => { dropTabs([connection.id, ...children.map((item) => item.id)]); if (selected === connection.id || children.some((item) => item.id === selected)) { setSelected(''); setTrees({}) }; reload() }).catch((reason) => setError(plainError(reason)))
  }
  const openMenu = (connection: DbConnection, x: number, y: number): void => setMenu({ x, y, connection })
  const menuItems = (connection: DbConnection): DbMenuItem[] => connection.parentId
    ? [{ label: t.common.open, run: () => { setMenu(undefined); void connect(connection.id) } }, { label: t.database.page.menuEditDb, run: () => { setMenu(undefined); setNewDbFor(undefined); setEditing(connection); setShowNew(true) } }, { label: t.database.page.menuRemoveFromList, danger: true, run: () => { setMenu(undefined); void removeConnection(connection) } }]
    : [{ label: t.database.page.menuAddDb, run: () => { setMenu(undefined); setEditing(undefined); setNewDbFor(connection); setShowNew(true) } }, { label: t.database.page.menuEditServer, run: () => { setMenu(undefined); setNewDbFor(undefined); setEditing(connection); setShowNew(true) } }, { label: t.database.page.removeServer, danger: true, run: () => { setMenu(undefined); void removeConnection(connection) } }]
  const scopeKey = (id: string): string => `gearmod.db.scope.${projectId}.${id}`
  /** Schemas chosen in the database filter; with no saved choice, shows all but the system ones. */
  const savedScope = (id: string): string[] | undefined => {
    if (scopes[id]) return scopes[id]
    try { const value: unknown = JSON.parse(read(scopeKey(id), 'null')); if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').slice(0, 500) } catch { /* invalid local preference */ }
    return undefined
  }
  const visibleSchemas = (id: string, list: Tree['schemas']): Tree['schemas'] => { const saved = savedScope(id); return list.filter((item) => saved ? saved.includes(item.name) : !item.system) }
  const openScope = async (connection: DbConnection, x: number, y: number): Promise<void> => {
    try {
      let items: ScopeItem[]
      if (!connection.parentId) {
        const names = await window.gearmod.invoke('db:databases', { connectionId: connection.id })
        setTotals((current) => ({ ...current, [connection.id]: names.length }))
        const have = new Set(connections.filter((item) => item.parentId === connection.id).map((item) => item.database))
        items = names.map((name) => ({ key: name, label: name, ...(name === connection.database ? { note: t.database.page.defaultNote } : {}), checked: have.has(name) }))
      } else {
        const list = await window.gearmod.invoke('db:schemas', { connectionId: connection.id, all: true }), visible = new Set(visibleSchemas(connection.id, list).map((item) => item.name))
        items = list.map((item) => ({ key: item.name, label: item.name, ...(item.name === 'public' ? { note: t.database.page.defaultNote } : {}), ...(item.system ? { system: true } : {}), checked: visible.has(item.name) }))
      }
      setScopePick({ x, y, connection, items })
    } catch (reason) { toast.error(t.database.page.listFailed, plainError(reason)) }
  }
  const applyScope = async (connection: DbConnection, keys: string[]): Promise<void> => {
    setScopePick(undefined)
    if (connection.parentId) { setScopes((current) => ({ ...current, [connection.id]: keys })); write(scopeKey(connection.id), JSON.stringify(keys)); return }
    const children = connections.filter((item) => item.parentId === connection.id), have = new Set(children.map((item) => item.database))
    const add = keys.filter((name) => !have.has(name)), drop = children.filter((item) => !keys.includes(item.database))
    if (!add.length && !drop.length) return
    if (drop.length && !(await ask({ eyebrow: t.database.page.removeDbs, title: t.database.page.removeDbsTitle(drop.length), text: t.database.page.removeDbsText(drop.map((item) => item.name).join(', ')), ok: t.common.remove, danger: true }))) return
    try {
      for (const item of drop) await window.gearmod.invoke('db:connections:delete', { connectionId: item.id })
      for (const name of add) await window.gearmod.invoke('db:connections:save', { projectId, parentId: connection.id, name, host: connection.host, port: connection.port, database: name, user: connection.user, klass: connection.klass, sslMode: connection.sslMode, allowWrite: connection.allowWrite, agentAccess: 'none' as const, ...(connection.allowWrite && (connection.klass === 'prod' || connection.klass === 'external') ? { confirmWrite: name } : {}) })
      dropTabs(drop.map((item) => item.id))
      if (drop.some((item) => item.id === selected)) { setSelected(''); setTrees({}) }
    } catch (reason) { setError(plainError(reason)) }
    reload()
  }
  const refreshTrees = (): void => { for (const id of openConns) { void window.gearmod.invoke('db:schemas', { connectionId: id, all: true }).then((list) => { const open = trees[id]?.expanded ?? []; setTrees((current) => ({ ...current, [id]: { schemas: list, tables: {}, expanded: open } })); for (const oid of open) void listTables(id, oid) }).catch((reason) => setError(plainError(reason))) } }
  const focusPane = panesOf(layout).find((pane) => pane.id === focus) ?? panesOf(layout)[0]!, activeTab = focusPane.tabs.find((tab) => tab.id === focusPane.active)
  const activeOid: number | 'sql' = activeTab?.kind === 'table' && activeTab.oid !== undefined ? activeTab.oid : 'sql'
  const activeConn = activeTab?.connectionId ?? selected
  const databaseOptions = connections.filter((item) => item.parentId).map((item) => ({ value: item.id, label: connections.filter((other) => !other.parentId).length > 1 ? `${connections.find((other) => other.id === item.parentId)?.name ?? ''} · ${item.name}` : item.name }))
  const tabConnection = (tab: WsTab): string => tab.connectionId ?? selected
  const usedConnections = new Set(panesOf(layout).flatMap((pane) => pane.tabs).map(tabConnection))
  // With tabs from more than one open database, each tab shows its own database name.
  // Connection dot on each tab: queries the state of the databases in use without connecting any of them.
  const usedKey = [...usedConnections].filter(Boolean).sort().join(',')
  useEffect(() => {
    const ids = usedKey ? usedKey.split(',') : []; if (!ids.length) return
    const poll = (): void => { void Promise.all(ids.map((id) => window.gearmod.invoke('db:state', { connectionId: id }).then((state) => [id, state] as const, () => [id, 'error'] as const))).then((pairs) => setStates((current) => ({ ...current, ...Object.fromEntries(pairs) }))) }
    poll(); const timer = window.setInterval(poll, 3000); return () => window.clearInterval(timer)
  }, [usedKey])
  const tabState = (tab: WsTab): string | undefined => { const id = tabConnection(tab); return id ? states[id] ?? 'disconnected' : undefined }
  const tabNote = (tab: WsTab): string | undefined => usedConnections.size > 1 ? connections.find((item) => item.id === tabConnection(tab))?.name : undefined
  const renderTab = (tab: WsTab): React.ReactNode => {
    const id = tabConnection(tab), conn = connections.find((item) => item.id === id), writable = conn?.allowWrite ?? false
    if (!id) return <p className="db-empty">{t.database.page.pickDbForTab}</p>
    return tab.kind === 'sql'
      ? <DbSqlView connectionId={id} databases={databaseOptions} setConnection={(value) => setLayout((current) => setTabConnection(current, tab.id, value))} allowWrite={writable} production={conn?.klass === 'prod' || conn?.klass === 'external'} database={conn?.database ?? ''} sql={tab.sql ?? ''} setSql={(value) => setLayout((current) => setTabSql(current, tab.id, value))} />
      : <DbTableView tabId={tab.id} connectionId={id} oid={tab.oid!} name={tab.name} allowWrite={writable} />
  }
  // Sidebar width: drag the divider; the docking side changes by dragging the title left or right.
  const startWidth = (event: React.PointerEvent): void => {
    event.preventDefault(); const page = (event.currentTarget as HTMLElement).closest('.db-page') as HTMLElement, box = page.getBoundingClientRect(); let last = sideWidth
    const move = (item: PointerEvent): void => { last = Math.round(Math.max(200, Math.min(Math.min(640, box.width - 360), side === 'left' ? item.clientX - box.left : box.right - item.clientX))); setSideWidth(last) }
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); write('gearmod.db.sideWidth', String(last)) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const startDock = (event: React.PointerEvent): void => {
    if ((event.target as HTMLElement).closest('button')) return
    event.preventDefault(); const box = (event.currentTarget as HTMLElement).closest('.db-page')!.getBoundingClientRect(); let target = side, moved = false
    const move = (item: PointerEvent): void => { moved = true; target = item.clientX < box.left + box.width / 2 ? 'left' : 'right'; setDockDrag(target) }
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setDockDrag(undefined); if (moved && target !== side) { setSide(target); write('gearmod.db.dock', target) } }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const renderConn = (connection: DbConnection): React.JSX.Element => {
    const kids = !connection.parentId
    const tree = trees[connection.id], open = kids ? !collapsed.includes(connection.id) : openConns.includes(connection.id)
    // The server is just the container of the databases; each database expands its own tree right below.
    const toggleRow = (): void => { if (kids) setCollapsed((current) => open ? [...current, connection.id] : current.filter((item) => item !== connection.id)); else if (open && selected === connection.id) setOpenConns((current) => current.filter((item) => item !== connection.id)); else void connect(connection.id) }
    return <div key={connection.id} className="db-conn-wrap"><div className={`db-conn${connection.parentId ? ' child' : ' server'}${selected === connection.id ? ' on' : ''}`} onContextMenu={(event) => { event.preventDefault(); openMenu(connection, event.clientX, event.clientY) }}><button type="button" className="db-conn-name" aria-expanded={open} data-tip={connection.parentId ? `${connection.name} · ${connection.database}` : `${connection.host}:${connection.port} · ${connection.user}`} onClick={(event) => { if (viaChevron(event)) toggleRow(); else if (!kids && open && selected !== connection.id) void connect(connection.id) }}><span className={`wf-chevron ${open ? 'open' : ''}`} aria-hidden="true"><ChevronRightSmallIcon /></span>{kids ? <ServerIcon state={kids ? (connections.some((item) => item.parentId === connection.id && (openConns.includes(item.id) || Boolean(trees[item.id]))) ? 'ready' : 'idle') : selected === connection.id ? connectionState : tree ? 'ready' : 'idle' as ConnState} /> : <DatabaseIcon state={kids ? (connections.some((item) => item.parentId === connection.id && (openConns.includes(item.id) || Boolean(trees[item.id]))) ? 'ready' : 'idle') : selected === connection.id ? connectionState : tree ? 'ready' : 'idle' as ConnState} />}{connection.name}{!connection.parentId && <small>{connection.host}:{connection.port}</small>}</button>{(kids || tree) && <button type="button" className="db-scope" data-tip={kids ? t.database.page.pickServerDbs : t.database.page.pickDbSchemas} aria-label={kids ? t.database.page.dbsOf(connection.name) : t.database.page.schemasOf(connection.name)} onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); void openScope(connection, box.left, box.bottom + 4) }}>{kids ? t.database.page.serverScopeCount(connections.filter((item) => item.parentId === connection.id).length, totals[connection.id] ?? 0) : t.database.page.schemaScopeCount(visibleSchemas(connection.id, tree!.schemas).length, tree!.schemas.length)}</button>}<button type="button" className="db-conn-more" aria-label={t.database.actionsOf(connection.name)} aria-haspopup="menu" onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); openMenu(connection, box.left, box.bottom + 4) }}>⋯</button></div>
      {!kids && open && tree && <DbTree connectionId={connection.id} schemas={visibleSchemas(connection.id, tree.schemas)} tables={tree.tables} expanded={tree.expanded} query={treeQuery} activeOid={activeConn === connection.id ? activeOid : 'sql'} open={(item) => void openFrom(connection.id, item)} fail={setError} toggleSchema={(oid, opened) => toggleSchema(connection.id, oid, opened)} />}</div>
  }
  return <div className={`db-page${side === 'right' ? ' dock-right' : ''}`}>{scopePick && <DbScopePicker x={scopePick.x} y={scopePick.y} title={scopePick.connection.parentId ? t.database.page.schemasTitle : t.database.page.databasesTitle} items={scopePick.items} apply={(keys) => void applyScope(scopePick.connection, keys)} close={() => setScopePick(undefined)} />}{menu && <DbContextMenu x={menu.x} y={menu.y} title={menu.connection.name} items={menuItems(menu.connection)} close={() => setMenu(undefined)} />}{dockDrag && <div className={`db-dock-preview ${dockDrag}`} style={{ width: sideWidth }} aria-hidden="true" />}<aside style={{ width: sideWidth }}><div className="db-side-head db-side-grip" onPointerDown={startDock}><h2 data-tip={t.database.page.dragToDock}>{t.database.title}</h2><button type="button" className="db-new" onClick={() => { setEditing(undefined); setNewDbFor(undefined); setShowNew(true) }}>{t.database.page.newServer}</button></div><div className="db-search"><input aria-label={t.database.page.searchTree} placeholder={t.database.page.searchTree} data-tip={t.database.page.searchTreeTip} value={treeQuery} onChange={(event) => setTreeQuery(event.target.value)} /><button type="button" className="db-tool db-refresh" data-tip={t.database.page.refreshTrees} aria-label={t.database.page.refreshTree} onClick={refreshTrees}>↻</button></div><div className="db-conns">{connections.filter((item) => !item.parentId).map((server) => <div key={server.id} className="db-server">{renderConn(server)}{!collapsed.includes(server.id) && <div className="db-dbs">{connections.some((item) => item.parentId === server.id) ? connections.filter((item) => item.parentId === server.id).map((child) => renderConn(child)) : <p className="db-hint">{t.database.page.noDatabasesYet}</p>}</div>}</div>)}</div>
    </aside><div className="db-vgutter" role="separator" aria-orientation="vertical" data-tip={t.database.dragToResize} onPointerDown={startWidth} />
    <section>{passwordFor && <div className="overlay" role="dialog" aria-label={t.database.page.sessionPasswordAria}><div className="modal"><header><div><div className="eyebrow">{t.database.title}</div><h2>{t.database.page.sessionPasswordTitle}</h2></div><button type="button" className="x" aria-label={t.common.close} onClick={closePassword}>×</button></header><p>{t.database.page.sessionPasswordNote}</p><label>{t.database.page.password}<input type="password" value={sessionPassword} autoComplete="off" onChange={(event) => setSessionPassword(event.target.value)} /></label><div className="actions"><button type="button" className="secondary" onClick={closePassword}>{t.common.cancel}</button><button type="button" onClick={() => { const id = passwordFor, value = sessionPassword; setPasswordFor(undefined); setSessionPassword(''); void window.gearmod.invoke('db:session-password', { connectionId: id, password: value }).then(() => { reload(); return connect(id) }).catch((reason) => setError(plainError(reason))) }}>{t.database.page.connect}</button></div></div></div>}{askDialog}{showNew && (newDbFor || editing?.parentId ? <DatabaseForm projectId={projectId} server={newDbFor ?? connections.find((item) => item.id === editing?.parentId)!} initial={editing} close={() => setShowNew(false)} saved={(created) => { setShowNew(false); if (selected === editing?.id) { setSelected(''); setTrees({}) }; reload(); if (created) void connect(created) }} /> : <ConnectionForm projectId={projectId} initial={editing} close={() => setShowNew(false)} saved={(created) => { setShowNew(false); if (created) void connect(created); if (selected === editing?.id || connections.some((item) => item.parentId === editing?.id && item.id === selected)) { setSelected(''); setTrees({}) }; reload() }} />)}{error && <p className="error">{error}</p>}{!connections.length && <div className="db-welcome"><div className="db-welcome-card">
      <DatabaseGlyph />
      <h3>{t.database.page.welcomeTitle}</h3><p>{t.database.page.welcomeText}</p>
      <button type="button" onClick={() => { setEditing(undefined); setNewDbFor(undefined); setShowNew(true) }}>{t.database.page.newServer}</button>
      <small>{t.database.page.welcomeHint}</small></div></div>}{(busy || (selected && ['lost', 'error'].includes(connectionState))) && <div className="db-topbar">{selected && ['lost', 'error'].includes(connectionState) && <p role="status" className={`db-status ${connectionState}`}><span className={`db-dot ${connectionState}`} aria-hidden="true" />{connectionState === 'lost' ? t.database.page.connectionLost : t.database.page.connectionFailed}<button type="button" className="db-tool" onClick={() => void connect(selected)}>{t.database.page.reconnect}</button></p>}{busy && <p className="db-busy"><span className="db-spin" aria-hidden="true" />{t.database.page.connecting}</p>}</div>}
      {layoutProject === projectId && connections.length > 0 && <DbWorkspace layout={layout} change={setLayout} focus={focusPane.id} setFocus={setFocus} renderTab={renderTab} sqlConnection={activeConn || undefined} tabNote={tabNote} tabState={tabState} confirmClose={() => ask({ eyebrow: t.database.table.pendingChanges, title: t.database.table.discardTitle, text: t.database.table.discardText, ok: t.database.table.discard, danger: true })} />}</section></div>
}

function ConnectionForm({ projectId, initial, close, saved }: { projectId: string; initial?: DbConnection; close(): void; saved(created?: string): void }): React.JSX.Element {
  const t = useT()
  const [name, setName] = useState(initial?.name ?? ''), [host, setHost] = useState(initial?.host ?? 'localhost'), [port, setPort] = useState(initial?.port ?? 5432), [database, setDatabase] = useState(initial?.database ?? 'postgres'), [user, setUser] = useState(initial?.user ?? ''), [password, setPassword] = useState(''), [session, setSession] = useState(false), [klass, setKlass] = useState<'dev' | 'test' | 'prod' | 'external'>(initial?.klass ?? 'dev'), [allowWrite, setAllowWrite] = useState(initial?.allowWrite ?? true), [confirmation, setConfirmation] = useState(''), [sslMode, setSslMode] = useState<'disable' | 'require' | 'verify-full'>(initial?.sslMode ?? 'disable'), [error, setError] = useState('')
  useEscape(close)
  const [testing, setTesting] = useState(false), [showPassword, setShowPassword] = useState(false)
  const [agentAccess] = useState<'none' | 'read'>(initial?.agentAccess ?? 'none')
  const agentEligible = ['localhost','127.0.0.1','::1'].includes(host.toLowerCase()) && (klass === 'dev' || klass === 'test')
  const input = () => ({ projectId, name, host, port, database, user, ...(initial ? { id: initial.id } : {}), ...(!initial || password ? { password, passwordStorage: session ? 'session' as const : 'secure' as const } : {}), klass, sslMode, allowWrite, agentAccess: agentEligible ? agentAccess : 'none' as const, ...(confirmation ? { confirmWrite: confirmation } : {}) })
  const save = (): void => {
    setError('')
    void window.gearmod.invoke('db:connections:save', input()).then(async (server) => {
      const first = database.trim()
      // The server is just the container: the given database already goes inside it as the first database in the list.
      const child = initial || !first ? undefined : await window.gearmod.invoke('db:connections:save', { projectId, parentId: server.id, name: first, host, port, database: first, user, klass, sslMode, allowWrite, agentAccess: 'none' as const, ...(allowWrite && (klass === 'prod' || klass === 'external') ? { confirmWrite: first } : {}) }).catch(() => undefined)
      saved(child?.id)
    }).catch((reason) => setError(plainError(reason)))
  }
  const [tab, setTab] = useState<'general' | 'options' | 'ssl'>('general')
  const test = (): void => {
    setError(''); setTesting(true)
    void window.gearmod.invoke('db:connections:test', input())
      .then((result) => toast.success(t.database.connForm.connected, [result.version, result.pingMs !== undefined ? `${result.pingMs} ms` : '', t.database.connForm.sslState[sslMode]].filter(Boolean).join(' · ')))
      .catch((reason) => toast.error(t.database.connForm.cannotConnect, plainError(reason)))
      .finally(() => setTesting(false))
  }
  const external = !['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase())
  return <div className="overlay" role="dialog" aria-label={t.database.connForm.dialogAria}><div className="modal dbmodal"><header><div><div className="eyebrow">{t.database.title}</div><h2>{initial ? t.database.connForm.editTitle : t.database.connForm.newTitle}</h2></div><button type="button" className="x" aria-label={t.common.close} onClick={close}>×</button></header>
    <label className="f dbname">{t.common.name}<input className="in" value={name} onChange={(e) => setName(e.target.value)} placeholder={t.database.connForm.namePlaceholder} /></label>
    <div className="tabs dbtabs" role="tablist">{(['general', 'options', 'ssl'] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{t.database.connForm.tabs[value]}</button>)}</div>
    <div className="stack dbform dbpane">
      {tab === 'general' && <>
        <div className="dbrow"><label className="f">{t.database.connForm.host}<input className="in" value={host} onChange={(e) => { const value = e.target.value; setHost(value); if (!['localhost', '127.0.0.1', '::1'].includes(value.toLowerCase())) { setKlass('external'); setAllowWrite(false) } }} /></label><label className="f">{t.database.connForm.port}<input className="in" type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} /></label></div>
        <label className="f">{t.database.connForm.user}<input className="in" value={user} onChange={(e) => setUser(e.target.value)} /></label>
        <div className="dbrow pw"><label className="f">{t.database.page.password}<span className="pwfield"><input className="in" type={showPassword ? 'text' : 'password'} value={password} placeholder={initial?.hasSecret ? t.database.connForm.keepPasswordPlaceholder : ''} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /><button type="button" className="pwtoggle tip" data-tip={showPassword ? t.database.connForm.hidePassword : t.database.connForm.showPassword} aria-label={showPassword ? t.database.connForm.hidePassword : t.database.connForm.showPassword} aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOffIcon /> : <EyeIcon />}</button></span></label>
          <div className="f"><span>{t.database.connForm.store}</span><Select label={t.database.connForm.storeWhere} value={session ? 'session' : 'secure'} options={[{ value: 'secure', label: t.database.connForm.storeOptions.secure }, { value: 'session', label: t.database.connForm.storeOptions.session }]} onChange={(value) => setSession(value === 'session')} /></div></div>
        <label className="f">{initial ? t.database.connForm.initialDatabase : t.database.connForm.database}<input className="in" value={database} onChange={(e) => setDatabase(e.target.value)} /></label>
        <p className="db-hint">{initial ? t.database.connForm.initialDatabaseHint : t.database.connForm.databaseHint}</p>
      </>}
      {tab === 'options' && <>
        <div className="dbrow"><div className="f"><span>{t.database.connForm.environment}</span><Select label={t.database.connForm.environment} value={klass} options={[{ value: 'dev', label: t.database.connForm.environments.dev }, { value: 'test', label: t.database.connForm.environments.test }, { value: 'prod', label: t.database.connForm.environments.prod }, { value: 'external', label: t.database.connForm.environments.external }]} onChange={(value) => { setKlass(value as typeof klass); setAllowWrite(value === 'dev' || value === 'test') }} /></div></div>
        <Switch className="dbsw" checked={allowWrite} onChange={setAllowWrite}>{t.database.connForm.allowWrite}</Switch>
        {agentEligible && <Switch className="dbsw" checked={false} disabled onChange={() => undefined}>{t.database.connForm.agentRead}</Switch>}
        {allowWrite && (klass === 'prod' || klass === 'external') && <label className="f">{t.database.connForm.confirmName}<input className="in" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></label>}
      </>}
      {tab === 'ssl' && <>
        <div className="f"><span>{t.database.connForm.sslMode}</span><Select label={t.database.connForm.sslMode} value={sslMode} options={[{ value: 'disable', label: t.database.connForm.sslModes.disable }, { value: 'require', label: t.database.connForm.sslModes.require }, { value: 'verify-full', label: t.database.connForm.sslModes['verify-full'] }]} onChange={(value) => setSslMode(value as typeof sslMode)} /></div>
        {external && sslMode === 'disable' && <p className="error">{t.database.connForm.externalNoSsl}</p>}
      </>}
    </div>
    <footer className="dbfoot"><button type="button" className="dblink" onClick={test} disabled={testing}>{testing ? t.database.connForm.testing : t.database.connForm.test}</button>{error && <span className="dbtest bad" role="alert">{error}</span>}<span className="grow1" /><button type="button" className="secondary" onClick={close}>{t.common.cancel}</button><button type="button" onClick={save}>{t.common.save}</button></footer>
  </div></div>
}

/** Database inside a server: host, user, SSL, environment and password come from the server. */
function DatabaseForm({ projectId, server, initial, close, saved }: { projectId: string; server: DbConnection; initial?: DbConnection; close(): void; saved(created?: string): void }): React.JSX.Element {
  const t = useT()
  const [database, setDatabase] = useState(initial?.database ?? ''), [name, setName] = useState(initial?.name ?? ''), [nameTouched, setNameTouched] = useState(Boolean(initial))
  const [allowWrite, setAllowWrite] = useState(initial?.allowWrite ?? server.allowWrite), [confirmation, setConfirmation] = useState(''), [error, setError] = useState(''), [available, setAvailable] = useState<string[]>([]), [listNote, setListNote] = useState(t.database.dbForm.loadingList)
  useEffect(() => {
    let alive = true
    void window.gearmod.invoke('db:connect', { connectionId: server.id }).then(() => window.gearmod.invoke('db:databases', { connectionId: server.id })).then((list) => { if (alive) { setAvailable(list); setListNote('') } }).catch(() => { if (alive) setListNote(t.database.dbForm.listFailed) })
    return () => { alive = false }
  }, [server.id])
  useEscape(close)
  const needsConfirm = allowWrite && (server.klass === 'prod' || server.klass === 'external')
  const save = (): void => { setError(''); void window.gearmod.invoke('db:connections:save', { projectId, parentId: server.id, ...(initial ? { id: initial.id } : {}), name: name || database, host: server.host, port: server.port, database, user: server.user, klass: server.klass, sslMode: server.sslMode, allowWrite, agentAccess: initial?.agentAccess ?? 'none', ...(confirmation ? { confirmWrite: confirmation } : {}) }).then((item) => saved(initial ? undefined : item.id)).catch((reason) => setError(plainError(reason))) }
  return <div className="overlay" role="dialog" aria-label={t.database.dbForm.dialogAria}><div className="modal dbmodal"><header><div><div className="eyebrow">{t.database.title}</div><h2>{initial ? t.database.dbForm.editTitle(server.name) : t.database.dbForm.newTitle(server.name)}</h2></div><button type="button" className="x" aria-label={t.common.close} onClick={close}>×</button></header><div className="stack dbform">
    <p className="db-hint">{t.database.dbForm.usesConnection(`${server.user}@${server.host}:${server.port}`)}</p>
    {available.length ? <div className="f"><span>{t.database.connForm.database}</span><Select label={t.database.connForm.database} value={database} options={[{ value: '', label: t.database.dbForm.pickDatabase }, ...[...new Set([...(database ? [database] : []), ...available])].map((item) => ({ value: item, label: item }))]} onChange={(value) => { setDatabase(value); if (!nameTouched) setName(value) }} /></div> : <label className="f">{t.database.connForm.database}<input className="in" value={database} onChange={(e) => { setDatabase(e.target.value); if (!nameTouched) setName(e.target.value) }} placeholder={t.database.dbForm.typeDatabase} /></label>}
    {listNote && <p className="db-hint">{listNote}</p>}
    <label className="f">{t.database.dbForm.nameInList}<input className="in" value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true) }} placeholder={database || t.database.dbForm.sameAsDatabase} /></label>
    <Switch className="dbsw" checked={allowWrite} disabled={!server.allowWrite} onChange={setAllowWrite}>{t.database.dbForm.allowWrite(!server.allowWrite)}</Switch>
    {needsConfirm && <label className="f">{t.database.connForm.confirmName}<input className="in" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder={name || database} /></label>}
    {error && <p className="error">{error}</p>}<div className="actions"><button type="button" className="secondary" onClick={close}>{t.common.cancel}</button><button type="button" disabled={!database.trim()} onClick={save}>{t.common.save}</button></div></div></div></div>
}
