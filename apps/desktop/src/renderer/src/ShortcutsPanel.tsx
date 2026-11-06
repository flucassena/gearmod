import React, { useEffect, useState } from 'react'
import { comboOf, comboProblem, displayCombo, loadShortcuts, saveShortcuts, shortcutDefaults, shortcutIds, shortcutsChangedEvent, type ShortcutId } from './shortcuts'
import { useT } from './i18n'

/** Settings > Shortcuts: one row per action, with the current shortcut, "Change" (records the next combination typed) and "Default". */
export function ShortcutsPanel(): React.JSX.Element {
  const t = useT().settings.shortcuts
  const [map, setMap] = useState(loadShortcuts), [recording, setRecording] = useState<ShortcutId | null>(null), [message, setMessage] = useState('')
  useEffect(() => { const again = (): void => setMap(loadShortcuts()); window.addEventListener(shortcutsChangedEvent, again); return () => window.removeEventListener(shortcutsChangedEvent, again) }, [])
  useEffect(() => {
    if (!recording) return
    // Captures before any other app shortcut and keeps the key from reaching the rest of the screen.
    const key = (event: KeyboardEvent): void => {
      event.preventDefault(); event.stopImmediatePropagation()
      if (event.key === 'Escape') { setRecording(null); setMessage(''); return }
      const combo = comboOf(event)
      if (!combo) return
      const problem = comboProblem(combo)
      if (problem) { setMessage(problem === 'needsModifier' ? t.needsModifier : t.reserved(displayCombo(combo))); return }
      const taken = shortcutIds.find((id) => id !== recording && map[id] === combo)
      if (taken) { setMessage(t.inUse(displayCombo(combo), t.actions[taken])); return }
      const next = { ...map, [recording]: combo }
      saveShortcuts(next); setMap(next); setRecording(null); setMessage(t.saved(t.actions[recording], displayCombo(combo)))
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [recording, map, t])
  const reset = (id: ShortcutId): void => { const next = { ...map, [id]: shortcutDefaults[id] }; saveShortcuts(next); setMap(next); setMessage(t.restored(t.actions[id], displayCombo(shortcutDefaults[id]))) }
  return <div className="stack shortcuts">
    <p className="hint">{t.intro}</p>
    <div className="sc-list">{shortcutIds.map((id) => <div className={`sc-row ${recording === id ? 'on' : ''}`} key={id}>
      <div className="sc-name"><b>{t.actions[id]}</b><small>{t.hints[id]}</small></div>
      <kbd className="sc-key">{recording === id ? t.pressKeys : displayCombo(map[id])}</kbd>
      <button type="button" className="mini secondary" onClick={() => { setMessage(''); setRecording(recording === id ? null : id) }}>{recording === id ? t.cancel : t.change}</button>
      <button type="button" className="mini secondary" disabled={map[id] === shortcutDefaults[id]} onClick={() => reset(id)}>{t.default}</button>
    </div>)}</div>
    {message && <p className="hint" role="status">{message}</p>}
  </div>
}
