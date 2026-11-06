import { describe, expect, it } from 'vitest'
import { comboProblem, displayCombo, shortcutDefaultsFor } from './shortcuts'

describe('shortcuts on the Mac', () => {
  it('uses Cmd instead of Ctrl, except for the terminal and switching views (Cmd+Tab belongs to the system)', () => {
    const mac = shortcutDefaultsFor(true), pc = shortcutDefaultsFor(false)
    expect(pc.toggleSidebar).toBe('Ctrl+B')
    expect(mac.toggleSidebar).toBe('Meta+B')
    expect(mac.toggleQuickView).toBe('Meta+Alt+B')
    expect(mac.quickOpenFile).toBe('Meta+P')
    expect(mac.toggleTerminal).toBe('Ctrl+`')
    expect(mac.nextView).toBe('Ctrl+Tab')
  })

  it('does not let Cmd+Q, Cmd+V and friends be chosen', () => {
    expect(comboProblem('Meta+Q')).toBe('reserved')
    expect(comboProblem('Meta+V')).toBe('reserved')
    expect(comboProblem('Meta+K')).toBeNull()
  })

  it('shows the Mac symbols in Apple order on the Mac and the text elsewhere', () => {
    expect(displayCombo('Meta+Shift+F', true)).toBe('⇧⌘F')
    expect(displayCombo('Meta+Alt+B', true)).toBe('⌥⌘B')
    expect(displayCombo('Ctrl+Shift+Tab', true)).toBe('⌃⇧⇥')
    expect(displayCombo('Ctrl+Shift+F', false)).toBe('Ctrl+Shift+F')
  })
})
