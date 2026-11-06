import { describe, expect, it } from 'vitest'
import { codeMirrorKey, comboProblem, displayCombo, modKeys, shortcutDefaultsFor } from './shortcuts'

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

  it('has save, find, replace, go to line and the database keys in the list, with Mac-friendly defaults', () => {
    const pc = shortcutDefaultsFor(false), mac = shortcutDefaultsFor(true)
    expect([pc.save, pc.find, pc.replace, pc.goToLine, pc.dbReload, pc.dbCancel]).toEqual(['Ctrl+S', 'Ctrl+F', 'Ctrl+H', 'Ctrl+G', 'Ctrl+F5', 'Ctrl+F2'])
    expect([mac.save, mac.find, mac.replace, mac.goToLine, mac.dbReload, mac.dbCancel]).toEqual(['Meta+S', 'Meta+F', 'Meta+Alt+F', 'Ctrl+G', 'Meta+Shift+R', 'Meta+.'])
    // No two actions share a default, and none is reserved.
    for (const defaults of [pc, mac]) {
      expect(new Set(Object.values(defaults)).size).toBe(Object.values(defaults).length)
      for (const combo of Object.values(defaults)) expect(comboProblem(combo)).toBeNull()
    }
  })

  it('writes a shortcut for the editor and shows the fixed editor keys with Cmd on the Mac', () => {
    expect(codeMirrorKey('Ctrl+Shift+F')).toBe('Ctrl-Shift-f')
    expect(codeMirrorKey('Meta+.')).toBe('Meta-.')
    expect(codeMirrorKey('Ctrl+F5')).toBe('Ctrl-F5')
    expect(modKeys('Ctrl+] / Ctrl+[', true)).toBe('⌘] / ⌘[')
    expect(modKeys('Ctrl+Shift+[ / ]', true)).toBe('⇧⌘[ / ]')
    expect(modKeys('F12', true)).toBe('F12')
    expect(modKeys('Ctrl+D', false)).toBe('Ctrl+D')
  })
})
