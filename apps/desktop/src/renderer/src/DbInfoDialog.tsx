import React, { useEffect, useState } from 'react'
import type { IpcOutput } from '@gearmod/contracts'
import { plainError } from './NoticeDialog'
import { toast } from './toasts'
import { useEscape } from './useEscape'
import { dateLocale, useT } from './i18n'
import { ChevronRightSmallIcon } from './icons'

export type DbInfoKind = 'history' | 'structure' | 'readonly'

type HistoryEntry = IpcOutput<'db:history:list'>[number]
const oneLine = (text: string): string => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > 140 ? `${line.slice(0, 140)}…` : line }
const when = (at: string): string => new Date(at).toLocaleString(dateLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

/** One history query: summary line that, when opened, shows the whole SQL. */
function HistoryRow({ entry }: { entry: HistoryEntry }): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false), sql = entry.sql ?? ''
  return <div className={`db-hist${open ? ' open' : ''}`}>
    <button type="button" className="db-hist-line" aria-expanded={open} onClick={() => setOpen((value) => !value)} data-tip={open ? t.database.info.collapse : t.database.info.viewFullSql}>
      <span className={`wf-chevron ${open ? 'open' : ''}`} aria-hidden="true"><ChevronRightSmallIcon /></span>
      <span className={`db-hist-dot ${entry.status}`} role="img" aria-label={entry.status === 'ok' ? t.database.info.executed : t.database.info.withError} />
      <span className="db-hist-sql">{oneLine(sql || entry.summary)}</span>
      <span className="db-hist-meta">{when(entry.at)} · {entry.durationMs} ms</span>
    </button>
    {open && <div className="db-hist-full"><pre>{sql || entry.summary}</pre><button type="button" className="secondary" onClick={() => void navigator.clipboard.writeText(sql).then(() => toast.info(t.database.info.sqlCopied))}>{t.database.info.copySql}</button></div>}
  </div>
}

/** Connection info dialog: history, table structure and a read-only mode notice. */
export function DbInfoDialog({ kind, connectionId, meta, name, close }: { kind: DbInfoKind; connectionId: string; meta?: IpcOutput<'db:describe'>; name?: string; close(): void }): React.JSX.Element {
  const t = useT(), titles = t.database.info.titles
  const [history, setHistory] = useState<IpcOutput<'db:history:list'>>([]), [error, setError] = useState('')
  useEscape(close)
  useEffect(() => { if (kind !== 'history') return; void window.gearmod.invoke('db:history:list', { connectionId }).then(setHistory).catch((reason) => setError(plainError(reason))) }, [kind, connectionId])
  return <div className="overlay" role="dialog" aria-label={titles[kind]}><div className="modal dbdlg"><header><div><div className="eyebrow">{t.database.title}</div><h2>{kind === 'structure' ? t.database.info.structureOf(name) : titles[kind]}</h2></div><button type="button" className="x" aria-label={t.common.close} onClick={close}>×</button></header><div className="dbdlg-body">
    {error && <p className="error">{error}</p>}
    {kind === 'history' && <>{history.length === 0 && <p className="db-empty">{t.database.info.noQueries}</p>}{history.map((entry) => <HistoryRow key={entry.id} entry={entry} />)}</>}
    {kind === 'structure' && meta && meta.columns.map((column) => <div key={column.attnum} className="db-col"><b>{column.name}</b> · {column.typeSql} · {column.nullable ? t.database.info.acceptsNull : t.database.info.notNull}{column.primaryKey ? ` · ${t.database.info.primaryKey}` : ''}{column.comment && <p>{column.comment}</p>}{column.foreignKeys?.map((item, index) => <p key={`fk-${index}`}>{item}</p>)}{column.indexes?.map((item, index) => <p key={`idx-${index}`}>{item}</p>)}</div>)}
    {kind === 'readonly' && <><p>{t.database.info.readonlyText}</p><code>CREATE ROLE {t.database.info.readerRole} LOGIN;<br />GRANT CONNECT ON DATABASE {t.database.info.databaseName} TO {t.database.info.readerRole};<br />GRANT USAGE ON SCHEMA public TO {t.database.info.readerRole};<br />GRANT SELECT ON ALL TABLES IN SCHEMA public TO {t.database.info.readerRole};</code></>}
  </div>{kind === 'history' && <footer className="dbfoot"><span className="db-hint">{t.database.info.historyNote}</span><span className="grow1" /><button type="button" className="secondary" disabled={!history.length} onClick={() => void window.gearmod.invoke('db:history:clear', { connectionId }).then(() => setHistory([])).catch((reason) => setError(plainError(reason)))}>{t.database.info.clearHistory}</button></footer>}</div></div>
}
