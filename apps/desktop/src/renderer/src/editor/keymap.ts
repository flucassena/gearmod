import { EditorSelection, Prec, type Extension } from '@codemirror/state'
import { codeMirrorKey, loadShortcuts, modKeys, shortcutLabel } from '../shortcuts'
import { keymap, type Command, type KeyBinding } from '@codemirror/view'
import { copyLineDown, copyLineUp, deleteLine, indentLess, indentMore, insertBlankLine, moveLineDown, moveLineUp, selectLine, toggleBlockComment, toggleComment } from '@codemirror/commands'
import { foldCode, unfoldCode } from '@codemirror/language'
import { selectNextOccurrence, selectSelectionMatches } from '@codemirror/search'
import { tr } from '../i18n'

export interface EditorActions {
  save(): void; find(): void; replace(): void; goto(): void
  /** Navigation through the code index: F12, Shift+F12 and Ctrl+Shift+O. */
  definition?(): void; references?(): void; outline?(): void
}

/** Ctrl+Shift+Enter (Cmd on the Mac): opens a new line above the current one, already with its indentation. */
export const insertLineAbove: Command = ({ state, dispatch }) => {
  if (state.readOnly) return false
  const changes = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head), text = /^[ \t]*/.exec(line.text)![0]
    return { changes: { from: line.from, insert: `${text}\n` }, range: EditorSelection.cursor(line.from + text.length) }
  })
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }))
  return true
}

/** Shortcut and description (in the interface language) shown in the editor settings menu. */
export const shortcutList = (): Array<{ keys: string; label: string }> => {
  const s = tr().files.editor.shortcuts
  return [
    { keys: shortcutLabel('save'), label: s.save }, { keys: shortcutLabel('find'), label: s.find }, { keys: shortcutLabel('replace'), label: s.replace }, { keys: shortcutLabel('goToLine'), label: s.goto },
    { keys: 'Ctrl+Z / Ctrl+Y', label: s.undoRedo }, { keys: 'Alt+↑ / Alt+↓', label: s.moveLine }, { keys: 'Shift+Alt+↑ / ↓', label: s.duplicateLine },
    { keys: 'Ctrl+Shift+K', label: s.deleteLine }, { keys: 'Ctrl+Enter', label: s.lineBelow }, { keys: 'Ctrl+Shift+Enter', label: s.lineAbove },
    { keys: 'Tab / Shift+Tab', label: s.indent }, { keys: 'Ctrl+] / Ctrl+[', label: s.indent }, { keys: 'Ctrl+/', label: s.commentLine },
    { keys: 'Shift+Alt+A', label: s.commentBlock }, { keys: 'Ctrl+D', label: s.selectNext }, { keys: 'Ctrl+Shift+L', label: s.selectAll },
    { keys: s.altClick, label: s.addCursor }, { keys: 'Ctrl+L', label: s.selectLine }, { keys: 'Ctrl+Shift+[ / ]', label: s.fold },
    { keys: shortcutLabel('searchSymbols'), label: s.symbol }, { keys: 'Ctrl+Shift+O', label: s.outline }, { keys: 'F12', label: s.definition }, { keys: 'Shift+F12', label: s.references }
   ].map((item) => ({ ...item, keys: modKeys(item.keys) }))  // the fixed ones use Mod, which is Cmd on the Mac
}

const ran = (action: () => void): Command => () => { action(); return true }
/** Editor shortcuts, with priority over CodeMirror's defaults (which would open the native search panel). */
export function editorKeymap(actions: EditorActions): Extension {
  const keys = loadShortcuts()
  const bindings: KeyBinding[] = [
    // Save, find, replace and go to line follow Settings > Shortcuts.
    { key: codeMirrorKey(keys.save), run: ran(actions.save), preventDefault: true }, { key: codeMirrorKey(keys.find), run: ran(actions.find), preventDefault: true },
    { key: codeMirrorKey(keys.replace), run: ran(actions.replace), preventDefault: true }, { key: codeMirrorKey(keys.goToLine), run: ran(actions.goto), preventDefault: true },
    { key: 'Alt-ArrowUp', run: moveLineUp }, { key: 'Alt-ArrowDown', run: moveLineDown },
    { key: 'Shift-Alt-ArrowUp', run: copyLineUp }, { key: 'Shift-Alt-ArrowDown', run: copyLineDown },
    { key: 'Mod-Shift-k', run: deleteLine }, { key: 'Mod-Enter', run: insertBlankLine }, { key: 'Mod-Shift-Enter', run: insertLineAbove },
    { key: 'Mod-]', run: indentMore }, { key: 'Mod-[', run: indentLess },
    { key: 'Mod-/', run: toggleComment }, { key: 'Shift-Alt-a', run: toggleBlockComment },
    { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true }, { key: 'Mod-Shift-l', run: selectSelectionMatches, preventDefault: true },
    { key: 'Mod-l', run: selectLine, preventDefault: true },
    { key: 'Mod-Shift-[', run: foldCode }, { key: 'Mod-Shift-]', run: unfoldCode },
    ...(actions.definition ? [{ key: 'F12', run: ran(actions.definition), preventDefault: true }] : []),
    ...(actions.references ? [{ key: 'Shift-F12', run: ran(actions.references), preventDefault: true }] : []),
    ...(actions.outline ? [{ key: 'Mod-Shift-o', run: ran(actions.outline), preventDefault: true }] : [])
  ]
  return Prec.highest(keymap.of(bindings))
}
