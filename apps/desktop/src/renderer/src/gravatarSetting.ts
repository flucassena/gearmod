import { useEffect, useState } from 'react'

/** Opt-in (Settings → General): without it no email hash leaves the app. The value is cached; the settings screen updates it when it changes. */
let enabled: Promise<boolean> | null = null
export function setGravatarEnabled(value: boolean): void { enabled = Promise.resolve(value) }
export function gravatarEnabled(): Promise<boolean> {
  enabled ??= window.gearmod.invoke('settings:get', undefined).then((settings) => settings.fotosGravatar).catch(() => false)
  return enabled
}

/** Author photo from Gravatar (the same service GitKraken uses): only the email hash leaves the app; with no registered photo, the initials stay. */
const gravatars = new Map<string, Promise<string | null>>()
function gravatarUrl(email: string): Promise<string | null> {
  const key = email.trim().toLowerCase()
  if (!key || !globalThis.crypto?.subtle) return Promise.resolve(null)
  let found = gravatars.get(key)
  if (!found) {
    found = crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)).then((buffer) => {
      const hash = Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')
      const url = `https://gravatar.com/avatar/${hash}?s=64&d=404`
      return new Promise<string | null>((resolve) => { const image = new Image(); image.onload = () => resolve(url); image.onerror = () => resolve(null); image.src = url })
    }).catch(() => null)
    gravatars.set(key, found)
  }
  return found
}
/** Whether people's photos may show (the same opt-in: the host's avatar of a GitLab user is often a Gravatar too). */
export function usePhotosOn(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => { let alive = true; void gravatarEnabled().then((value) => { if (alive) setOn(value) }); return () => { alive = false } }, [])
  return on
}
/** The photo URL of an email when the setting is on and Gravatar has one; null otherwise. */
export function useGravatar(email: string): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true; setUrl(null)
    void gravatarEnabled().then((enabled) => enabled ? gravatarUrl(email) : null).then((value) => { if (alive) setUrl(value) })
    return () => { alive = false }
  }, [email])
  return url
}
