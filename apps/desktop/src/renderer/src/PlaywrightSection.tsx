import React, { useEffect, useState } from 'react'
import { isOutdated, type PlaywrightStatus } from '@gearmod/contracts'
import { plainError } from './NoticeDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { MultiSelect } from './MultiSelect'
import { ProcessDialog } from './ProcessDialog'
import { tasks, useTasks } from './backgroundTasks'
import { Select } from './Select'
import { Checkbox } from './Checkbox'
import { useT } from './i18n'
import { TrashIcon } from './icons'
import { loadLatest } from './toolUpdates'

/** Playwright CLI: an app tool, in its own folder, with several versions and one chosen per project. */
export function PlaywrightSection({ projectId, enabled, toggle, latest }: { projectId: string; enabled: boolean; toggle(value: boolean): void; latest?: string | null }): React.JSX.Element {
  const t = useT(), tw = t.settings.playwright
  const [status, setStatus] = useState<PlaywrightStatus>(), [sources, setSources] = useState<Array<{ id: string; name: string; node: boolean }>>([]), [sourceId, setSourceId] = useState('')
  const [checkingLatest, setCheckingLatest] = useState(false), [version, setVersion] = useState(''), [browser, setBrowser] = useState(true), [skills, setSkills] = useState<Array<'claude' | 'agents'>>([])
  const [confirming, setConfirming] = useState(false), [removing, setRemoving] = useState<string>(), [downloading, setDownloading] = useState(false), [error, setError] = useState('')
  const [available, setAvailable] = useState<string[]>(), [pickError, setPickError] = useState(''), [processId, setProcessId] = useState<string>(), [processOpen, setProcessOpen] = useState(false)
  useEffect(() => {
    void window.gearmod.invoke('playwright:status', { projectId }).then(setStatus).catch((reason) => setError(plainError(reason)))
    void window.gearmod.invoke('playwright:sources', { projectId }).then((found) => { setSources(found); setSourceId((current) => current || found[0]?.id || '') }).catch(() => undefined)
  }, [projectId])
  useEffect(() => { setVersion((current) => current || latest || 'latest') }, [latest])
  // Tells the gear/tab dot (useToolsPending) that the version in use may have changed.
  useEffect(() => { if (status) window.dispatchEvent(new CustomEvent('gearmod:playwright-changed', { detail: projectId })) }, [projectId, status?.selected, status?.versions.length])
  const task = useTasks().find((item) => item.key === `playwright:${projectId}` && item.state === 'running'), busy = Boolean(task)
  // The dialog shows live progress (the main process log) and can be minimized: the installation continues in the background.
  useEffect(() => {
    if (!busy && !downloading) return
    const timer = window.setInterval(() => { void window.gearmod.invoke('playwright:status', { projectId }).then(setStatus).catch(() => undefined) }, 1500)
    return () => window.clearInterval(timer)
  }, [busy, downloading, projectId])
  // The step running now: the last "$ command" line of the log (each step writes it before it starts).
  const step = (status?.log ?? '').split('\n').map((line) => line.trim()).reverse().find((line) => line.startsWith('$ '))?.slice(2).trim()
  const act = async (call: () => Promise<PlaywrightStatus>): Promise<void> => { setError(''); try { setStatus(await call()) } catch (reason) { setError(plainError(reason)) } }
  const downloadBrowser = async (): Promise<void> => { setDownloading(true); await act(() => window.gearmod.invoke('playwright:install-browser', { projectId })); setDownloading(false) }
  /** The versions published on npm, newest first (also feeds the version menu). Loaded once per open; offline, the installed ones still show. */
  const loadVersions = async (): Promise<void> => {
    if (available && !pickError) return
    setPickError('')
    try { setAvailable(await window.gearmod.invoke('playwright:versions', undefined)) } catch (reason) { setPickError(plainError(reason)) }
  }
  const runInstall = (): void => {
    setConfirming(false); setError('')
    const wanted = version.trim() || 'latest'
    const { id, promise } = tasks.track({ key: `playwright:${projectId}`, title: tw.taskTitle, detail: wanted }, async () => {
      const result = await window.gearmod.invoke('playwright:install', { projectId, version: wanted, browser, skills, ...(skills.length && sourceId ? { sourceId } : {}) })
      setStatus(result)
      if (result.error) throw new Error(result.error)
      return result
    })
    setProcessId(id); setProcessOpen(true)
    void promise.catch(() => undefined)
  }
  // Another project may have already downloaded a newer version (the versions live in the app's folder, shared); here it only needs to be selected.
  const newerInstalled = status?.selected ? status.versions.map((item) => item.version).filter((item) => isOutdated(status.selected, item)).sort((a, b) => (isOutdated(a, b) ? -1 : 1)).pop() : undefined
  const nodeChip = status ? (status.node.system ? tw.nodeSystem(status.node.system.replace(/^v/, '')) : status.node.managed ? tw.nodeManaged(status.node.managed) : null) : null
  return <div className="cx-wfpanel">
    <section className="cx-wfcard tl-card">
    <header className="tl-head"><h4>{tw.title}</h4></header>
    {status ? <>
      <div className="tl-facts">
        {!nodeChip && <div className="tl-fact"><span className="tl-flabel">{tw.factNeeds}</span><div className="pw-chips"><span className="pw-chip warn" data-tip={tw.nodeTip}>{tw.nodeWillDownload}</span></div></div>}
        <div className="tl-fact"><span className="tl-flabel">{tw.factBrowser}</span><div className="pw-chips"><span className={`pw-chip ${status.browserReady ? 'ok' : 'warn'}`}>{status.browserReady ? <><i aria-hidden="true" />{tw.browserReady}</> : tw.browserNotReady}</span></div></div>
      </div>
      {status.versions.length > 0 && !status.browserReady && <div className="cx-note warn cx-browserrow"><span>{tw.browserMissing}</span><button type="button" className="mini" disabled={downloading || busy} onClick={() => void downloadBrowser()}>{downloading ? tw.downloading : tw.downloadBrowser}</button></div>}
      <h5 className="pw-subtitle pw-subtitle-row"><span>{tw.versionsTitle}</span>{!latest && <button type="button" className="linklike" disabled={checkingLatest} onClick={() => { setCheckingLatest(true); void loadLatest(true).catch(() => undefined).finally(() => setCheckingLatest(false)) }}>{checkingLatest ? tw.checkingVersion : tw.checkNewVersion}</button>}</h5>
      {status.versions.length ? (() => { const item = status.versions.find((entry) => entry.version === status.selected) ?? status.versions[0]!; return <ul className="pw-versions"><li key={item.version} className="on">
        {/* Only the version in use is shown; the installed ones are in the list that opens on click. */}
        <div className="pw-version-pick" data-tip={item.path}><VersionMenu current={item.version} selected={status.selected} installed={status.versions.map((entry) => entry.version)} available={available} error={pickError} disabled={busy} onOpen={() => void loadVersions()} onUse={(value) => { if (value !== item.version) void act(() => window.gearmod.invoke('playwright:select', { projectId, version: value })) }} onInstall={(value) => { setVersion(value); setConfirming(true) }} /></div>
        {item.version === status.selected && <span className="pw-chip ok"><i aria-hidden="true" />{tw.inUse}</span>}
        {item.version === status.selected && newerInstalled && <><span className="pw-chip warn"><i aria-hidden="true" />{tw.downloadedNewer(newerInstalled)}</span><button type="button" className="mini" disabled={busy} onClick={() => void act(() => window.gearmod.invoke('playwright:select', { projectId, version: newerInstalled }))}>{tw.useVersion(newerInstalled)}</button></>}
        {item.version === status.selected && !newerInstalled && latest && isOutdated(item.version, latest) && <><span className="pw-chip warn"><i aria-hidden="true" />{tw.newVersion(latest)}</span><button type="button" className="mini" disabled={busy} onClick={() => { setVersion(latest); setConfirming(true) }}>{tw.installVersion(latest)}</button></>}
        <span className="ch-spacer" />
        <button type="button" className="ibtn tip danger" data-tip={tw.removeVersion(item.version)} aria-label={tw.removeVersion(item.version)} disabled={busy} onClick={() => setRemoving(item.version)}><TrashIcon /></button>
      </li></ul> })() : <ul className="pw-versions"><li><div className="pw-version-pick"><VersionMenu selected={null} installed={[]} available={available} error={pickError} disabled={busy} onOpen={() => void loadVersions()} onUse={() => undefined} onInstall={(value) => { setVersion(value); setConfirming(true) }} /></div><span className="cx-muted">{tw.noVersions}</span></li></ul>}
      {(busy || downloading) && <div className="pw-progress" role="status" aria-live="polite">
        <div className="pw-progress-head"><span className="spin sm" /><b>{downloading ? tw.downloadingBrowser : tw.installing}</b>{step && <small className="pw-progress-step" data-tip={step}>{step}</small>}{busy && task && <button type="button" className="linklike" onClick={() => { setProcessId(task.id); setProcessOpen(true) }}>{tw.showLog}</button>}</div>
        <div className="bar"><i /></div>
      </div>}
      <div className="cx-offerrow pw-install-row">
        <label className="ck-line"><Checkbox checked={enabled} disabled={status.versions.length === 0} onChange={toggle} /> {tw.offer}</label>
      </div>
      {status.error && <div className="cx-error">{status.error}</div>}
    </> : <p className="cx-muted">{tw.checking}</p>}
    </section>
    {error && <div className="cx-error">{error}</div>}
    {confirming && <ConfirmDialog eyebrow="Playwright CLI" title={tw.confirmTitle} text={tw.confirmText} extra={<div className="pw-install">
      <div className="pw-plan"><span className="pw-planlabel">{tw.command}</span><code>npm install @playwright/cli@{version.trim() || 'latest'}</code><small>{tw.installIn(status?.toolsDir ?? '')}</small></div>
      <label className="ck-line"><Checkbox checked={browser} onChange={setBrowser} /><span className="t">{tw.downloadBrowserOption}<small>{tw.downloadBrowserHint}</small></span></label>
      <label className="f"><span>{tw.agentSkill}</span><MultiSelect label={tw.agentSkill} empty={tw.noSkill} value={skills} options={[{ value: 'claude', label: tw.optionClaude }, { value: 'agents', label: tw.optionCodex }]} onChange={(value) => setSkills(value as Array<'claude' | 'agents'>)} /></label>
      {skills.length > 0 && <><label className="f"><span>{tw.skillRepo}</span><Select label={tw.skillRepo} value={sourceId} options={sources.map((item) => ({ value: item.id, label: item.name, disabled: false }))} onChange={setSourceId} /></label><div className="pw-skillnote">{tw.skillNote}</div></>}
    </div>} ok={tw.install} okDisabled={skills.length > 0 && !sourceId} cancel={() => setConfirming(false)} confirm={() => runInstall()} />}
    {removing && <ConfirmDialog eyebrow="Playwright CLI" title={tw.removeTitle(removing)} text={tw.removeText} ok={tw.remove} danger cancel={() => setRemoving(undefined)} confirm={() => { const target = removing; setRemoving(undefined); void act(() => window.gearmod.invoke('playwright:remove', { projectId, version: target })) }} />}
    {processOpen && processId && <ProcessDialog taskId={processId} title={tw.processTitle} log={status?.log} background={() => setProcessOpen(false)} close={() => setProcessOpen(false)} />}
  </div>
}

const versionParts = (value: string): number[] => value.split('.').map((part) => Number.parseInt(part, 10) || 0)
const newerFirst = (a: string, b: string): number => { const left = versionParts(a), right = versionParts(b); for (let index = 0; index < 3; index++) { const diff = (right[index] ?? 0) - (left[index] ?? 0); if (diff) return diff } return 0 }

/**
 * The Playwright CLI versions in one list: every version published on npm (the newest first) plus the ones already installed. The one in use is painted
 * green, installed ones carry a check icon. Choosing an installed version uses it in this project; choosing one that is not installed starts its installation.
 */
function VersionMenu({ current, selected, installed, available, error, disabled, onOpen, onUse, onInstall }: { current?: string; selected: string | null; installed: string[]; available?: string[]; error: string; disabled: boolean; onOpen(): void; onUse(version: string): void; onInstall(version: string): void }): React.JSX.Element {
  const tw = useT().settings.playwright
  useEffect(() => { onOpen() }, [])
  const all = [...new Set([...(available ?? []), ...installed])].sort(newerFirst), newest = available?.[0]
  const options = all.map((version) => {
    const isInstalled = installed.includes(version)
    return { value: version, label: `v${version}`, highlight: version === selected, badge: <span className="pw-vm-chips">
      {version === newest && <span className="pw-chip">{tw.newest}</span>}
      {version === selected && <span className="pw-chip use">{tw.inUseShort}</span>}
      {isInstalled ? <svg className="pw-vm-ok" viewBox="0 0 24 24" aria-label={tw.installedTag} role="img"><title>{tw.installedTag}</title><path d="M5 12.5l4.5 4.5L19 7.5" /></svg> : <span className="pw-vm-install">{tw.installVersionShort}</span>}
    </span> }
  })
  return <div className="pw-vm">
    <Select label={tw.versionsTitle} value={current ?? selected ?? ''} disabled={disabled} menuWidth={360} options={options.length ? options : [{ value: '', label: tw.chooseVersion }]} onChange={(version) => { if (!version) return; if (installed.includes(version)) onUse(version); else onInstall(version) }} />
    {error && <small className="hint">{tw.versionsOffline}</small>}
  </div>
}
