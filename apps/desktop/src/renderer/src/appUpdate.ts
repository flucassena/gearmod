import { useEffect, useSyncExternalStore } from 'react'
import type { AppUpdate } from '@gearmod/contracts'

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
