import React, { useEffect, useState } from 'react'
import type { AppAbout } from '@gearmod/contracts'
import { checkAppUpdate, installAppUpdate, useAppUpdate } from './appUpdate'
import { ConfirmDialog } from './ConfirmDialog'
import { dateLocale, useT } from './i18n'
import { BranchIcon } from './icons'
import { Markdown } from './markdown'
import { BrandMark } from './Thinking'
import logo from './assets/logo.png'

/** "About" tab: the app's identity and runtime (like an IDE's About box), the update check, what came in the latest release and who made the app. */
export function AboutPanel(): React.JSX.Element {
  const t = useT(), ta = t.settings.about
  const update = useAppUpdate(), [about, setAbout] = useState<AppAbout>(), [confirming, setConfirming] = useState(false), [copied, setCopied] = useState<'info' | 'command'>()
  useEffect(() => { void window.gearmod.invoke('app:about', undefined).then(setAbout).catch(() => undefined) }, [])
  const open = (url: string): void => { void window.gearmod.invoke('app:open-link', { url }).catch(() => undefined) }
  const copy = (text: string, what: 'info' | 'command'): void => { void navigator.clipboard.writeText(text).then(() => { setCopied(what); window.setTimeout(() => setCopied(undefined), 1800) }).catch(() => undefined) }
  const busy = Boolean(update?.checking || update?.installing)
  const percent = Math.round((update?.progress ?? 0) * 100)
  const error = update?.error ? ta.errors[update.error] ?? update.error : ''
  const built = about?.buildDate ? new Date(about.buildDate).toLocaleString(dateLocale(), { dateStyle: 'long', timeStyle: 'short' }) : ''
  // Neutral text (not translated) so that it can be pasted in a bug report.
  const infoText = about ? [`${about.name} ${about.version}`, about.buildDate ? `Build: ${about.buildDate}` : '', `Electron: ${about.electron}`, `Chromium: ${about.chromium}`, `Node.js: ${about.node}`, `V8: ${about.v8}`, `OS: ${about.system}`, `Data: ${about.dataDir}`].filter(Boolean).join('\n') : ''
  return <div className="stack about">
    <section className="cx-wfcard about-id">
      <div className="about-head"><BrandMark src={logo} size={64} className="about-logo" /><div>
        <h3>{about?.name ?? 'GearMod'} {about?.version ?? update?.current ?? ''}</h3>
        {built && <p>{ta.builtOn(built)}</p>}
        {about && <p>{ta.license}: {about.license}</p>}
      </div></div>
      {about && <dl className="about-facts">
        <dt>{ta.runtime}</dt><dd>Electron {about.electron} · Chromium {about.chromium} · Node.js {about.node} · V8 {about.v8}</dd>
        <dt>{ta.system}</dt><dd>{about.system}</dd>
        <dt>{ta.dataFolder}</dt><dd className="about-path">{about.dataDir}</dd>
      </dl>}
      <p className="about-oss">{ta.poweredBy} <a href={`${about?.homepage ?? ''}/blob/main/THIRD-PARTY-NOTICES.md`} onClick={(event) => { event.preventDefault(); if (about) open(`${about.homepage}/blob/main/THIRD-PARTY-NOTICES.md`) }}>{ta.openSource}</a><br />{ta.copyright(new Date().getFullYear(), about?.author ?? '')}</p>
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="secondary" disabled={!about} onClick={() => copy(infoText, 'info')}>{copied === 'info' ? ta.copied : ta.copyInfo}</button>
      </div>
    </section>
    <section className="cx-wfcard">
      <div className="about-status" role="status">
        {update?.available && update.latest ? <b>{ta.available(update.latest)}</b> : update?.checkedAt ? <span>{ta.upToDate}</span> : null}
        {update?.checkedAt && <small className="hint">{ta.lastChecked(new Date(update.checkedAt).toLocaleString(dateLocale()))}</small>}
      </div>
      {update?.installing && <div className="about-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${percent}%` }} /><span>{ta.downloading(percent)}</span></div>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="secondary" disabled={busy} onClick={() => void checkAppUpdate()}>{update?.checking ? ta.checking : ta.checkNow}</button>
        {update?.available && update.canInstall && <button type="button" disabled={busy} onClick={() => setConfirming(true)}>{ta.install}</button>}
        {update?.available && <button type="button" className={update.canInstall ? 'secondary' : undefined} onClick={() => open(update.url)}>{ta.openRelease}</button>}
      </div>
      {update?.available && update.manualCommand && <div className="about-command"><small className="hint">{ta.manualHint}</small><div><code>{update.manualCommand}</code><button type="button" className="mini secondary" onClick={() => copy(update.manualCommand!, 'command')}>{copied === 'command' ? ta.copied : ta.copyCommand}</button></div></div>}
    </section>
    {update?.available && update.latest && <section className="cx-wfcard">
      <h4>{ta.whatsNew(update.latest)}</h4>
      <div className="md about-notes">{update.notes.trim() ? <Markdown source={update.notes} runnable={false} /> : <p className="hint">{ta.noNotes}</p>}</div>
    </section>}
    <section className="cx-wfcard about-credits">
      <p><span className="sectitle">{ta.developedBy}</span><br /><b>{about?.author ?? ''}</b>{about?.authorEmail && <> · <a href={`mailto:${about.authorEmail}`} onClick={(event) => { event.preventDefault(); open(`mailto:${about.authorEmail}`) }}>{about.authorEmail}</a></>}</p>
      {about?.homepage && <div className="actions" style={{ justifyContent: 'flex-start', margin: 0 }}><button type="button" className="secondary withicon" onClick={() => open(about.homepage)}><BranchIcon />{ta.viewRepository}</button></div>}
    </section>
    {confirming && update?.latest && <ConfirmDialog eyebrow={ta.confirmEyebrow} title={ta.confirmTitle(update.latest)} text={ta.confirmText} ok={ta.confirmOk} cancel={() => setConfirming(false)} confirm={() => { setConfirming(false); void installAppUpdate() }} />}
  </div>
}
