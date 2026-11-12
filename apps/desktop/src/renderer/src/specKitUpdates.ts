import { isOutdated } from '@gearmod/contracts'

// Last version reviewed by hand (v1.3.2, 6 Nov 2026); used for a first install. Updating no longer depends on it: before any update the app runs the
// compatibility probe (see `SpecToolsService.probe`), which initializes the candidate version in a throwaway folder and checks what GearMod relies on.
export const specKitBaseline = '1.3.2'
export const specKitInstallCommand = (version: string): string => `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v${version}`

export function specKitUpdateState(installed: string | null, latest: string | null): { canUpdate: boolean } {
  const valid = (value: string | null): value is string => value !== null && /^\d+\.\d+\.\d+$/.test(value)
  return { canUpdate: valid(installed) && valid(latest) && isOutdated(installed, latest) }
}

const verifiedKey = 'gearmod.specKit.verifiedVersions'
/** Versions whose probe passed on this machine, so the update button does not repeat it. Only a convenience: it is fine if the storage is unavailable. */
export function verifiedSpecKitVersions(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(verifiedKey) ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] } catch { return [] }
}
export function rememberVerifiedSpecKit(version: string): void {
  try { localStorage.setItem(verifiedKey, JSON.stringify([...new Set([...verifiedSpecKitVersions(), version])].slice(-20))) } catch { /* no storage: the probe just runs again next time */ }
}
