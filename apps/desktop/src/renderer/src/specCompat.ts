import { useEffect, useState } from 'react'
import type { SpecKitCompat } from '@gearmod/contracts'

let last: SpecKitCompat | undefined
let loading: Promise<void> | null = null
const listeners = new Set<(value: SpecKitCompat) => void>()

/** Verdicts the CI job published for Spec Kit versions (read by the main process at most once an hour); undefined until the first answer, and it stays undefined offline. */
function load(): void {
  if (loading) return
  loading = window.gearmod.invoke('tools:spec-compat', undefined).then((value) => { last = value; listeners.forEach((listener) => listener(value)) }).catch(() => undefined).finally(() => { loading = null })
}
export function useSpecCompat(): SpecKitCompat | undefined {
  const [value, setValue] = useState(last)
  useEffect(() => { listeners.add(setValue); load(); return () => { listeners.delete(setValue) } }, [])
  return value
}
