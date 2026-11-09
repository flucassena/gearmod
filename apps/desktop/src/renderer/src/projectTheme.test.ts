import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectTheme } from './projectTheme'

const themes = [{ id: 'a', nome: 'A', cor: '#112233', modo: 'dark' as const }]
let store: Record<string, string> = {}
beforeEach(() => { store = {}; vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null }) })
afterEach(() => vi.unstubAllGlobals())

describe('projectTheme', () => {
  it('returns a valid preset and a custom theme that exists', () => {
    store['gearmod.projectTheme.p'] = 'blue'
    expect(projectTheme('p', themes)).toBe('blue')
    store['gearmod.projectTheme.p'] = 'custom:a'
    expect(projectTheme('p', themes)).toBe('custom:a')
  })
  it('returns null for orphan, invalid or missing values', () => {
    store['gearmod.projectTheme.p'] = 'custom:gone'
    expect(projectTheme('p', themes)).toBeNull()
    store['gearmod.projectTheme.p'] = 'rosa'
    expect(projectTheme('p', themes)).toBeNull()
    expect(projectTheme('other', themes)).toBeNull()
    expect(projectTheme(undefined, themes)).toBeNull()
  })
})
