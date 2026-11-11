import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from './i18n'
import { CommentIcon, SendIcon } from './icons'

type Line = { kind: 'ctx' | 'add' | 'del'; text: string; oldNo: number | null; newNo: number | null; mark?: [number, number] }
export type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'ctx' | 'add' | 'del'; text: string; oldNo: number | null; newNo: number | null; mark?: [number, number] }

/** Middle part that changed between two lines (strips the equal start and end): becomes the strong highlight inside the line. */
function changedPart(before: string, after: string): { del: [number, number]; add: [number, number] } {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endB = before.length, endA = after.length
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) { endB--; endA-- }
  return { del: [start, endB], add: [start, endA] }
}

/** Parses git's unified diff: hides the technical header, numbers the lines (before/after) and marks what changed inside edited lines. */
export function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldNo = 0, newNo = 0, inHunk = false
  const lines = text.replace(/\r$/gm, '').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const fresh = /^Arquivo novo: /.test(lines[0] ?? '')
  if (fresh) { lines.shift(); lines.forEach((line, index) => rows.push({ kind: 'add', text: line.replace(/^\+/, ''), oldNo: null, newNo: index + 1 })); return rows }
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]); inHunk = true; rows.push({ kind: 'hunk', text: hunk[3]?.trim() ?? '' }); continue }
    if (!inHunk || line.startsWith('\\')) continue
    if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ })
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null })
    else rows.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
  }
  // Block of removed lines followed by added lines of the same size = edited lines: marks only the part that changed.
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.kind !== 'del') continue
    let d = i; while (rows[d]?.kind === 'del') d++
    let a = d; while (rows[a]?.kind === 'add') a++
    const dels = d - i, adds = a - d
    if (dels === adds) for (let k = 0; k < dels; k++) {
      const before = rows[i + k] as unknown as Line, after = rows[d + k] as unknown as Line
      const part = changedPart(before.text, after.text)
      if (part.del[1] > part.del[0] || part.add[1] > part.add[0]) { before.mark = part.del; after.mark = part.add }
    }
    i = a - 1
  }
  return rows
}

function Code({ row }: { row: Extract<DiffRow, { kind: 'ctx' | 'add' | 'del' }> }): React.JSX.Element {
  if (!row.mark) return <>{row.text || ' '}</>
  const [from, to] = row.mark
  return <>{row.text.slice(0, from)}<mark>{row.text.slice(from, to) || ' '}</mark>{row.text.slice(to)}</>
}

/** Review request text: where it is (file and lines), the chosen chunk and what the user wrote. */
export function reviewPrompt(path: string, rows: Array<Extract<DiffRow, { kind: 'ctx' | 'add' | 'del' }>>, comment: string): string {
  const nums = rows.map((row) => row.newNo ?? row.oldNo).filter((value): value is number => value !== null)
  const onlyOld = rows.every((row) => row.newNo === null)
  const span = nums.length ? (Math.min(...nums) === Math.max(...nums) ? `linha ${nums[0]}` : `linhas ${Math.min(...nums)}–${Math.max(...nums)}`) : 'trecho'
  const code = rows.map((row) => `${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '} ${row.text}`).join('\n')
  return `Revisão de código em \`${path}\` (${span}${onlyOld ? ', do código antigo' : ''}):\n\n\`\`\`diff\n${code}\n\`\`\`\n\n${comment.trim()}`
}

/**
 * Diff with two number columns, red for what left, green for what came in and a strong highlight on the exact part that changed.
 * With `review`, lines can be picked (click, drag or Shift+click): a chat button appears beside the selection and,
 * when clicked, the field to tell the AI what to do with those lines.
 */
export function DiffLines({ text, review }: { text: string; review?: { path: string; send(prompt: string): boolean | Promise<boolean> } }): React.JSX.Element {
  const { git: { editor: t }, common } = useT()
  const rows = useMemo(() => parseDiff(text), [text])
  const [range, setRange] = useState<[number, number] | null>(null), [composing, setComposing] = useState(false), [comment, setComment] = useState(''), [top, setTop] = useState(0)
  const drag = useRef<number | null>(null), box = useRef<HTMLDivElement>(null), field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setRange(null); setComposing(false); setComment('') }, [text])
  useEffect(() => { const up = (): void => { drag.current = null }; document.addEventListener('mouseup', up); return () => document.removeEventListener('mouseup', up) }, [])
  const lo = range ? Math.min(...range) : -1, hi = range ? Math.max(...range) : -1
  const chosen = range ? rows.slice(lo, hi + 1).filter((row): row is Extract<DiffRow, { kind: 'ctx' | 'add' | 'del' }> => row.kind !== 'hunk') : []
  useEffect(() => { if (lo >= 0) setTop((box.current?.querySelectorAll<HTMLElement>('.gdl-row')[lo]?.offsetTop ?? 0)) }, [lo, hi])
  useEffect(() => { if (composing) field.current?.focus() }, [composing])
  const clear = (): void => { setRange(null); setComposing(false); setComment('') }
  const down = (index: number, event: React.MouseEvent): void => {
    if (!review || event.button !== 0 || rows[index]?.kind === 'hunk') return
    if (event.shiftKey && range) { setRange([range[0], index]); return }
    drag.current = index; setComposing(false); setRange([index, index])
  }
  const send = async (): Promise<void> => { if (!review || !chosen.length || !comment.trim()) return; if (await review.send(reviewPrompt(review.path, chosen, comment))) clear() }
  return <div className="gdlwrap">
    <div className={`gdl ${review ? 'review' : ''}`} ref={box}>{rows.map((row, index) => row.kind === 'hunk'
      ? <div key={index} className="gdl-row hunk"><span className="no" /><span className="no" /><span className="sign" /><span className="code">{row.text || '···'}</span></div>
      : <div key={index} className={`gdl-row ${row.kind} ${index >= lo && index <= hi ? 'picked' : ''}`} onMouseDown={(event) => down(index, event)} onMouseEnter={() => { if (drag.current !== null) setRange([drag.current, index]) }}><span className="no">{row.oldNo ?? ''}</span><span className="no">{row.newNo ?? ''}</span><span className="sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</span><span className="code"><Code row={row} /></span></div>)}
      {review && range && chosen.length > 0 && !composing && <button type="button" className="gdl-chatbtn tip" data-tip={t.chatAbout(chosen.length)} aria-label={t.chatAboutAria} style={{ top }} onMouseDown={(event) => event.stopPropagation()} onClick={() => setComposing(true)}><CommentIcon /></button>}
    </div>
    {review && range && chosen.length > 0 && composing && <div className="gdl-compose" role="group" aria-label={t.askAiAria}>
      <div className="gdl-askhead"><span>{t.linesSelected(chosen.length)}</span><button type="button" className="ghost" onClick={clear}>{common.cancel}</button></div>
      <div className="cbox"><textarea ref={field} value={comment} rows={1} placeholder={t.linesPlaceholder} aria-label={t.linesMessageAria} onChange={(event) => setComment(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } else if (event.key === 'Escape') { event.stopPropagation(); clear() } }} />
        <button type="button" className="sendbtn tip" data-tip={t.sendTip} aria-label={t.send} disabled={!comment.trim()} onClick={() => void send()}><SendIcon /></button></div></div>}
  </div>
}
