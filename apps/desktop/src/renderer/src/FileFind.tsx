import React, { useEffect, useRef, useState } from 'react'
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon } from './icons'
import { tr, useT } from './i18n'
import { parseGoto } from './editor/position'
export interface FindOptions { caseSensitive: boolean; wholeWord: boolean; regex: boolean }
export function fileMatches(content: string, query: string, options: FindOptions): { matches: Array<[number, number]>; error: string } {
  if (!query) return { matches: [], error: '' }
  try {
    const pattern = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(pattern, options.caseSensitive ? 'gu' : 'giu'), matches: Array<[number, number]> = []
    for (const match of content.matchAll(re)) {
      if (!match[0].length) continue
      const start = match.index, end = start + match[0].length
      if (options.wholeWord && (/[\p{L}\p{N}_]/u.test(content[start - 1] ?? '') || /[\p{L}\p{N}_]/u.test(content[end] ?? ''))) continue
      matches.push([start, end]); if (matches.length >= 10000) break
    }
    return { matches, error: '' }
  } catch { return { matches: [], error: tr().files.find.invalidRegex } }
}
export interface ReplaceControls { open: boolean; setOpen(value: boolean): void; text: string; setText(value: string): void; disabled: boolean; one(): void; all(): void }
export function FileFind({ input, query, setQuery, options, setOptions, count, index, error, previous, next, close, replace }: { input: React.RefObject<HTMLInputElement | null>; query: string; setQuery(value: string): void; options: FindOptions; setOptions(value: FindOptions): void; count: number; index: number; error: string; previous(): void; next(): void; close(): void; replace?: ReplaceControls }): React.JSX.Element {
  const t = useT(), f = t.files.find
  return <>
  <div className="wf-find" role="search" aria-label={f.region}>
    {replace && <button type="button" className="wf-findnav" aria-label={replace.open ? f.hideReplace : f.showReplace} data-tip={f.replaceTip} aria-expanded={replace.open} onClick={() => replace.setOpen(!replace.open)}>{replace.open ? <ChevronDownIcon /> : <ChevronRightIcon />}</button>}
    <div className={`wf-findbox ${error ? 'invalid' : ''}`}><input ref={input} placeholder={f.placeholder} aria-label={f.inputLabel} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (event.shiftKey) previous(); else next() } }} />
      <span className="wf-matchcount" role="status">{error || (query ? count ? `${index < 0 ? 0 : index + 1}/${count}` : f.noResults : '')}</span>
      {([['caseSensitive', f.caseSensitive, 'Aa'], ['wholeWord', f.wholeWord, 'ab'], ['regex', f.regex, '.*']] as const).map(([key, label, text]) => <button key={key} type="button" className={`wf-findopt ${options[key] ? 'on' : ''} ${key === 'wholeWord' ? 'whole-word' : ''}`} data-tip={label} aria-label={label} aria-pressed={options[key]} onClick={() => setOptions({ ...options, [key]: !options[key] })}>{text}</button>)}
    </div>
    <button type="button" className="wf-findnav" aria-label={f.previous} data-tip={f.previousTip} disabled={!count} onClick={previous}><ArrowUpIcon /></button>
    <button type="button" className="wf-findnav" aria-label={f.next} data-tip={f.nextTip} disabled={!count} onClick={next}><ArrowDownIcon /></button>
    <button type="button" className="wf-findnav close" aria-label={f.closeSearch} data-tip={f.closeTip} onClick={close}><CloseIcon /></button>
  </div>
  {replace?.open && <div className="wf-find wf-replace" role="group" aria-label={f.replaceGroup}>
    <div className="wf-findbox"><input placeholder={f.replacePlaceholder} aria-label={f.replaceInputLabel} value={replace.text} disabled={replace.disabled} onChange={(event) => replace.setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); replace.one() } }} /></div>
    <button type="button" className="wf-findtext" disabled={replace.disabled || !count} data-tip={f.replaceOneTip} onClick={replace.one}>{f.replaceOne}</button>
    <button type="button" className="wf-findtext" disabled={replace.disabled || !count} data-tip={f.replaceAllTip} onClick={replace.all}>{f.replaceAll}</button>
  </div>}
  </>
}

/** "Go to line" box: `42` or `42:7`; `submit` returns `false` if the text is not valid. */
export function GoToLine({ submit, close }: { submit(text: string): boolean; close(): void }): React.JSX.Element {
  const t = useT(), [text, setText] = useState(''), [rejected, setInvalid] = useState(false), field = useRef<HTMLInputElement>(null)
  // Invalid as soon as typed (text that is not `42`/`42:7`) or when Enter was rejected.
  const invalid = rejected || (text.trim() !== '' && !parseGoto(text))
  useEffect(() => { field.current?.focus() }, [])
  return <div className="wf-find" role="dialog" aria-label={t.files.find.goto.label}>
    <div className={`wf-findbox ${invalid ? 'invalid' : ''}`}><input ref={field} placeholder={t.files.find.goto.placeholder} aria-label={t.files.find.goto.target} aria-invalid={invalid} value={text} onChange={(event) => { setText(event.target.value); setInvalid(false) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (submit(text)) close(); else setInvalid(true) } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }} />
      <span className="wf-matchcount" role="status">{invalid ? t.files.find.goto.invalid : ''}</span></div>
    <button type="button" className="wf-findnav close" aria-label={t.common.close} data-tip={t.files.find.closeTip} onClick={close}><CloseIcon /></button>
  </div>
}
