import type { CustomTheme, ThemeRef } from '@gearmod/contracts'

export const accentVarNames = ['--accent', '--accent-strong', '--accent-muted', '--accent-bg', '--accent-line', '--accent-deep', '--accent-glow'] as const
export type AccentVars = Record<(typeof accentVarNames)[number], string>

export const maxCustomThemes = 20
export const customRef = (id: string): string => `custom:${id}`
export const newThemeId = (): string => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** Custom theme pointed to by `custom:<id>`; `undefined` when the reference is a preset or the theme no longer exists. */
export function findCustomTheme(ref: ThemeRef | null | undefined, themes: readonly CustomTheme[]): CustomTheme | undefined {
  if (!ref || !ref.startsWith('custom:')) return undefined
  return themes.find((theme) => customRef(theme.id) === ref)
}

type Hsl = [number, number, number]
const clamp = (value: number): number => Math.min(1, Math.max(0, value))
function toHsl(hex: string): Hsl {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}
function toHex([h, s, l]: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return '#' + [r, g, b].map((v) => Math.round(clamp(v + m) * 255).toString(16).padStart(2, '0')).join('')
}

/** The 7 `--accent*` variables from the chosen color and the mode. Pure and deterministic. */
export function deriveAccentVars(color: string, mode: 'light' | 'dark'): AccentVars {
  const [h, s, l] = toHsl(color.toLowerCase())
  const dark = mode === 'dark'
  return {
    '--accent': color.toLowerCase(),
    '--accent-strong': toHex([h, s, dark ? l + (1 - l) * 0.3 : l * 0.7]),
    '--accent-muted': toHex([h, s * 0.6, dark ? l * 0.9 : l + (1 - l) * 0.2]),
    '--accent-bg': toHex([h, s * 0.4, dark ? 0.2 : 0.92]),
    '--accent-line': toHex([h, s * 0.45, dark ? 0.3 : 0.77]),
    '--accent-deep': toHex([h, s * 0.4, dark ? 0.13 : 0.95]),
    '--accent-glow': toHex([h, s * 0.45, dark ? 0.17 : 0.9])
  }
}

type StyleLike = { setProperty(name: string, value: string): void; removeProperty(name: string): void }
export type ThemeRoot = { dataset: Record<string, string | undefined>; style: StyleLike }

/**
 * Applies a theme reference to a root (the `<html>`). Preset: sets `data-accent` and removes the inline variables of a previous custom theme.
 * Custom: sets `data-accent="custom"`, the mode and the 7 variables inline. Returns whether the theme is light (for the title bar).
 */
export function applyThemeToRoot(root: ThemeRoot, ref: ThemeRef, themes: readonly CustomTheme[]): boolean {
  const custom = findCustomTheme(ref, themes)
  if (custom) {
    const vars = deriveAccentVars(custom.cor, custom.modo)
    root.dataset.accent = 'custom'
    root.dataset.theme = custom.modo
    for (const name of accentVarNames) root.style.setProperty(name, vars[name])
    return custom.modo === 'light'
  }
  for (const name of accentVarNames) root.style.removeProperty(name)
  const preset = ref.startsWith('custom:') ? 'green' : ref
  const light = preset.startsWith('light-')
  root.dataset.accent = preset
  root.dataset.theme = light ? 'light' : 'dark'
  return light
}
