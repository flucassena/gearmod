import { isOutdated, type SpecKitCompat } from '@gearmod/contracts'

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

const failedKey = 'gearmod.specKit.incompatibleVersions'
/** Versions whose local probe failed on this machine (the CI verdict, when it exists, wins over this). */
export function incompatibleSpecKitVersions(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(failedKey) ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] } catch { return [] }
}
export function rememberIncompatibleSpecKit(version: string): void {
  try { localStorage.setItem(failedKey, JSON.stringify([...new Set([...incompatibleSpecKitVersions(), version])].slice(-20))) } catch { /* the probe just runs again */ }
}

export interface SpecKitVerdict { state: 'verified' | 'incompatible' | 'unknown'; issues: Array<{ severity: 'error' | 'warning'; detail: string }> }
/** What is known about a Spec Kit version: the CI verdict first, then what this machine's own probe found; otherwise nothing yet. */
export function specKitVerdict(version: string | null, compat: SpecKitCompat | undefined): SpecKitVerdict {
  if (!version) return { state: 'unknown', issues: [] }
  const entry = compat?.versions[version]
  if (entry) return { state: entry.ok ? 'verified' : 'incompatible', issues: entry.issues }
  if (verifiedSpecKitVersions().includes(version)) return { state: 'verified', issues: [] }
  if (incompatibleSpecKitVersions().includes(version)) return { state: 'incompatible', issues: [] }
  return { state: 'unknown', issues: [] }
}
