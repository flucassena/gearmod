import React, { useEffect, useMemo, useRef, useState } from 'react'
import { customThemeSchema, type CustomTheme } from '@gearmod/contracts'
import { useT } from './i18n'
import { useEscape } from './useEscape'
import { Select } from './Select'
import { plainError } from './NoticeDialog'
import { deriveAccentVars, newThemeId } from './customTheme'

const hexPattern = /^#[0-9a-fA-F]{6}$/

/**
 * Create or edit a custom theme: name, accent color and light/dark mode, with a live preview.
 * The preview applies the variables only to its own box, never to the app, so nothing changes until Save.
 */
export function ThemeCustomizerDialog({ theme, atLimit, close, save }: { theme?: CustomTheme; atLimit: boolean; close(): void; save(theme: CustomTheme): Promise<void> }): React.JSX.Element {
  const t = useT(), tc = t.settings.themeCustom
  const [name, setName] = useState(theme?.nome ?? ''), [color, setColor] = useState(theme?.cor ?? '#3a7bd5'), [mode, setMode] = useState<'light' | 'dark'>(theme?.modo ?? 'dark')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEscape(close)
  // The native picker fires `input` dozens of times per second while dragging: keep only the latest value and apply it once per frame.
  const pending = useRef<string | undefined>(undefined), frame = useRef<number | undefined>(undefined)
  const pickColor = (value: string): void => {
    pending.current = value
    if (frame.current === undefined) frame.current = requestAnimationFrame(() => { frame.current = undefined; if (pending.current !== undefined) setColor(pending.current) })
  }
  useEffect(() => () => { if (frame.current !== undefined) cancelAnimationFrame(frame.current) }, [])
  const validColor = hexPattern.test(color)
  const vars = useMemo(() => deriveAccentVars(validColor ? color : '#3a7bd5', mode), [color, mode, validColor])
  const dark = mode === 'dark'
  const previewStyle = { ...vars, background: dark ? '#141414' : '#f6f6f6', color: dark ? '#ececec' : '#1d1d1d', border: `1px solid ${vars['--accent-line']}` } as React.CSSProperties
  const submit = async (): Promise<void> => {
    if (!theme && atLimit) { setError(tc.errLimit); return }
    if (!validColor) { setError(tc.errColor); return }
    const parsed = customThemeSchema.safeParse({ id: theme?.id ?? newThemeId(), nome: name, cor: color.toLowerCase(), modo: mode })
    if (!parsed.success) { setError(name.trim() === '' || name.trim().length > 40 ? tc.errName : tc.errColor); return }
    setBusy(true); setError('')
    try { await save(parsed.data); close() } catch (reason) { setError(plainError(reason)); setBusy(false) }
  }
  return <div className="overlay top" role="dialog" aria-label={theme ? tc.editTitle : tc.newTitle}><div className="modal" style={{ width: 'min(780px,100%)' }}>
    <header><div><div className="eyebrow">{tc.eyebrow}</div><h2>{theme ? tc.editTitle : tc.newTitle}</h2></div><button className="x" onClick={close} aria-label={t.common.close}>×</button></header>
    <div className="themecustom-body">
    <div className="stack">
      <label className="f">{tc.name}<input className="in" value={name} maxLength={60} placeholder={tc.namePlaceholder} autoFocus onChange={(event) => setName(event.target.value)} /></label>
      <div className="f"><span>{tc.color}</span><div className="themecolor">
        <input type="color" aria-label={tc.color} value={validColor ? color.toLowerCase() : '#000000'} onChange={(event) => pickColor(event.target.value)} />
        <input className="in" aria-label={tc.colorHex} value={color} maxLength={7} spellCheck={false} onChange={(event) => setColor(event.target.value)} />
      </div></div>
      <div className="f"><span>{tc.mode}</span><Select label={tc.mode} options={[{ value: 'dark', label: tc.modeDark }, { value: 'light', label: tc.modeLight }]} value={mode} onChange={(value) => setMode(value as 'light' | 'dark')} /></div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
      <div className="f themecustom-preview"><span>{tc.preview}</span>
        <div className="themepreview" style={previewStyle} aria-hidden="true">
          <strong style={{ color: 'var(--accent-strong)' }}>{tc.previewTitle}</strong>
          <p style={{ margin: '4px 0 8px', opacity: 0.8 }}>{tc.previewText}</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="themepreview-btn" style={{ background: 'var(--accent)', color: dark ? '#101010' : '#ffffff' }}>{tc.previewButton}</span>
            <span className="themepreview-btn" style={{ background: 'var(--accent-bg)', color: 'var(--accent-strong)', border: '1px solid var(--accent-line)' }}>{tc.previewButton}</span>
            <span style={{ color: 'var(--accent-muted)' }}>{name.trim() || tc.namePlaceholder}</span>
          </div>
        </div>
      </div>
    </div>
    <div className="actions"><button type="button" className="secondary" onClick={close}>{t.common.cancel}</button><button type="button" disabled={busy} onClick={() => void submit()}>{tc.save}</button></div>
  </div></div>
}
