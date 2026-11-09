import React, { useEffect, useRef } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { baseExtensions, none, optionExtensions, readOnlyExtension, type EditorOptions } from './base'
import { languageFor } from './languages'
import { minimalChange } from './position'
import { conflictExtension, hasConflicts, type ConflictOptions } from './conflicts'
import { useT } from '../i18n'

export type { EditorOptions }
export interface EditorViewState { anchor: number; head: number; scrollTop: number }
const noExtensions: Extension[] = []

/** Code editor on top of CodeMirror 6. The view is created once; value, language and options go in through compartments. */
export function CodeEditor({ value, path, onChange, readOnly = false, options, extensions = noExtensions, onReady, initialSelection, initialScroll, onViewState, ariaLabel, className = '', conflictLabels, onCompareConflict, conflictActions = true, variant = 'code' }: {
  value: string; path: string; onChange?(value: string): void; readOnly?: boolean; options: EditorOptions; extensions?: Extension[]; onReady?(view: EditorView): void
  initialSelection?: { anchor: number; head: number }; initialScroll?: number; onViewState?(state: EditorViewState): void; ariaLabel: string; className?: string
  /** A file with conflict markers gets per-block accept buttons; these are the names of the sides (default: current / incoming). */
  conflictLabels?: { ours: string; theirs: string }; onCompareConflict?: ConflictOptions['compare']; conflictActions?: boolean
  /** `prose`: running text (card documents, Constitution) without line numbers or folds, with the same line wrapping as a text field. */
  variant?: 'code' | 'prose'
}): React.JSX.Element {
  const t = useT(), host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null)
  const compartments = useRef({ conflicts: new Compartment(), language: new Compartment(), readOnly: new Compartment(), options: new Compartment(), extra: new Compartment() })
  const callbacks = useRef({ onChange, onViewState, onReady, onCompareConflict }); callbacks.current = { onChange, onViewState, onReady, onCompareConflict }
  const first = useRef({ value, path, readOnly, options, extensions, initialSelection, initialScroll, ariaLabel, variant })
  useEffect(() => {
    const { language, readOnly: lock, options: configured, extra } = compartments.current, start = first.current
    let timer = 0
    const report = (editor: EditorView): void => { const { anchor, head } = editor.state.selection.main; callbacks.current.onViewState?.({ anchor, head, scrollTop: editor.scrollDOM.scrollTop }) }
    const schedule = (editor: EditorView): void => { window.clearTimeout(timer); timer = window.setTimeout(() => report(editor), 300) }
    const length = start.value.length, clamp = (at: number): number => Math.max(0, Math.min(at, length))
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: start.value,
        selection: start.initialSelection ? { anchor: clamp(start.initialSelection.anchor), head: clamp(start.initialSelection.head) } : undefined,
        extensions: [
          ...baseExtensions(start.variant),
          EditorView.contentAttributes.of({ 'aria-label': start.ariaLabel, spellcheck: 'false' }),
          language.of(none), compartments.current.conflicts.of(none), lock.of(readOnlyExtension(start.readOnly)), configured.of(optionExtensions(start.options)), extra.of(start.extensions),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange?.(update.state.doc.toString())
            if (update.selectionSet) schedule(update.view)
          }),
          EditorView.domEventHandlers({ scroll: (_event, current) => { schedule(current) } })
        ]
      })
    })
    view.current = editor
    if (start.initialScroll) window.requestAnimationFrame(() => { editor.scrollDOM.scrollTop = start.initialScroll! })
    callbacks.current.onReady?.(editor)
    return () => { window.clearTimeout(timer); report(editor); view.current = null; editor.destroy() }
  }, [])
  useEffect(() => {
    const editor = view.current
    const text = value.replace(/\r\n?/g, '\n'), current = editor?.state.doc.toString()
    if (editor && current !== undefined && text !== current) editor.dispatch({ changes: minimalChange(current, text) })
  }, [value])
  useEffect(() => {
    let alive = true
    void languageFor(path).then((extension) => { if (alive) view.current?.dispatch({ effects: compartments.current.language.reconfigure(extension ?? none) }) }).catch(() => undefined)
    return () => { alive = false }
  }, [path])
  const marked = hasConflicts(value), ours = conflictLabels?.ours ?? t.files.editor.conflictOurs, theirs = conflictLabels?.theirs ?? t.files.editor.conflictTheirs
  useEffect(() => { view.current?.dispatch({ effects: compartments.current.conflicts.reconfigure(marked ? conflictExtension({ oursLabel: ours, theirsLabel: theirs, actions: conflictActions, ...(onCompareConflict ? { compare: (info: Parameters<NonNullable<ConflictOptions['compare']>>[0]) => callbacks.current.onCompareConflict?.(info) } : {}) }) : none) }) }, [marked, ours, theirs, conflictActions, Boolean(onCompareConflict)])
  useEffect(() => { view.current?.dispatch({ effects: compartments.current.readOnly.reconfigure(readOnlyExtension(readOnly)) }) }, [readOnly])
  useEffect(() => { view.current?.dispatch({ effects: compartments.current.options.reconfigure(optionExtensions(options)) }) }, [options.wrap, options.tabSize, options.tabs, options.indentWithTab, options.whitespace, options.scrollPastEnd])
  useEffect(() => { view.current?.dispatch({ effects: compartments.current.extra.reconfigure(extensions) }) }, [extensions])
  return <div ref={host} className={`cm-host ${variant === 'prose' ? 'prose' : ''} ${options.guides ? 'guides' : ''} ${className}`} style={{ '--wf-tab': options.tabSize } as React.CSSProperties} />
}
