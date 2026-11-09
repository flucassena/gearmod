import React, { useCallback, useEffect, useState } from 'react'
import type { StorageEntry, StorageKind, StorageSnapshot } from '@gearmod/contracts'
import { ConfirmDialog } from './ConfirmDialog'
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

/** Settings > Tools: what GearMod keeps on disk, how much space each thing takes, and a way to remove what is old or not needed. */
export function StoragePanel(): React.JSX.Element {
  const t = useT(), ts = t.settings.storage
  const [snapshot, setSnapshot] = useState<StorageSnapshot>(), [error, setError] = useState(''), [loading, setLoading] = useState(false), [removing, setRemoving] = useState<StorageEntry>(), [busy, setBusy] = useState(false)
  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setError('')
    try { setSnapshot(await window.gearmod.invoke('storage:list', undefined)) } catch (reason) { setError(plainError(reason)) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  const remove = async (entry: StorageEntry): Promise<void> => {
    setRemoving(undefined); setBusy(true); setError('')
    try { setSnapshot(await window.gearmod.invoke('storage:remove', { id: entry.id })); toast.success(ts.removed(label(entry), formatBytes(entry.bytes))) } catch (reason) { setError(plainError(reason)) } finally { setBusy(false) }
  }
  const label = (entry: StorageEntry): string => {
    switch (entry.kind) {
      case 'playwright-version': return ts.kinds.playwrightVersion(entry.name)
      case 'playwright-browsers': return ts.kinds.playwrightBrowsers
      case 'node': return ts.kinds.node
      case 'voice-model': return ts.kinds.voiceModel(entry.name)
      case 'voice-engine': return ts.kinds.voiceEngine
      case 'backup': return ts.kinds.backup(entry.name)
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
    {!snapshot ? <small className="hint">{ts.measuring}</small> : <>
      <div className="storage-total"><span>{ts.total}</span><b>{formatBytes(snapshot.totalBytes)}</b></div>
      {groupOrder.map((group) => {
        const entries = snapshot.entries.filter((entry) => groupOf[entry.kind] === group)
        if (!entries.length) return null
        const sum = entries.reduce((total, entry) => total + entry.bytes, 0)
        return <section className="cx-wfcard storage-group" key={group}>
          <h4>{ts.groups[group].title}<small className="cx-muted"> · {formatBytes(sum)}</small></h4>
          <p className="cx-muted">{ts.groups[group].text}</p>
          <ul className="storage-list">{entries.map((entry) => <li key={entry.id}>
            <div className="storage-main"><b>{label(entry)}</b><small data-tip={entry.path}>{entry.path}</small>
              <i className="storage-bar" aria-hidden="true" data-tip={ts.shareTip(Math.round((entry.bytes / Math.max(1, sum)) * 100), ts.groups[group].title)}><span style={{ width: `${Math.max(2, Math.round((entry.bytes / Math.max(1, sum)) * 100))}%` }} /></i></div>
            <span className="storage-size" data-tip={entry.partial ? ts.partialTip : undefined}>{entry.partial ? '≥ ' : ''}{formatBytes(entry.bytes)}</span>
            {entry.removable
              ? <button type="button" className="trashbtn tip" disabled={busy} data-tip={ts.removeTip(label(entry))} aria-label={ts.removeTip(label(entry))} onClick={() => setRemoving(entry)}><TrashIcon /></button>
              : <span className="storage-keep" data-tip={ts.keepTip}>{ts.keep}</span>}
          </li>)}</ul>
        </section>
      })}
    </>}
    {removing && <ConfirmDialog eyebrow={ts.title} title={ts.removeTitle(label(removing))} text={ts.removeText[removing.kind] ?? ''} ok={t.common.remove} danger cancel={() => setRemoving(undefined)} confirm={() => void remove(removing)} />}
  </div>
}
