import { EditorView, Decoration, WidgetType, keymap, type DecorationSet } from '@codemirror/view'
import { EditorSelection, Prec, StateField, type EditorState, type Extension } from '@codemirror/state'
import { tr } from '../i18n'

export interface Conflict {
  /** From the start of the `<<<<<<<` line to the end of the `>>>>>>>` line (including the line break), in document characters. */
  from: number; to: number
  ours: { from: number; to: number }; base: { from: number; to: number } | null; theirs: { from: number; to: number }
  oursName: string; theirsName: string
  /** Positions of the four markers (start of each line) to decorate. */
  markers: number[]
}

const hasMarkers = /^<{7}( |$)[^]*?^>{7}( |$)/m
/** Quick check: does the text have a whole conflict block? (to enable the extension only when it is worth it) */
export const hasConflicts = (text: string): boolean => hasMarkers.test(text)

/**
 * Git conflict blocks (`<<<<<<<`, optional diff3 `|||||||`, `=======`, `>>>>>>>`), with character positions; accepts CRLF.
 * A block with no closing marker is ignored, and a new `<<<<<<<` before closing restarts the block.
 */
export function findConflicts(text: string): Conflict[] {
  const conflicts: Conflict[] = []
  let at = 0, state: 0 | 1 | 2 | 3 = 0
  let start = 0, oursName = '', oursFrom = 0, baseFrom = -1, baseMarker = -1, middle = -1, theirsFrom = 0
  while (at <= text.length) {
    const newline = text.indexOf('\n', at), lineEnd = newline < 0 ? text.length : newline, next = newline < 0 ? text.length + 1 : newline + 1
    const line = text.slice(at, lineEnd).replace(/\r$/, '')
    if (/^<{7}( |$)/.test(line)) { state = 1; start = at; oursName = line.slice(8).trim(); oursFrom = next; baseFrom = -1; baseMarker = -1; middle = -1 }
    else if (state === 1 && /^\|{7}( |$)/.test(line)) { state = 2; baseMarker = at; baseFrom = next }
    else if ((state === 1 || state === 2) && /^={7}$/.test(line)) { state = 3; middle = at; theirsFrom = next }
    else if (state === 3 && /^>{7}( |$)/.test(line)) {
      const oursEnd = baseMarker >= 0 ? baseMarker : middle
      conflicts.push({ from: start, to: Math.min(next, text.length), ours: { from: oursFrom, to: oursEnd }, base: baseMarker >= 0 ? { from: baseFrom, to: middle } : null, theirs: { from: theirsFrom, to: at }, oursName, theirsName: line.slice(8).trim(), markers: [start, ...(baseMarker >= 0 ? [baseMarker] : []), middle, at] })
      state = 0
    }
    at = next
  }
  return conflicts
}

/** Text of the chosen part (each side ends with the line break before the next marker). */
export const conflictText = (text: string, range: { from: number; to: number }): string => text.slice(range.from, range.to)

export interface ConflictOptions { oursLabel: string; theirsLabel: string; /** `false`: no accept/compare buttons above each block (the resolver screen has its own controls). */ actions?: boolean; compare?(info: { ours: string; theirs: string; oursLabel: string; theirsLabel: string }): void }
type Choice = 'ours' | 'theirs' | 'both'

const conflictField = StateField.define<Conflict[]>({ create: (state) => findConflicts(state.doc.toString()), update: (value, transaction) => transaction.docChanged ? findConflicts(transaction.newDoc.toString()) : value })
export const conflictsIn = (state: EditorState): Conflict[] => state.field(conflictField, false) ?? []

/** Replaces the whole block with the chosen side in a single transaction (one Ctrl+Z undoes it). */
export function resolveConflict(view: EditorView, at: number, choice: Choice): boolean {
  const text = view.state.doc.toString(), found = findConflicts(text).find((item) => at >= item.from && at < item.to)
  if (!found) return false
  const ours = conflictText(text, found.ours), theirs = conflictText(text, found.theirs)
  view.dispatch({ changes: { from: found.from, to: found.to, insert: choice === 'ours' ? ours : choice === 'theirs' ? theirs : ours + theirs }, userEvent: 'input' })
  return true
}

class Actions extends WidgetType {
  constructor(private readonly options: ConflictOptions, private readonly from: number, private readonly signature: string) { super() }
  eq(other: Actions): boolean { return other.from === this.from && other.signature === this.signature && other.options.oursLabel === this.options.oursLabel && other.options.theirsLabel === this.options.theirsLabel }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div'); box.className = 'cm-conflict-actions'
    const add = (label: string, title: string, run: (position: number) => void): void => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.title = title
      button.onmousedown = (event) => { event.preventDefault(); run(view.posAtDOM(box)) }
      box.append(button)
    }
    const t = tr().git.editor
    add(t.acceptSide(this.options.oursLabel), t.keepOnlySide(this.options.oursLabel), (position) => resolveConflict(view, position, 'ours'))
    add(t.acceptSide(this.options.theirsLabel), t.keepOnlySide(this.options.theirsLabel), (position) => resolveConflict(view, position, 'theirs'))
    add(t.acceptBoth, t.keepBoth, (position) => resolveConflict(view, position, 'both'))
    if (this.options.compare) add(t.compare, t.compareTip, (position) => { const text = view.state.doc.toString(), found = findConflicts(text).find((item) => position >= item.from && position < item.to); if (found) this.options.compare?.({ ours: conflictText(text, found.ours), theirs: conflictText(text, found.theirs), oursLabel: this.options.oursLabel, theirsLabel: this.options.theirsLabel }) })
    return box
  }
  ignoreEvent(): boolean { return true }
}

const line = (name: string): Decoration => Decoration.line({ class: name })
function decorate(state: EditorState, options: ConflictOptions): DecorationSet {
  const ranges = []
  for (const conflict of conflictsIn(state)) {
    if (options.actions !== false) ranges.push(Decoration.widget({ widget: new Actions(options, conflict.from, `${conflict.oursName}|${conflict.theirsName}`), block: true, side: -1 }).range(conflict.from))
    const paint = (range: { from: number; to: number }, name: string): void => { let at = range.from; while (at < range.to) { const row = state.doc.lineAt(at); ranges.push(line(name).range(row.from)); at = row.to + 1 } }
    paint(conflict.ours, 'cm-conflict-ours'); if (conflict.base) paint(conflict.base, 'cm-conflict-base'); paint(conflict.theirs, 'cm-conflict-theirs')
    for (const marker of conflict.markers) ranges.push(line('cm-conflict-marker').range(state.doc.lineAt(marker).from))
  }
  return Decoration.set(ranges, true)
}

const jump = (forward: boolean) => (view: EditorView): boolean => {
  const all = conflictsIn(view.state)
  if (!all.length) return false
  const head = view.state.selection.main.head
  const target = forward ? all.find((item) => item.from > head) ?? all[0]! : [...all].reverse().find((item) => item.from < head) ?? all.at(-1)!
  view.dispatch({ selection: EditorSelection.cursor(target.from), effects: EditorView.scrollIntoView(target.from, { y: 'start', yMargin: 48 }) }); return true
}
export const nextConflict = jump(true), previousConflict = jump(false)

const theme = EditorView.baseTheme({
  '.cm-conflict-ours': { backgroundColor: 'color-mix(in srgb, #3fb950 16%, transparent)' },
  '.cm-conflict-theirs': { backgroundColor: 'color-mix(in srgb, #4493f8 16%, transparent)' },
  '.cm-conflict-base': { backgroundColor: 'color-mix(in srgb, #8b949e 16%, transparent)' },
  '.cm-conflict-marker': { color: 'var(--muted)', opacity: '.8', fontStyle: 'italic' },
  '.cm-conflict-actions': { display: 'flex', gap: '12px', padding: '2px 8px', fontSize: '11px', background: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  '.cm-conflict-actions button': { border: '0', background: 'none', padding: '0', color: 'var(--accent-strong, var(--accent))', cursor: 'pointer', font: 'inherit' },
  '.cm-conflict-actions button:hover': { textDecoration: 'underline' }
})

/** Merge conflict inside the editor: colors per side, "Accept current · incoming · both · Compare" above each block and Alt+F5 / Shift+Alt+F5 between blocks. */
export function conflictExtension(options: ConflictOptions): Extension {
  return [conflictField, theme, EditorView.decorations.compute([conflictField], (state) => decorate(state, options)), Prec.high(keymap.of([{ key: 'Alt-F5', run: nextConflict }, { key: 'Shift-Alt-F5', run: previousConflict }]))]
}
