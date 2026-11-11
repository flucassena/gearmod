import React, { useEffect, useRef } from 'react'
import { isResolved, sideFullyPicked, type PickBlock, type PickModel, type Picks } from './editor/conflictPicks'
import { useT } from './i18n'
import { Checkbox } from './Checkbox'

const CONTEXT = 3
type Side = 'ours' | 'theirs'

const Icon = ({ children }: { children: React.ReactNode }): React.JSX.Element => <svg className="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" />{children}</svg>

/** Plain lines around the blocks: only a few next to each conflict, the rest collapsed into one "N lines" row. */
function context(lines: string[], from: number, keep: 'start' | 'end' | 'both', hidden: (count: number) => string): React.JSX.Element[] {
  const rows = lines.map((text, index) => ({ text, number: from + index + 1 }))
  const shown = keep === 'start' ? rows.slice(0, CONTEXT) : keep === 'end' ? rows.slice(-CONTEXT) : [...rows.slice(0, CONTEXT), ...(rows.length > CONTEXT * 2 ? [] : rows.slice(CONTEXT))]
  const tail = keep === 'both' && rows.length > CONTEXT * 2 ? rows.slice(-CONTEXT) : []
  const skipped = rows.length - shown.length - tail.length
  const line = (row: { text: string; number: number }): React.JSX.Element => <div className="cp-row cp-plain" key={`p${row.number}`}><span className="cp-act" /><span className="cp-n">{row.number}</span><code>{row.text.replace(/\r?\n$/, '') || ' '}</code></div>
  const gap = skipped > 0 ? <div className="cp-skip" key={`s${from}`}>{hidden(skipped)}</div> : null
  return keep === 'end' ? [...(gap ? [gap] : []), ...shown.map(line)] : [...shown.map(line), ...(gap ? [gap] : []), ...tail.map(line)]
}

function Pane({ side, model, picks, change, changeAll, label, name, active, refs, onActive }: { side: Side; model: PickModel; picks: Picks; change(index: number, side: Side, line?: number): void; changeAll(side: Side): void; label: string; name: string; active: number; refs: React.MutableRefObject<Array<HTMLElement | null>>; onActive(index: number): void }): React.JSX.Element {
  const t = useT().git.conflicts
  let number = 0
  const body: React.JSX.Element[] = []
  model.blocks.forEach((block: PickBlock, index) => {
    const gap = (model.gaps[index] ?? '').match(/[^\n]*\n|[^\n]+$/g) ?? []
    body.push(...context(gap, number, index === 0 ? 'end' : 'both', t.hiddenLines))
    number += gap.length
    const lines = block[side], pick = picks[index]?.[side] ?? lines.map(() => false)
    body.push(<section key={`b${index}`} className={`cp-block ${index === active ? 'on' : ''} ${isResolved(picks, index) ? 'done' : ''}`} ref={(element) => { refs.current[index] = element }} onClick={() => onActive(index)}>
      <div className="cp-head"><span>{t.blockOf(index + 1, model.blocks.length)}</span><small>{block[side === 'ours' ? 'oursName' : 'theirsName']}</small></div>
      {lines.map((text, line) => <div className={`cp-row ${pick[line] ? 'on' : ''}`} key={line} role="checkbox" aria-checked={Boolean(pick[line])} aria-label={t.pickLine(number + line + 1)} tabIndex={0} onClick={() => change(index, side, line)} onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); change(index, side, line) } }}>
        <span className="cp-act" data-tip={pick[line] ? t.unpickLine : t.pickLineTip}><i className="cp-plus"><Icon><path d="M8 4.8v6.4M4.8 8h6.4" /></Icon></i><i className="cp-ok"><Icon><path d="m4.8 8.3 2.2 2.2 4.2-4.6" /></Icon></i><i className="cp-minus"><Icon><path d="M4.8 8h6.4" /></Icon></i></span>
        <span className="cp-n">{number + line + 1}</span><code>{text.replace(/\r?\n$/, '') || ' '}</code></div>)}
      {!lines.length && <div className="cp-empty">{t.emptySide}</div>}
    </section>)
    number += lines.length
  })
  const last = (model.gaps[model.blocks.length] ?? '').match(/[^\n]*\n|[^\n]+$/g) ?? []
  body.push(...context(last, number, 'start', t.hiddenLines))
  return <div className={`cp-pane ${side}`}><header><span className="cp-all" data-tip={t.pickAll}><Checkbox checked={sideFullyPicked(model, picks, side)} onChange={() => changeAll(side)} label={t.pickAll} /></span><b className="cp-tag">{side === 'ours' ? 'A' : 'B'}</b><span className="cp-title">{label}</span>{name && <small data-tip={name}>{name}</small>}</header><div className="cp-body">{body}</div></div>
}

/** Both sides of the file, line by line: pick what goes to the output (side A first, then B). The header checkbox picks the whole side. */
export function ConflictPanes({ model, picks, change, changeAll, oursLabel, theirsLabel, active, setActive }: { model: PickModel; picks: Picks; change(index: number, side: Side, line?: number): void; changeAll(side: Side): void; oursLabel: string; theirsLabel: string; active: number; setActive(index: number): void }): React.JSX.Element {
  const ours = useRef<Array<HTMLElement | null>>([]), theirs = useRef<Array<HTMLElement | null>>([]), first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    ours.current[active]?.scrollIntoView({ block: 'center', behavior: 'smooth' }); theirs.current[active]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [active])
  const name = (side: Side): string => model.blocks[0]?.[side === 'ours' ? 'oursName' : 'theirsName'] ?? ''
  return <div className="cp-panes"><Pane side="ours" model={model} picks={picks} change={change} changeAll={changeAll} label={oursLabel} name={name('ours')} active={active} refs={ours} onActive={setActive} /><Pane side="theirs" model={model} picks={picks} change={change} changeAll={changeAll} label={theirsLabel} name={name('theirs')} active={active} refs={theirs} onActive={setActive} /></div>
}
