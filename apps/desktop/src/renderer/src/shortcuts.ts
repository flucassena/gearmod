/**
 * Keyboard shortcuts for the app: each action has a default shortcut that the user can change in Settings > Shortcuts.
 * What they choose is stored on this computer (localStorage) and applies to all app windows.
 */
import { isMac } from './platform'

export type ShortcutId = 'toggleSidebar' | 'toggleQuickView' | 'toggleFiles' | 'toggleTerminal' | 'viewBoard' | 'viewChats' | 'viewGit' | 'viewDatabase' | 'nextView' | 'previousView' | 'projectSettings' | 'quickOpenFile' | 'searchInFiles' | 'searchSymbols' | 'save' | 'find' | 'replace' | 'goToLine' | 'dbReload' | 'dbCancel'

export const shortcutIds: ShortcutId[] = ['toggleSidebar', 'toggleQuickView', 'toggleFiles', 'toggleTerminal', 'viewBoard', 'viewChats', 'viewGit', 'viewDatabase', 'nextView', 'previousView', 'projectSettings', 'quickOpenFile', 'searchInFiles', 'searchSymbols', 'save', 'find', 'replace', 'goToLine', 'dbReload', 'dbCancel']
/** Default shortcuts on Windows and Linux. */
const pcDefaults: Record<ShortcutId, string> = {
  toggleSidebar: 'Ctrl+B', toggleQuickView: 'Ctrl+Alt+B', toggleFiles: 'Ctrl+Shift+E', toggleTerminal: 'Ctrl+`',
  // Project views. Ctrl+Tab inside the file panel still switches between file tabs.
  viewBoard: 'Ctrl+1', viewChats: 'Ctrl+2', viewGit: 'Ctrl+3', viewDatabase: 'Ctrl+4', nextView: 'Ctrl+Tab', previousView: 'Ctrl+Shift+Tab', projectSettings: 'Ctrl+,',
  // File panel searches: they work from anywhere (they open the panel if it is closed).
  quickOpenFile: 'Ctrl+P', searchInFiles: 'Ctrl+Shift+F', searchSymbols: 'Ctrl+T',
  // Where it applies: the file editor (save, find, replace, go to line), the chat and the terminal (find), the merge conflicts (save).
  save: 'Ctrl+S', find: 'Ctrl+F', replace: 'Ctrl+H', goToLine: 'Ctrl+G',
  // Database tables and SQL results.
  dbReload: 'Ctrl+F5', dbCancel: 'Ctrl+F2'
}
/** On the Mac, where Cmd plus the same key is taken or the F keys need fn: Cmd+H hides the app, Cmd+G is "find next", Cmd+. is the Mac "cancel". */
const macOverrides: Partial<Record<ShortcutId, string>> = { replace: 'Meta+Alt+F', goToLine: 'Ctrl+G', dbReload: 'Meta+Shift+R', dbCancel: 'Meta+.' }
/** Kept with Ctrl on the Mac: Cmd+Tab switches apps, and Ctrl+` is the terminal there too (as in VS Code). */
const macKeepsCtrl: ShortcutId[] = ['toggleTerminal', 'nextView', 'previousView']

/** Default shortcuts: on the Mac, Cmd (Meta) takes the place of Ctrl, except where the system already uses Cmd. */
export function shortcutDefaultsFor(mac: boolean): Record<ShortcutId, string> {
  if (!mac) return { ...pcDefaults }
  return Object.fromEntries(shortcutIds.map((id) => [id, macOverrides[id] ?? (macKeepsCtrl.includes(id) ? pcDefaults[id] : pcDefaults[id].replace(/^Ctrl\+/, 'Meta+'))])) as Record<ShortcutId, string>
}
export const shortcutDefaults: Record<ShortcutId, string> = shortcutDefaultsFor(isMac())

/** Combinations that the system, text fields or the app itself already use: they cannot be chosen. */
const reserved = new Set([
  'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+W', 'Ctrl+R', 'Ctrl+N', 'F5', 'F12', 'Shift+F12',
  // Mac: edit, close, hide, minimize and quit go through Cmd.
  'Meta+C', 'Meta+V', 'Meta+X', 'Meta+A', 'Meta+Z', 'Meta+Shift+Z', 'Meta+W', 'Meta+R', 'Meta+N', 'Meta+Q', 'Meta+H', 'Meta+M', 'Meta+Tab',
])

/** How a combination is shown: as stored on Windows/Linux (`Ctrl+Shift+F`), with the Mac symbols on the Mac (`⇧⌘F`). */
export function displayCombo(combo: string, mac: boolean = isMac()): string {
  if (!mac) return combo
  const parts = combo.split('+'), key = parts.pop()!
  const symbols: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
  // Apple's order: Control, Option, Shift, Command.
  const order = ['Ctrl', 'Alt', 'Shift', 'Meta']
  return parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((part) => symbols[part] ?? part).join('') + (key === 'Tab' ? '⇥' : key)
}

const storeKey = 'gearmod.shortcuts'
export const shortcutsChangedEvent = 'gearmod:shortcuts-changed'
/** Fired when a shortcut is triggered; `detail.id` says which one. Whoever handles the action listens to this event. */
export const shortcutEvent = 'gearmod:shortcut'
/** Asks the visible file panel to open the search (`detail.mode`: files, content or symbols). */
export const filesQuickEvent = 'gearmod:files-quick'

export function loadShortcuts(): Record<ShortcutId, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) ?? '{}') as Partial<Record<ShortcutId, string>>
    // Before, Ctrl+Shift+F opened the file panel; now it is the content search. Anyone who still had the old default moves to the new one.
    if (saved.toggleFiles === 'Ctrl+Shift+F' && !saved.searchInFiles) delete saved.toggleFiles
    return Object.fromEntries(shortcutIds.map((id) => [id, typeof saved[id] === 'string' && saved[id] ? saved[id]! : shortcutDefaults[id]])) as Record<ShortcutId, string>
  } catch { return { ...shortcutDefaults } }
}

export function saveShortcuts(next: Record<ShortcutId, string>): void {
  try { localStorage.setItem(storeKey, JSON.stringify(next)) } catch { /* only valid for this session */ }
  window.dispatchEvent(new Event(shortcutsChangedEvent))
}

const modifierKeys = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'])

/** Key name by physical position (does not change with the keyboard: ABNT2, US...). */
function keyName(event: KeyboardEvent): string | null {
  if (modifierKeys.has(event.key)) return null
  const code = event.code
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  if (code === 'NumpadDecimal' || code === 'NumpadComma') return event.key === '.' ? '.' : ','
  const named: Record<string, string> = { Backquote: '`', Backslash: '\\', Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Space: 'Space', Tab: 'Tab', Enter: 'Enter', Escape: 'Esc', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backspace: 'Backspace', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert' }
  return named[code] ?? (event.key.length === 1 ? event.key.toUpperCase() : null)
}

/** `Ctrl+Alt+B` from the keyboard event, or `null` if it was only a modifier. */
export function comboOf(event: KeyboardEvent): string | null {
  const key = keyName(event)
  if (!key) return null
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key].filter(Boolean).join('+')
}

/** Combination accepted as a shortcut: has Ctrl, Alt or Meta (or is an F key) and is not on the reserved list. Returns the reason for refusal, or `null` if valid. */
export function comboProblem(combo: string): 'needsModifier' | 'reserved' | null {
  const parts = combo.split('+'), key = parts[parts.length - 1]!
  if (!parts.some((part) => part === 'Ctrl' || part === 'Alt' || part === 'Meta') && !/^F\d+$/.test(key)) return 'needsModifier'
  return reserved.has(combo) ? 'reserved' : null
}

/** Does the event trigger this shortcut? (Ctrl+` also accepts what the ABNT2 keyboard delivers as a dead key.) */
export function matches(event: KeyboardEvent, combo: string): boolean {
  if (comboOf(event) === combo) return true
  return combo === 'Ctrl+`' && event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === '^' || event.key === '`' || event.key === 'Dead')
}

/** Which action the event triggers, if any. */
export function shortcutFor(event: KeyboardEvent): ShortcutId | null {
  const all = loadShortcuts()
  return shortcutIds.find((id) => matches(event, all[id])) ?? null
}

/** Does the event trigger this action's shortcut (as the user set it)? For handlers that only care about one action. */
export function isShortcut(event: KeyboardEvent, id: ShortcutId): boolean {
  return matches(event, loadShortcuts()[id])
}

/** How the action's current shortcut is shown (`Ctrl+S`, or `⌘S` on the Mac). */
export const shortcutLabel = (id: ShortcutId): string => displayCombo(loadShortcuts()[id])

/** The combination in CodeMirror's notation (`Ctrl+Shift+F` → `Ctrl-Shift-f`), for the editor's own keymap. */
export function codeMirrorKey(combo: string): string {
  const parts = combo.split('+'), key = parts.pop()!
  const named: Record<string, string> = { Esc: 'Escape', Space: 'Space', Tab: 'Tab', Enter: 'Enter' }
  return [...parts, named[key] ?? (key.length === 1 ? key.toLowerCase() : key)].join('-')
}

/** Fixed editor shortcuts written with Ctrl (`Ctrl+] / Ctrl+[`) as shown on this system: CodeMirror's `Mod` is Cmd on the Mac. */
export function modKeys(text: string, mac: boolean = isMac()): string {
  if (!mac) return text
  return text.split(' / ').map((part) => /^(Ctrl|Shift|Alt)(\+|$)/.test(part) && part.includes('+') ? displayCombo(part.replace(/^Ctrl\+/, 'Meta+'), true) : part).join(' / ')
}
