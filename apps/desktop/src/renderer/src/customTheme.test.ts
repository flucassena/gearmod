import { describe, expect, it } from 'vitest'
import { accentVarNames, applyThemeToRoot, deriveAccentVars, findCustomTheme, type ThemeRoot } from './customTheme'

const lum = (hex: string): number => { const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); return (Math.max(...n) + Math.min(...n)) / 2 }
const fakeRoot = (): ThemeRoot & { vars: Record<string, string> } => { const vars: Record<string, string> = {}; return { vars, dataset: {}, style: { setProperty: (n, v) => { vars[n] = v }, removeProperty: (n) => { delete vars[n] } } } }

describe('deriveAccentVars', () => {
  it('returns the 7 variables as hex, deterministically, with --accent equal to the color', () => {
    const a = deriveAccentVars('#3a7bd5', 'dark')
    expect(Object.keys(a)).toEqual([...accentVarNames])
    for (const value of Object.values(a)) expect(value).toMatch(/^#[0-9a-f]{6}$/)
    expect(a).toEqual(deriveAccentVars('#3a7bd5', 'dark'))
    expect(a['--accent']).toBe('#3a7bd5')
  })
  it('dark mode: strong is lighter and bg is dark', () => {
    const v = deriveAccentVars('#3a7bd5', 'dark')
    expect(lum(v['--accent-strong'])).toBeGreaterThan(lum(v['--accent']))
    expect(lum(v['--accent-bg'])).toBeLessThan(0.3)
  })
  it('light mode: strong is darker and bg is light', () => {
    const v = deriveAccentVars('#3a7bd5', 'light')
    expect(lum(v['--accent-strong'])).toBeLessThan(lum(v['--accent']))
    expect(lum(v['--accent-bg'])).toBeGreaterThan(0.8)
  })
  it('handles gray, black and white', () => {
    for (const c of ['#808080', '#000000', '#ffffff']) for (const m of ['light', 'dark'] as const) for (const value of Object.values(deriveAccentVars(c, m))) expect(value).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('findCustomTheme', () => {
  const themes = [{ id: 'a', nome: 'A', cor: '#112233', modo: 'dark' as const }]
  it('finds by reference and returns undefined for missing ids and presets', () => {
    expect(findCustomTheme('custom:a', themes)?.nome).toBe('A')
    expect(findCustomTheme('custom:b', themes)).toBeUndefined()
    expect(findCustomTheme('green', themes)).toBeUndefined()
    expect(findCustomTheme(null, themes)).toBeUndefined()
  })
})

describe('applyThemeToRoot', () => {
  const themes = [{ id: 'a', nome: 'A', cor: '#112233', modo: 'light' as const }]
  it('sets variables for a custom theme and clears them for a preset', () => {
    const root = fakeRoot()
    expect(applyThemeToRoot(root, 'custom:a', themes)).toBe(true)
    expect(root.dataset).toMatchObject({ accent: 'custom', theme: 'light' })
    expect(Object.keys(root.vars)).toHaveLength(7)
    expect(applyThemeToRoot(root, 'purple', themes)).toBe(false)
    expect(root.vars).toEqual({})
    expect(root.dataset).toMatchObject({ accent: 'purple', theme: 'dark' })
  })
  it('keeps presets working and falls back to green for an orphan reference', () => {
    const root = fakeRoot()
    expect(applyThemeToRoot(root, 'light-sky', [])).toBe(true)
    applyThemeToRoot(root, 'custom:gone', [])
    expect(root.dataset).toMatchObject({ accent: 'green', theme: 'dark' })
  })
})
