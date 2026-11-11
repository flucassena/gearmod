import React, { useEffect, useRef, useState } from 'react'
import { isShortcut } from './shortcuts'
import type { IpcOutput } from '@gearmod/contracts'
import { plainError } from './NoticeDialog'
import { ClauseInput } from './ClauseInput'
import { DbGrid, type GridEdit, type GridMode } from './DbGrid'
import { toast } from './toasts'
import { RefreshTools, TbBtn } from './DbGridTools'
import { DbContextMenu, type DbMenuItem } from './DbContextMenu'
import { DbInfoDialog, type DbInfoKind } from './DbInfoDialog'
import { useDbRequest } from './DbRequest'
import { dirtyTabs } from './DbLayout'
import { useAsk } from './useAsk'
import { useEscape } from './useEscape'
import { useT } from './i18n'
import { ChevronLeftIcon, ChevronRightIcon, FirstPageIcon, LastPageIcon } from './icons'

type Describe = IpcOutput<'db:describe'>
type Order = { column: number; dir: 'asc' | 'desc' }[]
const whereWords = ['AND', 'OR', 'NOT', 'IN', 'LIKE', 'ILIKE', 'IS NULL', 'IS NOT NULL', 'BETWEEN', 'TRUE', 'FALSE', 'EXISTS']
const orderWords = ['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST']
const columnNames = (columns: Array<{ name: string }>): string[] => columns.map((column) => /^[a-z_][a-z0-9_]*$/.test(column.name) ? column.name : `"${column.name.replaceAll('"', '""')}"`)

type Pending = { added: Array<Record<number, string | null>>; edits: Record<number, Record<number, string | null>>; removed: number[] }
const noPending: Pending = { added: [], edits: {}, removed: [] }

export function SqBtn({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }): React.JSX.Element {
  return <button type="button" className="db-sq" data-tip={label} aria-label={label} onClick={onClick}><svg className="ico" viewBox="0 0 16 16" aria-hidden="true">{children}</svg></button>
}

/** Table window: WHERE/ORDER BY filters, grid and pagination, with its own state. */
export function DbTableView({ tabId, connectionId, oid, name, allowWrite }: { tabId?: string; connectionId: string; oid: number; name: string; allowWrite: boolean }): React.JSX.Element {
  const t = useT()
  const req = useDbRequest(connectionId)
  const [meta, setMeta] = useState<Describe>(), [page, setPage] = useState<IpcOutput<'db:page'>>(), [offset, setOffset] = useState(0), [order, setOrder] = useState<Order>([]), [exactCount, setExactCount] = useState<string>()
  const [whereText, setWhereText] = useState(''), [orderText, setOrderText] = useState(''), clauses = useRef({ where: '', orderBy: '' })
  const [dialog, setDialog] = useState<DbInfoKind>(), [pagerMenu, setPagerMenu] = useState<{ x: number; y: number }>()
  const [pageSize, setPageSizeState] = useState(() => { try { return Number(localStorage.getItem('gearmod.db.pageSize')) || 200 } catch { return 200 } })
  const sizeRef = useRef(pageSize); sizeRef.current = pageSize
  const [pending, setPending] = useState<Pending>(noPending), [sel, setSel] = useState<{ row: number; col: number; mode: GridMode }>({ row: 0, col: 0, mode: 'cell' })
  const [preview, setPreview] = useState<string[]>(), [applying, setApplying] = useState(false)
  const { ask, dialog: askDialog } = useAsk()
  useEscape(() => setPreview(undefined), Boolean(preview))
  const root = useRef<HTMLDivElement>(null), pendingRef = useRef(pending)
  pendingRef.current = pending
  const hasPending = pending.added.length > 0 || Object.keys(pending.edits).length > 0 || pending.removed.length > 0
  useEffect(() => { if (!tabId) return; if (hasPending) dirtyTabs.add(tabId); else dirtyTabs.delete(tabId) }, [tabId, hasPending])
  const clauseArgs = (): { where?: string; orderBy?: string } => ({ ...(clauses.current.where.trim() ? { where: clauses.current.where } : {}), ...(clauses.current.orderBy.trim() ? { orderBy: clauses.current.orderBy } : {}) })
  const loadPage = async (nextOffset: number, nextOrder: Order, quiet = false): Promise<void> => {
    const dirty = pendingRef.current.added.length + Object.keys(pendingRef.current.edits).length + pendingRef.current.removed.length > 0
    if (dirty) { if (quiet || !(await ask({ eyebrow: t.database.table.pendingChanges, title: t.database.table.discardTitle, text: t.database.table.discardText, ok: t.database.table.discard, danger: true }))) return; setPending(noPending) }
    const id = req.start(); setExactCount(undefined)
    try { const result = await window.gearmod.invoke('db:page', { connectionId, oid, requestId: id, conditions: [], ...clauseArgs(), order: nextOrder, limit: sizeRef.current, offset: nextOffset }); if (req.current(id)) { setPage(result); setOffset(nextOffset) } } catch (reason) { if (req.current(id)) req.setError(plainError(reason)) } finally { req.finish(id) }
  }
  useEffect(() => { void window.gearmod.invoke('db:describe', { connectionId, oid }).then(setMeta).catch((reason) => req.setError(plainError(reason))); void loadPage(0, []) }, [connectionId, oid])
  const count = async (): Promise<string | undefined> => {
    const id = req.start()
    try { const result = await window.gearmod.invoke('db:count', { connectionId, oid, requestId: id, conditions: [], ...clauseArgs(), order: [], limit: 200, offset: 0 }); if (req.current(id)) { setExactCount(result.count); return result.count } } catch (reason) { if (req.current(id)) req.setError(plainError(reason)) } finally { req.finish(id) }
  }
  const goLast = async (): Promise<void> => { const total = Number(exactCount ?? await count()); if (!Number.isFinite(total) || total < 1) return; await loadPage(Math.floor((total - 1) / pageSize) * pageSize, order) }
  const applyClauses = (): void => { clauses.current = { where: whereText, orderBy: orderText }; void loadPage(0, order) }
  const changeSize = (size: number): void => { setPageSizeState(size); sizeRef.current = size; setPagerMenu(undefined); try { localStorage.setItem('gearmod.db.pageSize', String(size)) } catch { /* local preference */ } void loadPage(0, order) }
  const pagerItems: DbMenuItem[] = [{ label: t.database.table.countRows, run: () => { setPagerMenu(undefined); void count() } }, ...[10, 50, 100, 200, 500, 1000].map((size) => ({ label: `${size === pageSize ? '✓' : '  '} ${t.database.table.rowsPerPage(size)}`, run: () => changeSize(size) }))]
  const busy = req.busy
  const offsetRef = useRef(offset), orderRef = useRef(order); offsetRef.current = offset; orderRef.current = order
  // Pending changes: edited cells, new rows (at the end of the grid) and rows marked for deletion.
  const baseRows = page?.rows ?? [], pkIndex = page && meta ? meta.columns.filter((column) => column.primaryKey).map((column) => page.columns.findIndex((item) => item.attnum === column.attnum)) : []
  const hasPk = pkIndex.length > 0 && pkIndex.every((index) => index >= 0)
  const rowKey = (row: number): Record<string, string | null> | undefined => {
    const source = baseRows[row]; if (!page || !source || !hasPk || pkIndex.some((index) => source[index]?.t == null || source[index]?.big)) return undefined
    return Object.fromEntries(pkIndex.map((index) => [String(page.columns[index]!.attnum), source[index]!.t]))
  }
  const gridRows = page ? [...baseRows.map((row, r) => pending.edits[r] ? row.map((cell, c) => c in pending.edits[r]! ? { t: pending.edits[r]![c]! } : cell) : row), ...pending.added.map((row) => page.columns.map((_, c) => ({ t: row[c] ?? null })))] : []
  const editApi: GridEdit = {
    status: (r, c) => r >= baseRows.length ? 'new' : pending.edits[r] && c in pending.edits[r]! ? 'edited' : undefined,
    rowStatus: (r) => r >= baseRows.length ? 'new' : pending.removed.includes(r) ? 'deleted' : undefined,
    editable: (r, c) => {
      if (!page || page.columns[c]?.type === 'bytea') return false
      if (r >= baseRows.length) return true
      return !pending.removed.includes(r) && !baseRows[r]?.[c]?.big && rowKey(r) !== undefined
    },
    commit: (r, c, value) => setPending((current) => {
      if (r >= baseRows.length) return { ...current, added: current.added.map((row, i) => i === r - baseRows.length ? { ...row, [c]: value } : row) }
      const original = baseRows[r]?.[c]?.t ?? null, row = { ...(current.edits[r] ?? {}) }
      if (value === original) delete row[c]; else row[c] = value
      const edits = { ...current.edits }; if (Object.keys(row).length) edits[r] = row; else delete edits[r]
      return { ...current, edits }
    })
  }
  const addRow = (): void => {
    if (!allowWrite || !page) return
    setPending((current) => ({ ...current, added: [...current.added, {}] }))
    requestAnimationFrame(() => { const box = root.current?.querySelector('.db-grid-scroll'); if (box) box.scrollTop = box.scrollHeight })
  }
  const deleteRow = (): void => {
    if (!allowWrite || !page || sel.mode === 'col') return
    if (sel.row >= baseRows.length) { const index = sel.row - baseRows.length; setPending((current) => ({ ...current, added: current.added.filter((_, i) => i !== index) })); return }
    if (rowKey(sel.row) === undefined) { toast.warning(t.database.table.cannotDelete, hasPk ? t.database.table.pkIncomplete : t.database.table.noPk); return }
    setPending((current) => ({ ...current, removed: current.removed.includes(sel.row) ? current.removed.filter((item) => item !== sel.row) : [...current.removed, sel.row] }))
  }
  const changeSet = (): { inserts: Array<Record<string, string | null>>; updates: Array<{ key: Record<string, string | null>; set: Record<string, string | null> }>; deletes: Array<{ key: Record<string, string | null> }> } => {
    const numbered = (row: Record<number, string | null>): Record<string, string | null> => Object.fromEntries(Object.entries(row).map(([c, value]) => [String(page!.columns[Number(c)]!.attnum), value]))
    return {
      inserts: pending.added.map(numbered),
      updates: Object.entries(pending.edits).filter(([r]) => !pending.removed.includes(Number(r))).map(([r, row]) => ({ key: rowKey(Number(r))!, set: numbered(row) })),
      deletes: pending.removed.map((r) => ({ key: rowKey(r)! }))
    }
  }
  const apply = async (dryRun: boolean): Promise<void> => {
    if (!page || applying) return
    setApplying(true); const id = crypto.randomUUID()
    try {
      const result = await window.gearmod.invoke('db:apply', { connectionId, requestId: id, oid, dryRun, ...changeSet() })
      if (dryRun) { setPreview(result.sql); return }
      // The ref is also reset right away: otherwise the loadPage below still sees the pending changes and does not reload the grid.
      setPreview(undefined); setPending(noPending); pendingRef.current = noPending
      toast.success(t.database.table.applied, t.database.table.commandsSummary(result.sql.length, result.durationMs))
      if (result.counts.some((item) => item.rowCount === 0 && item.command !== 'INSERT')) toast.warning(t.database.table.rowsNotFound, t.database.table.rowsNotFoundText)
      void loadPage(offset, order, true)
    } catch (reason) { toast.error(t.database.table.cannotApply, plainError(reason)) } finally { setApplying(false) }
  }
  const keys = (event: React.KeyboardEvent): void => {
    if (isShortcut(event.nativeEvent, 'dbReload')) { event.preventDefault(); void loadPage(offset, order) }
    else if (isShortcut(event.nativeEvent, 'dbCancel')) { event.preventDefault(); req.cancel() }
    else if (event.altKey && event.key === 'Insert') { event.preventDefault(); addRow() }
  }
  const toolbar = <>
    <RefreshTools busy={busy} reload={(quiet) => void loadPage(offsetRef.current, orderRef.current, quiet)} cancel={req.cancel} />
    {allowWrite && <>
      <span className="db-tb-sep" aria-hidden="true" />
      <TbBtn label={t.database.table.addRow} keys="Alt+Insert" onClick={addRow}><path d="M8 3.500v9M3.500 8h9" /></TbBtn>
      <TbBtn label={t.database.table.deleteRow} disabled={!page || sel.mode === 'col' || sel.row >= gridRows.length} onClick={deleteRow}><path d="M3.500 8h9" /></TbBtn>
      <TbBtn label={t.database.table.undoPending} disabled={!hasPending} onClick={() => setPending(noPending)}><path d="M4 6.500h5.500a3 3 0 0 1 0 6H6M6.500 3.500 4 6.500l2.500 3" /></TbBtn>
      <TbBtn label={t.database.table.viewPendingSql} disabled={!hasPending || applying} onClick={() => void apply(true)}><path d="M1.500 8S3.800 3.500 8 3.500 14.500 8 14.500 8 12.200 12.500 8 12.500 1.500 8 1.500 8z" /><circle cx="8" cy="8" r="1.800" /></TbBtn>
      <TbBtn label={t.database.table.sendChanges} tone="ok" disabled={!hasPending || applying} onClick={() => void apply(false)}><path d="M8 12.500v-9M4.500 7 8 3.500 11.500 7" /></TbBtn>
    </>}
  </>
  return <div className="db-table-view" ref={root} onKeyDown={keys}>{askDialog}{pagerMenu && <DbContextMenu x={pagerMenu.x} y={pagerMenu.y} title={t.database.table.pagination} items={pagerItems} close={() => setPagerMenu(undefined)} />}
    
    {preview && <div className="overlay" role="dialog" aria-label={t.database.table.pendingChanges}><div className="modal"><header><div><div className="eyebrow">{t.database.title}</div><h2>{t.database.table.pendingChanges}</h2></div><button type="button" className="x" aria-label={t.common.close} onClick={() => setPreview(undefined)}>×</button></header><pre className="db-sql-preview">{preview.map((line) => `${line};`).join('\n')}</pre><footer className="dbfoot"><span className="grow1" /><button type="button" className="secondary" onClick={() => setPreview(undefined)}>{t.common.close}</button><button type="button" disabled={applying} onClick={() => void apply(false)}>{t.database.table.sendToDb}</button></footer></div></div>}
    {dialog && <DbInfoDialog kind={dialog} connectionId={connectionId} meta={meta} name={name} close={() => setDialog(undefined)} />}
    {req.error && <p className="error">{req.error}</p>}
    {busy && <p className="db-busy"><span className="db-spin" aria-hidden="true" />{t.database.table.running}</p>}
    {meta && <div className="db-filter"><ClauseInput caption="WHERE" label={t.database.table.whereLabel} placeholder={t.database.table.wherePlaceholder} value={whereText} onChange={setWhereText} onSubmit={applyClauses} suggestions={[...columnNames(meta.columns), ...whereWords]} /><ClauseInput caption="ORDER BY" label={t.database.table.orderLabel} placeholder={t.database.table.orderPlaceholder} value={orderText} onChange={setOrderText} onSubmit={applyClauses} suggestions={[...columnNames(meta.columns), ...orderWords]} /><span className="db-sqs">{(whereText || orderText || clauses.current.where || clauses.current.orderBy) && <SqBtn label={t.database.table.clearClauses} onClick={() => { setWhereText(''); setOrderText(''); clauses.current = { where: '', orderBy: '' }; void loadPage(0, order) }}><path d="M4 4l8 8M12 4l-8 8" /></SqBtn>}<SqBtn label={t.database.table.tableStructure} onClick={() => setDialog('structure')}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M6.5 6.5V13" /></SqBtn><SqBtn label={t.database.queryHistory} onClick={() => setDialog('history')}><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></SqBtn>{!allowWrite && <SqBtn label={t.database.readOnlyAbout} onClick={() => setDialog('readonly')}><circle cx="8" cy="8" r="5.5" /><path d="M8 7.2v3.6M8 5.2v.1" /></SqBtn>}</span></div>}
    {page && <><DbGrid columns={page.columns} rows={gridRows} toolbar={toolbar} edit={allowWrite ? editApi : undefined} onSelect={(row, col, mode) => setSel({ row, col, mode })} sorted={order[0] ? { index: page.columns.findIndex((col) => col.attnum === order[0]!.column), dir: order[0].dir } : null} order={(index) => { const col = page.columns[index]; if (!col) return; const old = order[0], next: Order = old?.column !== col.attnum ? [{ column: col.attnum, dir: 'asc' }] : old.dir === 'asc' ? [{ column: col.attnum, dir: 'desc' }] : []; setOrder(next); void loadPage(0, next) }} />
      <div className="db-pager float" role="group" aria-label={t.database.table.pagination}><button type="button" className="db-pg" data-tip={t.database.table.firstPage} aria-label={t.database.table.firstPage} disabled={busy || !offset} onClick={() => void loadPage(0, order)}><FirstPageIcon /></button><button type="button" className="db-pg" data-tip={t.database.table.prevPage} aria-label={t.database.table.prevPage} disabled={busy || !offset} onClick={() => void loadPage(Math.max(0, offset - pageSize), order)}><ChevronLeftIcon /></button><span className="db-pg-range" data-tip={exactCount !== undefined ? t.database.table.totalRows(exactCount) : undefined}>{offset + 1}–{offset + page.rows.length}{exactCount !== undefined ? t.database.table.ofTotal(exactCount) : meta?.estimatedTotal != null ? t.database.table.ofEstimated(meta.estimatedTotal) : ''}</span><button type="button" className="db-pg" data-tip={t.database.table.nextPage} aria-label={t.database.table.nextPage} disabled={busy || !page.hasMore} onClick={() => void loadPage(offset + pageSize, order)}><ChevronRightIcon /></button><button type="button" className="db-pg" data-tip={t.database.table.lastPage} aria-label={t.database.table.lastPage} disabled={busy || !page.hasMore} onClick={() => void goLast()}><LastPageIcon /></button><button type="button" className="db-pg" data-tip={t.database.table.moreOptions} aria-label={t.database.table.moreOptionsPager} aria-haspopup="menu" onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setPagerMenu({ x: box.left - 170, y: box.top - 230 }) }}>⋮</button>{offset > 100000 && <span className="db-warn">{t.database.table.farPageSlow}</span>}{(page.orderedBy === 'ctid' || page.orderedBy === 'none') && <span className="db-warn" data-tip={t.database.table.noPkTip}>{t.database.table.noPkBadge}</span>}</div></>}
  </div>
}
