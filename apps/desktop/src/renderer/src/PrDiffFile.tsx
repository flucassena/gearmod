import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { PullRequestDetail } from '@gearmod/contracts'
import { toast } from './toasts'
import { plainError } from './NoticeDialog'
import { useT } from './i18n'
import { pairRows, parseFileDiff, type DiffRow } from './prDiff'
import { lineSpan } from './prFilters'
import { CheckIcon, ChevronDownSmallIcon, ChevronRightSmallIcon, ChevronUpIcon, CommentIcon, PlusIcon, ResolveIcon } from './icons'
import { MarkdownEditor, Spinner } from './prUi'
import { Checkbox } from './Checkbox'
import { CommentView } from './PrComment'

export type PrThread = PullRequestDetail['threads'][number]
export type PrThreadComment = PrThread['comments'][number]
type Shas = { headSha: string | null; baseSha: string | null; startSha: string | null }

const point = (row: DiffRow): { oldLine: number | null; newLine: number | null; oldPos: number; newPos: number } => ({ oldLine: row.oldLine, newLine: row.newLine, oldPos: row.oldPos, newPos: row.newPos })
const lineOf = (row: DiffRow): number => (row.newLine ?? row.oldLine) as number
const sign = (row: DiffRow): string => row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '

/**
 * One conversation (under a diff line or in the activity), as GitLab: each comment with its actions (resolve on the first one), then a
 * "Responder…" bar that opens the Markdown editor, where "Resolver thread" can go with the reply. A resolved one starts folded.
 * `lead` (the code excerpt, in the activity) sits glued on top of the first comment, in its card; the ⌃ button minimizes the thread.
 * `changed` gets the thread after a comment was edited, reacted to or deleted (no comment left: the thread is gone).
 */
export function ThreadBox({ thread, sourceId, number, replied, resolved, changed, lead }: { thread: PrThread; sourceId: string; number: number; replied(comment: PrThreadComment): void; resolved?(value: boolean): void; changed?(thread: PrThread): void; lead?: React.ReactNode }): React.JSX.Element {
  const t = useT().git.pr
  const [open, setOpen] = useState(false), [text, setText] = useState(''), [resolveToo, setResolveToo] = useState(false), [busy, setBusy] = useState(''), [folded, setFolded] = useState(thread.resolved)
  const canResolveToo = thread.resolvable && !thread.resolved
  const send = async (): Promise<void> => {
    setBusy('reply')
    try {
      const withResolve = canResolveToo && resolveToo
      const comment = await window.gearmod.invoke('prs:reply', { sourceId, number, threadId: thread.id, body: text, ...(withResolve ? { resolve: true } : {}) })
      replied(comment); setText(''); setOpen(false); setResolveToo(false)
      if (withResolve) { resolved?.(true); setFolded(true) }
    } catch (reason) { toast.error(t.replyFailed, plainError(reason)) } finally { setBusy('') }
  }
  const resolve = async (value: boolean): Promise<void> => {
    setBusy('resolve')
    try { await window.gearmod.invoke('prs:resolve', { sourceId, number, threadId: thread.id, resolved: value }); resolved?.(value); setFolded(value) } catch (reason) { toast.error(t.resolveFailed, plainError(reason)) } finally { setBusy('') }
  }
  if (folded) return <div className="prd-thread folded"><span className="ds-chip sm tone-success"><CheckIcon />{t.resolvedThread}</span><span className="pr-muted">{t.threadBy(thread.comments[0]?.author ?? '', thread.comments.length)}</span><button type="button" className="mini secondary" onClick={() => setFolded(false)}>{t.showThread}</button></div>
  return <div className="prd-thread">
    {thread.resolved && <span className="ds-chip sm tone-success"><CheckIcon />{t.resolvedThread}</span>}
    {thread.comments.map((comment, index) => { const view = <CommentView key={comment.id} comment={comment} sourceId={sourceId} number={number}
      resolve={index === 0 && thread.resolvable ? { resolved: thread.resolved, busy: busy === 'resolve', toggle: () => void resolve(!thread.resolved) } : undefined}
      changed={(next) => changed?.({ ...thread, comments: thread.comments.map((item) => item.id === next.id ? next : item) })}
      removed={() => changed?.({ ...thread, comments: thread.comments.filter((item) => item.id !== comment.id) })} />
      return index === 0 && lead ? <div className="prd-lead" key={comment.id}>{lead}{view}</div> : view })}
    {open
      ? <div className="prd-reply"><MarkdownEditor value={text} onChange={setText} label={t.replyPlaceholder} placeholder={t.replyPlaceholder} rows={4} submit={() => { if (text.trim() && !busy) void send() }} />
        {canResolveToo && <label className="pr-check"><Checkbox checked={resolveToo} onChange={setResolveToo} />{t.resolveThread}</label>}
        <div className="pr-acts"><button type="button" className="mini" disabled={Boolean(busy) || !text.trim()} aria-busy={busy === 'reply'} onClick={() => void send()}>{busy === 'reply' ? <Spinner /> : <CommentIcon />}{t.reply}</button><button type="button" className="mini secondary" onClick={() => { setOpen(false); setResolveToo(false) }}>{t.cancel}</button></div></div>
      : <div className="prd-replybar"><button type="button" className="prd-fakeinput" onClick={() => setOpen(true)}>{t.replyPlaceholder}</button>
        {thread.resolvable && <button type="button" className="mini secondary" disabled={Boolean(busy)} onClick={() => void resolve(!thread.resolved)}>{busy === 'resolve' ? <Spinner /> : <ResolveIcon />}{thread.resolved ? t.reopenThread : t.resolveThread}</button>}
        <button type="button" className="pr-iconbtn" aria-label={t.minimizeThread} data-tip={t.minimizeThread} onClick={() => setFolded(true)}><ChevronUpIcon /></button></div>}
  </div>
}

/** Diff of one file, drawn from its patch (unified or side by side), with line comments: click a line's button or drag over several lines. */
export function PrDiffFile({ sourceId, number, file, lines, shas, threads, layout, collapsed, toggle, created, replied, resolved, threadChanged }: {
  sourceId: string; number: number; file: PullRequestDetail['files'][number]; lines: string[]; shas: Shas; threads: PrThread[]; layout: 'unified' | 'split'; collapsed: boolean
  toggle(): void; created(thread: PrThread): void; replied(threadId: string, comment: PrThreadComment): void; resolved?(threadId: string, value: boolean): void; threadChanged?(thread: PrThread): void
}): React.JSX.Element {
  const t = useT().git.pr
  const rows = useMemo(() => collapsed ? [] : parseFileDiff(lines), [lines, collapsed])
  const [drag, setDrag] = useState<{ anchor: DiffRow; current: DiffRow } | null>(null), [composer, setComposer] = useState<{ start: DiffRow; end: DiffRow } | null>(null)
  const [text, setText] = useState(''), [busy, setBusy] = useState(false)
  const dragRef = useRef(drag)
  dragRef.current = drag
  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return
    const up = (): void => { const current = dragRef.current; setDrag(null); if (current) setComposer(lineSpan(current.anchor, current.current) ?? { start: current.anchor, end: current.anchor }) }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [dragging])

  const canComment = shas.headSha !== null
  const range = drag ? lineSpan(drag.anchor, drag.current) ?? { start: drag.anchor, end: drag.anchor } : composer
  const selected = (row: DiffRow | null): boolean => Boolean(row && range && row.hunk === range.start.hunk && row.id >= range.start.id && row.id <= range.end.id)
  const hover = (row: DiffRow | null): void => { if (row && drag && drag.anchor.hunk === row.hunk) setDrag({ ...drag, current: row }) }

  const placed = useMemo(() => {
    const byRow = new Map<number, PrThread[]>(), orphans: PrThread[] = []
    for (const thread of threads) {
      const row = rows.find((item) => item.kind !== 'hunk' && (thread.side === 'new' ? item.kind !== 'del' && item.newLine === thread.line : item.kind !== 'add' && item.oldLine === thread.line))
      if (row) byRow.set(row.id, [...(byRow.get(row.id) ?? []), thread]); else orphans.push(thread)
    }
    return { byRow, orphans }
  }, [rows, threads])

  const cancel = (): void => { setComposer(null); setText('') }
  const submit = async (): Promise<void> => {
    if (!composer || !shas.headSha) return
    setBusy(true)
    try {
      const thread = await window.gearmod.invoke('prs:line-comment', { sourceId, number, body: text, path: file.path, oldPath: file.oldPath, headSha: shas.headSha, baseSha: shas.baseSha, startSha: shas.startSha, start: point(composer.start), end: point(composer.end) })
      created(thread); setComposer(null); setText('')
    } catch (reason) { toast.error(t.lineCommentFailed, plainError(reason)) } finally { setBusy(false) }
  }

  const button = (row: DiffRow): React.JSX.Element | null => canComment ? <button type="button" className="prd-cbtn" aria-label={t.commentLineTip} data-tip={t.commentLineTip} onMouseDown={(event) => { event.preventDefault(); setDrag({ anchor: row, current: row }) }}><PlusIcon /></button> : null
  const composerLabel = (): string => {
    if (!composer) return ''
    const from = lineOf(composer.start), to = lineOf(composer.end)
    return `${from === to ? t.commentOnLine(from) : t.commentOnLines(from, to)}${composer.end.kind === 'del' ? ` (${t.oldSide})` : ''}`
  }
  const extras = (ids: number[], span: number): React.JSX.Element[] => {
    const out: React.JSX.Element[] = []
    for (const id of ids) for (const thread of placed.byRow.get(id) ?? []) out.push(<tr className="prd-extra" key={`t${thread.id}`}><td colSpan={span}><ThreadBox thread={thread} sourceId={sourceId} number={number} replied={(comment) => replied(thread.id, comment)} resolved={(value) => resolved?.(thread.id, value)} changed={threadChanged} /></td></tr>)
    if (composer && ids.includes(composer.end.id)) out.push(<tr className="prd-extra" key="composer"><td colSpan={span}><div className="prd-compose">
      <div className="cglabel">{composerLabel()}</div>
      <MarkdownEditor value={text} onChange={setText} label={composerLabel()} placeholder={t.lineCommentPlaceholder} rows={4} submit={() => { if (text.trim() && !busy) void submit() }} />
      <div className="pr-acts"><button type="button" className="mini" disabled={busy || !text.trim()} aria-busy={busy} onClick={() => void submit()}>{busy ? <Spinner /> : <CommentIcon />}{busy ? t.commenting : t.comment}</button><button type="button" className="mini secondary" onClick={cancel}>{t.cancel}</button></div>
    </div></td></tr>)
    return out
  }

  const unified = (): React.JSX.Element[] => rows.flatMap((row) => row.kind === 'hunk'
    ? [<tr className="prd-hunk" key={row.id}><td colSpan={3}>{row.text}</td></tr>]
    : [<tr key={row.id} className={`prd-line ${row.kind} ${selected(row) ? 'sel' : ''}`} onMouseEnter={() => hover(row)}>
      <td className="prd-ln">{row.kind === 'del' && button(row)}<span>{row.oldLine ?? ''}</span></td>
      <td className="prd-ln">{row.kind !== 'del' && button(row)}<span>{row.newLine ?? ''}</span></td>
      <td className="prd-code"><span className="prd-sign" aria-hidden="true">{sign(row)}</span>{row.text}</td></tr>, ...extras([row.id], 3)])
  const split = (): React.JSX.Element[] => pairRows(rows).flatMap((pair, index) => pair.hunk
    ? [<tr className="prd-hunk" key={`h${index}`}><td colSpan={4}>{pair.hunk.text}</td></tr>]
    : [<tr key={`p${index}`} className="prd-line split" onMouseEnter={() => hover(pair.right ?? pair.left)}>
      <td className={`prd-ln ${pair.left?.kind === 'del' ? 'del' : ''}`}>{pair.left?.kind === 'del' && button(pair.left)}<span>{pair.left?.oldLine ?? ''}</span></td>
      <td className={`prd-code ${pair.left?.kind ?? 'empty'} ${selected(pair.left) ? 'sel' : ''}`}>{pair.left && <><span className="prd-sign" aria-hidden="true">{sign(pair.left)}</span>{pair.left.text}</>}</td>
      <td className={`prd-ln ${pair.right?.kind === 'add' ? 'add' : ''}`}>{pair.right && button(pair.right)}<span>{pair.right?.newLine ?? ''}</span></td>
      <td className={`prd-code ${pair.right?.kind ?? 'empty'} ${selected(pair.right) ? 'sel' : ''}`}>{pair.right && <><span className="prd-sign" aria-hidden="true">{sign(pair.right)}</span>{pair.right.text}</>}</td></tr>,
    ...extras([pair.left?.id, pair.right?.id].filter((id): id is number => id !== undefined), 4)])

  return <section className="prd-file" data-prfile={file.path}>
    <header className="prd-head">
      <button type="button" className="prd-toggle" aria-expanded={!collapsed} aria-label={collapsed ? t.expandFile : t.collapseFile} data-tip={collapsed ? t.expandFile : t.collapseFile} onClick={toggle}>{collapsed ? <ChevronRightSmallIcon /> : <ChevronDownSmallIcon />}</button>
      <span className={`prf-st ${file.status}`} data-tip={t.fileStatus[file.status]}>{file.status === 'added' ? 'A' : file.status === 'removed' ? 'D' : file.status === 'renamed' ? 'R' : 'M'}</span>
      <b className="prd-path" data-tip={file.path}>{file.path}</b>
      {file.oldPath !== file.path && <small className="hint">{t.renamedFrom(file.oldPath)}</small>}
      <span className="nums"><span className="p">+{file.additions}</span> <span className="m">−{file.deletions}</span></span>
    </header>
    {!collapsed && (rows.length
      ? <div className="prd-scroll"><table className={`prd-table ${layout}`}>{layout === 'split' && <colgroup><col className="prd-lncol" /><col /><col className="prd-lncol" /><col /></colgroup>}<tbody>{layout === 'split' ? split() : unified()}{placed.orphans.length > 0 && <tr className="prd-extra"><td colSpan={layout === 'split' ? 4 : 3}>{placed.orphans.map((thread) => <ThreadBox key={thread.id} thread={thread} sourceId={sourceId} number={number} replied={(comment) => replied(thread.id, comment)} resolved={(value) => resolved?.(thread.id, value)} changed={threadChanged} />)}</td></tr>}</tbody></table></div>
      : <p className="gempty pr-pad">{t.noLines}</p>)}
  </section>
}
