import React, { useEffect, useSyncExternalStore } from 'react'
import type { AppUpdate } from '@gearmod/contracts'
import { useT } from './i18n'
import { useEscape } from './useEscape'

/** State of the app's own update, shared by the sidebar (the dot) and the About tab. It is fed by the main process through push events. */
let state: AppUpdate | undefined
let started = false
const listeners = new Set<() => void>()
const set = (next: AppUpdate): void => { state = next; for (const listener of listeners) listener() }
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

function start(): void {
  if (started) return
  started = true
  window.gearmod.onRunEvent((event) => { if (event.eventType === 'gearmod/app-update') set(event.payload as unknown as AppUpdate) })
  void window.gearmod.invoke('updates:state', undefined).then(set).catch(() => undefined)
}

export function useAppUpdate(): AppUpdate | undefined {
  useEffect(start, [])
  return useSyncExternalStore(subscribe, () => state, () => undefined)
}

export const checkAppUpdate = (): Promise<void> => window.gearmod.invoke('updates:check', undefined).then(set)
export const installAppUpdate = (): Promise<void> => window.gearmod.invoke('updates:install', undefined).then(set)
export const downloadAppUpdate = (): Promise<void> => window.gearmod.invoke('updates:download', undefined).then(set)

/** Versions whose "ready to install" pop-up the user answered with "Later" in this session; the About tab still offers to install them. */
const postponed = new Set<string>()
const postponedListeners = new Set<() => void>()
let postponedVersion = 0
export const postponeAppUpdate = (version: string): void => { postponed.add(version); postponedVersion++; for (const listener of postponedListeners) listener() }

/** The pop-up shows once the installer of a new version is downloaded, until the user installs it or picks "Later". */
export function UpdateReadyPrompt(): React.JSX.Element | null {
  const update = useAppUpdate()
  useSyncExternalStore((listener) => { postponedListeners.add(listener); return () => { postponedListeners.delete(listener) } }, () => postponedVersion)
  const t = useT(), ta = t.settings.about
  const latest = update?.ready && !update.installing && update.latest && !postponed.has(update.latest) ? update.latest : null
  useEscape(() => { if (latest) postponeAppUpdate(latest) }, Boolean(latest))
  if (!latest) return null
  return <div className="overlay top" role="alertdialog" aria-label={ta.readyTitle(latest)}><div className="modal" style={{ width: 'min(460px,100%)' }}>
    <header><div><div className="eyebrow">{ta.confirmEyebrow}</div><h2>{ta.readyTitle(latest)}</h2></div></header>
    <p className="dialog-text">{ta.readyText}</p>
    <div className="actions"><button type="button" className="secondary" onClick={() => postponeAppUpdate(latest)}>{ta.later}</button><button type="button" autoFocus onClick={() => void installAppUpdate()}>{ta.installNow}</button></div>
  </div></div>
}
