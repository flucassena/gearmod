import React, { useEffect, useRef, useState } from 'react'
import { useT } from './i18n'

export type Cell = { t: string | null; big?: true }
export type GridColumn = { name: string; type: string }
export type GridMode = 'cell' | 'row' | 'col'
type Mode = GridMode
/** Row editing (table grid only): the parent keeps the changes and reports each cell's visual state. */
export interface GridEdit { status(row: number, col: number): 'new' | 'edited' | undefined; rowStatus(row: number): 'new' | 'deleted' | undefined; editable(row: number, col: number): boolean; commit(row: number, col: number, value: string | null): void }
const MIN_WIDTH = 70, DEFAULT_WIDTH = 180
type TypeKind = 'number' | 'text' | 'date' | 'bool' | 'json' | 'uuid' | 'binary' | 'other'
const typeKind = (type: string): TypeKind => {
  const value = type.toLowerCase()
  if (/^(bool)/.test(value)) return 'bool'
  if (/json/.test(value)) return 'json'
  if (/uuid/.test(value)) return 'uuid'
  if (/bytea/.test(value)) return 'binary'
  if (/^(smallint|integer|int\d*|bigint|numeric|decimal|real|double|float|money|serial|bigserial|oid)/.test(value)) return 'number'
  if (/^(date|time|interval)/.test(value)) return 'date'
  if (/^(char|varchar|character|text|name|citext|bpchar)/.test(value)) return 'text'
  return 'other'
}
const typeShapes: Record<TypeKind, React.ReactNode> = {
  number: <path d="M6 3 5 13M11 3l-1 10M3 6h10M2.500 10h10" />,
  text: <path d="M3 4.500V3.500h10v1M8 3.500V13M6 13h4" />,
  date: <><rect x="2.500" y="3.500" width="11" height="10" rx="1.500" /><path d="M2.500 7h11M5.500 2v3M10.500 2v3" /></>,
  bool: <><rect x="2" y="5" width="12" height="6" rx="3" /><circle cx="10.500" cy="8" r="1.500" /></>,
  json: <path d="M6 3C4.500 3 4.500 4 4.500 5.500S4 8 3 8c1 0 1.500.5 1.500 2S4.500 13 6 13M10 3c1.500 0 1.500 1 1.500 2.500S12 8 13 8c-1 0-1.500.5-1.500 2s0 3-1.500 3" />,
  uuid: <path d="M3 5.500h10M3 10.500h10M6.500 3l-1 10M10.500 3l-1 10" />,
  binary: <path d="M4 3.500v3M4 9.500v3M8 3.500v3M8 9.500v3M12 3.500v3M12 9.500v3" />,
  other: <><rect x="2.500" y="3" width="11" height="10" rx="1.500" /><path d="M2.500 6.500h11" /></>
}
const TypeIcon = ({ type }: { type: string }): React.JSX.Element => <svg className="ico db-tico" viewBox="0 0 16 16" aria-hidden="true">{typeShapes[typeKind(type)]}</svg>
const text = (cell: Cell | undefined): string => (cell?.t ?? 'NULL').replace(/[\t\r\n]+/g, ' ')

/** Results grid: selects a cell, row (by number) or column (by header) and resizes columns on the divider line. */
export function DbGrid({ columns, rows, order, sorted, toolbar, edit, onSelect }: { columns: GridColumn[]; rows: Cell[][]; order?(index: number): void; sorted?: { index: number; dir: 'asc' | 'desc' } | null; toolbar?: React.ReactNode; edit?: GridEdit; onSelect?(row: number, col: number, mode: GridMode): void }): React.JSX.Element {
  const t = useT()
  const [selected, setSelected] = useState<[number, number]>([0, 0]), [mode, setMode] = useState<Mode>('cell'), [tip, setTip] = useState<{ x: number; y: number; name: string; type: string }>(), [editing, setEditing] = useState<{ r: number; c: number }>(), editRef = useRef(editing)
  editRef.current = editing
  useEffect(() => { onSelect?.(selected[0], selected[1], mode) }, [selected, mode])
  const signature = columns.map((column) => column.name).join('\u0000')
  const [widths, setWidths] = useState<number[]>(() => columns.map(() => DEFAULT_WIDTH))
  useEffect(() => { setWidths(columns.map(() => DEFAULT_WIDTH)); setSelected([0, 0]); setMode('cell') }, [signature])
  const finishEdit = (save: boolean, value: string): void => {
    const target = editRef.current; if (!target) return
    editRef.current = undefined; setEditing(undefined)
    if (save) edit?.commit(target.r, target.c, value)
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-cell="${target.r}-${target.c}"]`)?.focus())
  }
  const beginEdit = (r: number, c: number): void => { if (edit?.editable(r, c)) { setSelected([r, c]); setMode('cell'); setEditing({ r, c }) } }
  const clipboard = (value: string): void => { void navigator.clipboard.writeText(value) }
  const copy = (kind: Mode): void => {
    const [row, col] = selected
    if (kind === 'cell') { const cell = rows[row]?.[col]; if (cell) clipboard(cell.t ?? 'NULL') }
    else if (kind === 'row') { const line = rows[row]; if (line) clipboard(line.map(text).join('\t')) }
    else clipboard(rows.map((line) => text(line[col])).join('\n'))
  }
  const startResize = (event: React.PointerEvent, index: number): void => {
    event.preventDefault(); event.stopPropagation()
    const startX = event.clientX, start = widths[index] ?? DEFAULT_WIDTH
    const move = (item: PointerEvent): void => setWidths((current) => current.map((value, i) => i === index ? Math.max(MIN_WIDTH, Math.round(start + item.clientX - startX)) : value))
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const total = 52 + widths.reduce((sum, value) => sum + value, 0)
  const focusCell = (target: HTMLElement | null, row: number, col: number): void => { setSelected([row, col]); target?.querySelector<HTMLElement>(`[data-cell="${row}-${col}"]`)?.focus() }
  return <div className="db-grid-wrap"><div className={`db-grid-actions${toolbar ? ' tb' : ''}`}>{toolbar ?? <><button type="button" className="db-tool" disabled={!rows.length} onClick={() => copy('cell')}>{t.database.grid.copyCell}</button><button type="button" className="db-tool" disabled={!rows.length} onClick={() => copy('row')}>{t.database.grid.copyRow}</button><button type="button" className="db-tool" disabled={!rows.length} onClick={() => copy('col')}>{t.database.grid.copyColumn}</button></>}<span className="db-grid-hint">{t.database.grid.counts(rows.length, columns.length)}</span></div>
    {tip && tip.type && <div className="db-coltip" role="tooltip" style={{ left: tip.x, top: tip.y }}><strong>{tip.name}</strong>: {tip.type}</div>}<div className="db-grid-scroll"><table role="grid" className="db-grid" aria-rowcount={rows.length + 1} aria-colcount={columns.length} style={{ width: Math.max(total, 0) }} onKeyDown={(event) => {
      if ((event.target as HTMLElement).tagName === 'INPUT') return
      const [row, col] = selected, offsets: Record<string, [number, number]> = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); copy(mode); return }
      if (edit && (event.key === 'F2' || event.key === 'Enter')) { event.preventDefault(); beginEdit(row, col); return }
      if (edit && event.key === 'Delete' && mode === 'cell' && edit.editable(row, col)) { event.preventDefault(); edit.commit(row, col, null); return }
      const delta = offsets[event.key]; if (!delta || !rows.length || !columns.length) return; event.preventDefault(); setMode('cell')
      focusCell(event.currentTarget, Math.max(0, Math.min(rows.length - 1, row + delta[0])), Math.max(0, Math.min(columns.length - 1, col + delta[1])))
    }}>
      <colgroup><col style={{ width: 52 }} />{columns.map((column, index) => <col key={`${index}-${column.name}`} style={{ width: widths[index] ?? DEFAULT_WIDTH }} />)}</colgroup>
      <thead><tr><th className="rn" aria-hidden="true">#</th>{columns.map((column, index) => <th key={`${index}-${column.name}`} className={mode === 'col' && selected[1] === index ? 'sel' : undefined}>
        <div className="db-th"><button type="button" className="hd" aria-label={column.type ? `${column.name}: ${column.type}` : column.name} onMouseEnter={(event) => { const box = event.currentTarget.getBoundingClientRect(); setTip({ x: box.left + 10, y: box.bottom + 6, name: column.name, type: column.type }) }} onMouseLeave={() => setTip(undefined)} onClick={() => { setSelected([selected[0], index]); setMode('col') }}><TypeIcon type={column.type} /><span className="nm">{column.name}</span></button>
          {order && <button type="button" className={`srt${sorted?.index === index ? ` on ${sorted.dir}` : ''}`} data-tip={t.database.grid.sortByColumn} aria-label={t.database.grid.sortBy(column.name)} onClick={() => order(index)}><svg viewBox="0 0 10 14" aria-hidden="true"><path className="up" d="M5 1.5 1.8 5.8h6.4z" /><path className="dn" d="M5 12.5 1.8 8.2h6.4z" /></svg></button>}</div>
        <span className="db-grip" role="separator" aria-orientation="vertical" data-tip={t.database.dragToResize} onPointerDown={(event) => startResize(event, index)} onDoubleClick={() => setWidths((current) => current.map((value, i) => i === index ? DEFAULT_WIDTH : value))} /></th>)}</tr></thead>
      <tbody>{rows.map((row, r) => <tr key={r} className={[mode === 'row' && selected[0] === r ? 'rowsel' : mode === 'cell' && selected[0] === r ? 'cur' : '', edit?.rowStatus(r) ? `row-${edit.rowStatus(r)}` : ''].filter(Boolean).join(' ') || undefined}><td className="rn" data-tip={t.database.grid.selectRow} onClick={() => { setSelected([r, selected[1]]); setMode('row') }}>{r + 1}</td>{row.map((cell, c) => {
        const changed = edit?.status(r, c), on = editing?.r === r && editing.c === c
        const cls = [mode === 'cell' && selected[0] === r && selected[1] === c ? 'sel' : mode === 'col' && selected[1] === c ? 'colsel' : '', changed ? `chg ${changed}` : ''].filter(Boolean).join(' ') || undefined
        return <td key={c} role="gridcell" data-cell={`${r}-${c}`} className={cls} tabIndex={selected[0] === r && selected[1] === c ? 0 : -1} onClick={() => { setSelected([r, c]); setMode('cell') }} onDoubleClick={() => beginEdit(r, c)} data-tip={cell.t ?? 'NULL'}>
          {on ? <input className="db-cell-in" autoFocus defaultValue={cell.t ?? ''} aria-label={t.database.grid.editColumn(columns[c]?.name ?? '')} onFocus={(event) => event.currentTarget.select()} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); finishEdit(true, event.currentTarget.value) } else if (event.key === 'Escape') { event.preventDefault(); finishEdit(false, '') } event.stopPropagation() }} onBlur={(event) => finishEdit(true, event.currentTarget.value)} />
            : cell.t === null ? <i>{edit ? '<null>' : 'NULL'}</i> : cell.t}{!on && cell.big && '…'}</td>
      })}</tr>)}</tbody></table>{rows.length === 0 && <p className="db-empty">{t.database.grid.noRows}</p>}</div></div>
}
