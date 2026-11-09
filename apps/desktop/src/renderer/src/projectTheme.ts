import { themeRefSchema, type CustomTheme, type ThemeRef } from '@gearmod/contracts'
import { findCustomTheme } from './customTheme'

const key = (projectId: string): string => `gearmod.projectTheme.${projectId}`
export const projectThemeEvent = 'gearmod:project-theme'

/**
 * Theme chosen only for this project (null = follows the app theme). Saved on this computer, the same for everyone who uses the app here.
 * An invalid value, or a `custom:<id>` that no longer exists in `themes`, gives null.
 */
export function projectTheme(projectId: string | undefined, themes: readonly CustomTheme[] = []): ThemeRef | null {
  if (!projectId) return null
  try {
    const ref = themeRefSchema.safeParse(localStorage.getItem(key(projectId))).data ?? null
    if (ref?.startsWith('custom:') && !findCustomTheme(ref, themes)) return null
    return ref
  } catch { return null }
}

export function setProjectTheme(projectId: string, theme: ThemeRef | null): void {
  try { if (theme) localStorage.setItem(key(projectId), theme); else localStorage.removeItem(key(projectId)) } catch { /* only valid for this session */ }
  window.dispatchEvent(new Event(projectThemeEvent))
}
