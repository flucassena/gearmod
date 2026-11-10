import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Checkbox } from './Checkbox'
import type { SelectOption } from './Select'
import { useFloatingMenu } from './useFloatingMenu'
import { useEscape } from './useEscape'

/**
 * Multiple selection with the same look as `Select`: each option has a small box and the list stays open while checking.
 * `empty` is the text shown when nothing is checked. Optional: `chosen` draws the checked ones in the button (chips, avatars)
 * instead of "a + b", and `filterPlaceholder` adds a search box on top of long lists.
 */
export function MultiSelect({ options, value, onChange, label, empty, up = false, disabled = false, chosen: drawChosen, filterPlaceholder }: { options: SelectOption[]; value: string[]; onChange(value: string[]): void; label: string; empty: string; up?: boolean; disabled?: boolean; chosen?(options: SelectOption[]): React.ReactNode; filterPlaceholder?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('')
  useEffect(() => { if (!open) setQuery('') }, [open])
  const button = useRef<HTMLButtonElement>(null), root = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null)
  const box = useFloatingMenu(open, button, up)
  useEffect(() => {
    if (!open) return
    const close = (event: Event): void => { if (!root.current?.contains(event.target as Node) && !list.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  useEscape(() => setOpen(false), open)
  const chosen = options.filter((option) => value.includes(option.value))
  const toggle = (option: string): void => onChange(value.includes(option) ? value.filter((item) => item !== option) : options.map((item) => item.value).filter((item) => item === option || value.includes(item)))
  const filtering = Boolean(filterPlaceholder) && options.length > 8
  const shown = filtering && query.trim() ? options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase())) : options
  return <div className={`sel ${drawChosen ? 'msel' : ''}`} ref={root}>
    <button type="button" ref={button} className="sel-btn" disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}><span className="l">{chosen.length ? drawChosen ? drawChosen(chosen) : chosen.map((item) => item.label).join(' + ') : drawChosen ? <span className="msel-empty">{empty}</span> : empty}</span><span className="chev">▾</span></button>
    {open && box && createPortal(<div ref={list} className="sel-list fx floating-select-list" role="listbox" aria-label={label} aria-multiselectable="true" style={box} onClick={(event) => { if (!(event.target as HTMLElement).closest('input.msel-filter')) { event.preventDefault(); event.stopPropagation() } }}>
      {filtering && <input className="in msel-filter" autoFocus value={query} placeholder={filterPlaceholder} aria-label={filterPlaceholder} onChange={(event) => setQuery(event.target.value)} />}
      {shown.map((option) => {
        const on = value.includes(option.value)
        return <button type="button" role="option" aria-selected={on} key={option.value} disabled={option.disabled} className={`sel-opt multi ${on ? 'on' : ''}`} onClick={() => toggle(option.value)}><Checkbox checked={on} label={option.label} onChange={() => toggle(option.value)} />{option.icon}<span>{option.label}</span>{option.sub && <small>{option.sub}</small>}</button>
      })}</div>, document.body)}
  </div>
}
