import React, { useCallback, useEffect, useState } from 'react'
import type { StorageEntry, StorageKind, StorageSnapshot } from '@gearmod/contracts'
import { ConfirmDialog } from './ConfirmDialog'
import { Loading } from './Loading'
import { TrashIcon } from './icons'
import { dateLocale, useT } from './i18n'
import { plainError } from './NoticeDialog'
import { toast } from './toasts'

/** Human size ("2.4 GB"), with the decimal mark of the interface language. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${value.toLocaleString(dateLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[unit]}`
}

const groupOf: Record<StorageKind, 'playwright' | 'voice' | 'backups' | 'downloads' | 'data'> = {
  'playwright-version': 'playwright', 'playwright-browsers': 'playwright', node: 'playwright',
  'voice-model': 'voice', 'voice-engine': 'voice', backup: 'backups', 'update-download': 'downloads', worktrees: 'data', attachments: 'data', database: 'data'
}
const groupOrder = ['playwright', 'voice', 'backups', 'downloads', 'data'] as const

/** When a backup was made, read from its folder name (`upgrade-2026-11-06T19.32.33.411Z-ce0edf7d`); `undefined` for a name without it. */
export function backupDate(name: string): Date | undefined {
  const match = /(\d{4}-\d{2}-\d{2})T(\d{2})\.(\d{2})\.(\d{2})\.(\d{3})Z/.exec(name)
  if (!match) return undefined
  const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** Backups from the oldest to the newest (by the date in the name; a name without a date goes last). */
function sortBackups(entries: StorageEntry[]): StorageEntry[] {
  return [...entries].sort((a, b) => (backupDate(a.name)?.getTime() ?? Infinity) - (backupDate(b.name)?.getTime() ?? Infinity) || a.name.localeCompare(b.name))
}

/** Date and time of a backup, in the interface language ("6 de nov. de 2026, 16:32"). */
function formatDate(date: Date): string { return date.toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' }) }

/** Settings > Tools: what GearMod keeps on disk, how much space each thing takes, and a way to remove what is old or not needed. */
export function StoragePanel(): React.JSX.Element {
  const t = useT(), ts = t.settings.storage
  const [snapshot, setSnapshot] = useState<StorageSnapshot>(), [error, setError] = useState(''), [loading, setLoading] = useState(false), [removing, setRemoving] = useState<StorageEntry>(), [busy, setBusy] = useState(false)
  // `deleting`: ids being removed right now (their bar turns into a red running bar); `clearing`: asking to clear every backup.
  const [deleting, setDeleting] = useState<string[]>([]), [clearing, setClearing] = useState(false)
  const [done, setDone] = useState<{ cards: number; files: number; bytes: number }>({ cards: 0, files: 0, bytes: 0 }), [clearingDone, setClearingDone] = useState(false)
  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setError('')
    try { const [list, summary] = await Promise.all([window.gearmod.invoke('storage:list', undefined), window.gearmod.invoke('storage:card-attachments-done', undefined)]); setSnapshot(list); setDone(summary) } catch (reason) { setError(plainError(reason)) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  const remove = async (entry: StorageEntry): Promise<void> => {
    setRemoving(undefined); setBusy(true); setError(''); setDeleting([entry.id])
    try { setSnapshot(await window.gearmod.invoke('storage:remove', { id: entry.id })); toast.success(ts.removed(label(entry), formatBytes(entry.bytes))) } catch (reason) { setError(plainError(reason)) } finally { setBusy(false); setDeleting([]) }
  }
  /** Removes every backup, one at a time from the oldest, each with its red running bar until it is gone. Stops at the first one that fails. */
  const clearBackups = async (items: StorageEntry[]): Promise<void> => {
    setClearing(false); setBusy(true); setError(''); setDeleting(items.map((item) => item.id))
    let freed = 0, count = 0
    try {
      for (const item of items) {
        setSnapshot(await window.gearmod.invoke('storage:remove', { id: item.id }))
        freed += item.bytes; count += 1
        setDeleting((ids) => ids.filter((id) => id !== item.id))
      }
    } catch (reason) { setError(plainError(reason)) } finally {
      setBusy(false); setDeleting([])
      if (count) toast.success(ts.backupsCleared(count, formatBytes(freed)))
    }
  }
  /** Sends the attachment copies of every card in Done to the trash (the main process picks the cards; nothing from the screen decides it). */
  const clearDone = async (): Promise<void> => {
    setClearingDone(false); setBusy(true); setError('')
    try {
      const result = await window.gearmod.invoke('storage:clear-card-attachments-done', undefined)
      toast.success(ts.doneAttachmentsCleared(result.files, formatBytes(result.bytes), result.failed))
      await load()
    } catch (reason) { setError(plainError(reason)) } finally { setBusy(false) }
  }
  const backups = sortBackups(snapshot?.entries.filter((entry) => entry.kind === 'backup') ?? [])
  const label = (entry: StorageEntry): string => {
    switch (entry.kind) {
      case 'playwright-version': return ts.kinds.playwrightVersion(entry.name)
      case 'playwright-browsers': return ts.kinds.playwrightBrowsers
      case 'node': return ts.kinds.node
      case 'voice-model': return ts.kinds.voiceModel(entry.name)
      case 'voice-engine': return ts.kinds.voiceEngine
      case 'backup': { const date = backupDate(entry.name); return date ? ts.kinds.backup(formatDate(date)) : ts.kinds.backup(entry.name) }
      case 'update-download': return ts.kinds.updateDownload(entry.name)
      case 'worktrees': return ts.kinds.worktrees
      case 'attachments': return ts.kinds.attachments
      case 'database': return ts.kinds.database
    }
  }
  return <div className="stack storage">
    <div className="gacc-head"><div><div className="sectitle">{ts.title}</div><small className="hint">{ts.intro}</small></div>
      <button type="button" className="mini secondary" disabled={loading || busy} onClick={() => void load()}>{loading ? ts.measuring : ts.refresh}</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {!snapshot ? (error ? null : <Loading label={ts.measuringLabel} />) : <>
      <div className="storage-total"><span>{ts.total}</span><b>{formatBytes(snapshot.totalBytes)}</b></div>
      {groupOrder.map((group) => {
        const entries = group === 'backups' ? backups : snapshot.entries.filter((entry) => groupOf[entry.kind] === group)
        if (!entries.length) return null
        const sum = entries.reduce((total, entry) => total + entry.bytes, 0)
        return <section className="cx-wfcard storage-group" key={group}>
          <div className="storage-head"><h4>{ts.groups[group].title}<small className="cx-muted"> · {formatBytes(sum)}</small></h4>
            {group === 'backups' && <button type="button" className="mini secondary danger-text" disabled={busy} onClick={() => setClearing(true)}>{ts.clearBackups}</button>}</div>
          <p className="cx-muted">{ts.groups[group].text}</p>
          {group === 'data' && <div className="storage-done"><button type="button" className="mini secondary danger-text" disabled={busy || done.files === 0} onClick={() => setClearingDone(true)}>{ts.clearDoneAttachments}</button><small className="cx-muted">{done.files === 0 ? ts.clearDoneAttachmentsNone : ts.clearDoneAttachmentsInfo(done.cards, done.files, formatBytes(done.bytes))}</small></div>}
          <ul className="storage-list">{entries.map((entry) => <li key={entry.id}>
            <div className="storage-main">{entry.kind === 'backup' && backupDate(entry.name) ? <b>{ts.kinds.backupTitle}<span className="storage-date">{formatDate(backupDate(entry.name)!)}</span></b> : <b>{label(entry)}</b>}<small data-tip={entry.path}>{entry.path}</small>
              {deleting.includes(entry.id)
                ? <i className="storage-bar removing" role="progressbar" aria-label={ts.removing(label(entry))} data-tip={ts.removing(label(entry))}><span /></i>
                : <i className="storage-bar" aria-hidden="true" data-tip={ts.shareTip(Math.round((entry.bytes / Math.max(1, sum)) * 100), ts.groups[group].title)}><span style={{ width: `${Math.max(2, Math.round((entry.bytes / Math.max(1, sum)) * 100))}%` }} /></i>}</div>
            <span className="storage-size" data-tip={entry.partial ? ts.partialTip : undefined}>{entry.partial ? '≥ ' : ''}{formatBytes(entry.bytes)}</span>
            {entry.removable
              ? <button type="button" className="trashbtn tip" disabled={busy} data-tip={ts.removeTip(label(entry))} aria-label={ts.removeTip(label(entry))} onClick={() => setRemoving(entry)}><TrashIcon /></button>
              : <span className="storage-keep" data-tip={ts.keepTip}>{ts.keep}</span>}
          </li>)}</ul>
        </section>
      })}
    </>}
    {clearing && <ConfirmDialog eyebrow={ts.title} title={ts.clearBackupsTitle(backups.length)} text={ts.clearBackupsText(backups.length, formatBytes(backups.reduce((total, item) => total + item.bytes, 0)))} ok={ts.clearBackups} danger cancel={() => setClearing(false)} confirm={() => void clearBackups(backups)} />}
    {clearingDone && <ConfirmDialog eyebrow={ts.title} title={ts.clearDoneAttachmentsTitle} text={ts.clearDoneAttachmentsText(done.cards, done.files, formatBytes(done.bytes))} ok={ts.clearDoneAttachments} danger cancel={() => setClearingDone(false)} confirm={() => void clearDone()} />}
    {removing && <ConfirmDialog eyebrow={ts.title} title={ts.removeTitle(label(removing))} text={ts.removeText[removing.kind] ?? ''} ok={t.common.remove} danger cancel={() => setRemoving(undefined)} confirm={() => void remove(removing)} />}
  </div>
}
