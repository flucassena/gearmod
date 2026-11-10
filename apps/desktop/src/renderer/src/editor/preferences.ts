import { useCallback, useState } from 'react'
export type Preferences = { tree: boolean; treeSide: 'left' | 'right'; tabs: boolean; autosave: boolean; indent: boolean; wrap: boolean; guides: boolean; whitespace: boolean; beyond: boolean; tabSize: number; diffLayout: 'unified' | 'split'; previewTabs: boolean
  /** PR changes: file tree visible, files as a folder tree or a flat list, and one file at a time (with previous/next). */
  prTree: boolean; prFileView: 'tree' | 'list'; prOneFile: boolean }
export const defaults: Preferences = { tree: true, treeSide: 'left', tabs: true, autosave: false, indent: true, wrap: true, guides: false, whitespace: false, beyond: false, tabSize: 2, diffLayout: 'unified', previewTabs: true, prTree: true, prFileView: 'tree', prOneFile: false }
export const readPreferences = (): Preferences => { try { const saved = JSON.parse(localStorage.getItem('gearmod.filePreferences') ?? '{}'); const migrated = localStorage.getItem('gearmod.fileTreeLeftV2') === '1'; localStorage.setItem('gearmod.fileTreeLeftV2', '1'); return { ...defaults, ...saved, treeSide: migrated ? saved.treeSide ?? 'left' : 'left' } } catch { return defaults } }
/** Editor preferences (the same in Files mode and in the chat panel); `change` saves immediately. */
export function usePreferences(): [Preferences, (patch: Partial<Preferences>) => void] {
  const [preferences, setPreferences] = useState(readPreferences)
  const change = useCallback((patch: Partial<Preferences>): void => setPreferences((value) => { const next = { ...value, ...patch }; try { localStorage.setItem('gearmod.filePreferences', JSON.stringify(next)) } catch { /* only valid for this session */ } return next }), [])
  return [preferences, change]
}
