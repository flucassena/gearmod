import React, { useEffect, useRef } from 'react'
import { CheckMiniIcon } from './icons'

/** The app's standard square checkbox. The outer label remains responsible for the text and the clickable area. `indeterminate` shows the "some checked" dash. */
export function Checkbox({ checked, onChange, disabled = false, label, indeterminate = false }: { checked: boolean; onChange(value: boolean): void; disabled?: boolean; label?: string; indeterminate?: boolean }): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (input.current) input.current.indeterminate = indeterminate }, [indeterminate])
  return <span className="ckwrap"><input ref={input} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span className="ck" aria-hidden="true"><CheckMiniIcon /></span></span>
}
