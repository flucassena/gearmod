import React, { useEffect, useMemo, useRef, useState } from 'react'
import { isShortcut } from './shortcuts'
import { Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { destructiveStatements, type DestructiveStatement, type IpcOutput } from '@gearmod/contracts'
import { ConfirmDialog } from './ConfirmDialog'
import { plainError } from './NoticeDialog'
import { CodeEditor } from './editor/CodeEditor'
import { DbGrid } from './DbGrid'
import { RefreshTools } from './DbGridTools'
import { DbInfoDialog, type DbInfoKind } from './DbInfoDialog'
import { SqBtn } from './DbTableView'
import { useDbRequest } from './DbRequest'
import { Select } from './Select'
import { useAsk } from './useAsk'
import { dateLocale, useT } from './i18n'

/** SQL query window: editor on top, result below, with its own state. */
export function DbSqlView({ connectionId, databases, setConnection, allowWrite, production = false, database = '', sql, setSql }: { connectionId: string; databases: Array<{ value: string; label: string }>; setConnection(id: string): void; allowWrite: boolean; production?: boolean; database?: string; sql: string; setSql(value: string): void }): React.JSX.Element {
  const t = useT()
  const req = useDbRequest(connectionId), [result, setResult] = useState<IpcOutput<'db:query:run'>>(), [dialog, setDialog] = useState<DbInfoKind>(), [ran, setRan] = useState(''), [sort, setSort] = useState<{ index: number; dir: 'asc' | 'desc' } | null>(null)
  const [height, setHeight] = useState(() => { try { return Number(localStorage.getItem('gearmod.db.sqlHeight')) || 220 } catch { return 220 } })
  const box = useRef<HTMLDivElement>(null), execute = useRef<() => void>(() => undefined), cancel = useRef<() => void>(() => undefined)
  const keys = useMemo(() => [Prec.high(keymap.of([{ key: 'Mod-Enter', run: () => { execute.current(); return true } }, { key: 'Escape', run: () => { cancel.current(); return true } }]))], [])
  const [danger, setDanger] = useState<{ text: string; found: DestructiveStatement[] }>(), [typed, setTyped] = useState('')
  const execSql = async (text: string, confirmDestructive?: string): Promise<void> => { const id = req.start(); try { const output = await window.gearmod.invoke('db:query:run', { connectionId, requestId: id, sql: text, limit: 1000, ...(confirmDestructive ? { confirmDestructive } : {}) }); if (req.current(id)) { setResult(output); setRan(text); setSort(null) } } catch (reason) { if (req.current(id)) req.setError(plainError(reason)) } finally { req.finish(id) } }
  // With writing enabled, DROP/TRUNCATE/ALTER ... DROP and DELETE/UPDATE without WHERE ask for confirmation; in production, by typing the database name.
  const run = async (text = sql): Promise<void> => {
    const found = allowWrite ? destructiveStatements(text) : []
    if (found.length) { setTyped(''); setDanger({ text, found }); return }
    await execSql(text)
  }
  const confirmDanger = (): void => { if (!danger) return; const text = danger.text; setDanger(undefined); void execSql(text, production ? typed : database) }
  execute.current = () => { if (!req.busy && sql.trim()) void run() }
  cancel.current = req.cancel
  const startDrag = (event: React.PointerEvent): void => {
    event.preventDefault(); const startY = event.clientY, start = height, limit = Math.max(120, (box.current?.clientHeight ?? 600) - 120); let last = start
    const move = (item: PointerEvent): void => { last = Math.max(90, Math.min(limit, start + item.clientY - startY)); setHeight(last) }
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); try { localStorage.setItem('gearmod.db.sqlHeight', String(last)) } catch { /* local preference */ } }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  // Each tab runs on the database chosen in it; when switching database the previous result stops being valid.
  useEffect(() => { setResult(undefined); setRan(''); setSort(null); req.setError(''); setDanger(undefined) }, [connectionId])
  const shown = Boolean(result || req.error)
  const readOnlySql = (text: string): boolean => /^\s*(select|table|values|show|explain)\b/i.test(text) || (/^\s*with\b/i.test(text) && !/\b(insert|update|delete|merge)\b/i.test(text))
  // Same sorting as the table grid, done in the browser over the rows already fetched (the user's SQL is not rewritten).
  const rows = result ? (sort ? [...result.rows].sort((x, y) => {
    const a = x[sort.index]?.t ?? null, b = y[sort.index]?.t ?? null
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
    const na = Number(a), nb = Number(b), order = a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.localeCompare(b, dateLocale(), { numeric: true })
    return sort.dir === 'asc' ? order : -order
  }) : result.rows) : []
  const { ask, dialog: askDialog } = useAsk()
  const reload = (quiet: boolean): void => {
    if (req.busy || !ran.trim()) return
    if (readOnlySql(ran)) { void run(ran); return }
    if (quiet) return
    if (allowWrite && destructiveStatements(ran).length) { void run(ran); return }
    void ask({ eyebrow: t.database.sql.runSql, title: t.database.sql.runAgain, text: t.database.sql.mayChange, ok: t.database.sql.run, danger: true }).then((yes) => { if (yes) void run(ran) })
  }
  const toolbar = <RefreshTools busy={req.busy} reload={reload} cancel={req.cancel} autoBlocked={ran && !readOnlySql(ran) ? t.database.sql.autoReadOnly : undefined} />
  const dangerDialog = danger && <ConfirmDialog eyebrow={t.database.sql.runSql} title={t.database.sql.destructiveTitle} text={production ? `${t.database.sql.destructiveText} ${t.database.sql.destructiveProd(database)}` : t.database.sql.destructiveText} ok={t.database.sql.runAnyway} danger okDisabled={production && typed !== database}
    extra={<><pre className="qpre">{danger.found.map((item) => `-- ${t.database.sql.destructiveKinds[item.kind]}\n${item.sql}`).join('\n\n')}</pre>{production && <label className="f">{t.database.sql.databaseName}<input className="in" autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && typed === database) confirmDanger() }} /></label>}</>}
    cancel={() => setDanger(undefined)} confirm={confirmDanger} />
  // Ctrl+F2 cancels from anywhere in the console (editor, buttons or result).
  return <div className="db-split" ref={box} onKeyDown={(event) => { if (isShortcut(event.nativeEvent, 'dbCancel')) { event.preventDefault(); req.cancel() } }}>{askDialog}{dangerDialog}{dialog && <DbInfoDialog kind={dialog} connectionId={connectionId} close={() => setDialog(undefined)} />}
    <div className="db-sql-panel" style={shown ? { flexBasis: height } : { flex: '1 1 auto' }}><div className="db-sql-bar"><button type="button" className="db-run" disabled={req.busy || !sql.trim()} onClick={() => void run()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" /></svg>{t.database.sql.runSql}</button>{databases.length > 0 && <Select label={t.database.sql.queryDatabase} className="db-sql-db" value={connectionId} options={databases} onChange={setConnection} />}<span className="db-sql-mode">{allowWrite ? t.database.sql.writeEnabled : t.database.sql.readOnlyMode}</span><kbd>Ctrl+Enter</kbd><span className="db-sqs"><SqBtn label={t.database.queryHistory} onClick={() => setDialog('history')}><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></SqBtn>{!allowWrite && <SqBtn label={t.database.readOnlyAbout} onClick={() => setDialog('readonly')}><circle cx="8" cy="8" r="5.5" /><path d="M8 7.2v3.6M8 5.2v.1" /></SqBtn>}</span></div>
      <div className="db-sql-editor"><CodeEditor path="consulta.sql" ariaLabel={t.database.sql.editorAria} value={sql} onChange={setSql} options={{ wrap: false, tabSize: 2, indentWithTab: false, whitespace: false, guides: false, scrollPastEnd: false }} extensions={keys} /></div></div>
    {shown && <><div className="db-splitter" role="separator" aria-orientation="horizontal" data-tip={t.database.dragToResize} onPointerDown={startDrag} />
      <div className="db-result" onKeyDown={(event) => { if (isShortcut(event.nativeEvent, 'dbReload')) { event.preventDefault(); reload(false) } }}>{req.error && <p className="error">{req.error}</p>}{result && <><div className="db-result-head"><span className="db-chip">{result.durationMs} ms</span><span className="db-chip">{t.database.sql.rows(result.rows.length, Boolean(result.truncated))}</span>{result.commands.map((item, index) => <span className="db-chip" key={index}>{t.database.sql.commandRows(item.command, String(item.rowCount ?? '—'))}</span>)}</div><DbGrid columns={result.columns.map((name) => ({ name, type: '' }))} rows={rows} toolbar={toolbar} sorted={sort} order={(index) => setSort((current) => current?.index !== index ? { index, dir: 'asc' } : current.dir === 'asc' ? { index, dir: 'desc' } : null)} /></>}</div></>}</div>
}
