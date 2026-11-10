import React, { useEffect, useMemo, useState } from 'react'
import type { PrCommit, PrMergeMethod, PrPipeline, PullRequestDetail } from '@gearmod/contracts'
import { toast } from './toasts'
import { plainError } from './NoticeDialog'
import { Checkbox } from './Checkbox'
import { ConfirmDialog } from './ConfirmDialog'
import { Select } from './Select'
import { Markdown } from './markdown'
import { useT } from './i18n'
import { parseFileDiff } from './prDiff'
import { groupByDay } from './prFilters'
import { ThreadBox, type PrThread, type PrThreadComment } from './PrDiffFile'
import { CommentView, type PrComment } from './PrComment'
import { ApproverIcon, CheckIcon, ChevronRightSmallIcon, CommentIcon, CopyIcon, MergeIcon, ThumbDownIcon, ThumbUpIcon } from './icons'
import { Avatar, EventBody, MarkdownEditor, Spinner, StatusIcon, duration, fullDate, isBot, shortDay, useAgo, type RunStatus } from './prUi'

const message = (error: unknown): string => plainError(error)
export const copyText = (text: string, done: string, failed: string): void => { void navigator.clipboard.writeText(text).then(() => toast.info(done)).catch(() => toast.error(failed)) }

/** Bolinhas of the stages of a pipeline, in run order. */
export function StageDots({ pipeline, label }: { pipeline: PrPipeline; label(status: string): string }): React.JSX.Element {
  return <span className="pr-dots">{pipeline.stages.map((stage) => { const status = stageStatus(stage.jobs.map((job) => job.status)); return <StatusIcon key={stage.name} status={status} label={`${stage.name}: ${label(status)}`} /> })}</span>
}
/** A stage (or pipeline) from its jobs: any failure fails, anything going is running, all done is success. */
export function stageStatus(statuses: string[]): RunStatus {
  if (!statuses.length) return 'none'
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('running')) return 'running'
  if (statuses.every((s) => s === 'success' || s === 'skipped')) return statuses.includes('success') ? 'success' : 'skipped'
  if (statuses.includes('pending')) return statuses.some((s) => s === 'success') ? 'running' : 'pending'
  if (statuses.includes('manual')) return 'manual'
  return 'canceled'
}

/** Merge card: ready or why not, the options, how many commits go in, and a confirmation before merging on the server. */
function MergeCard({ sourceId, detail, commits, merged }: { sourceId: string; detail: PullRequestDetail; commits: number | null; merged(): void }): React.JSX.Element {
  const t = useT().git.pr
  const methods = detail.mergeMethods.length ? detail.mergeMethods : ['merge' as const]
  const [method, setMethod] = useState<PrMergeMethod>(methods.includes(detail.mergeDefault) ? detail.mergeDefault : methods[0]!), [deleteSource, setDeleteSource] = useState(detail.canDeleteSource), [edit, setEdit] = useState(false), [text, setText] = useState(detail.title), [asking, setAsking] = useState(false), [busy, setBusy] = useState(false)
  const reason = detail.state === 'MERGED' ? t.blockedMerged : detail.state === 'CLOSED' ? t.blockedClosed : detail.draft ? t.blockedDraft : detail.mergeable === 'CONFLICTING' ? t.blockedConflict : null
  const del = deleteSource && detail.canDeleteSource
  const run = async (): Promise<void> => {
    setAsking(false); setBusy(true)
    try { const result = await window.gearmod.invoke('prs:merge', { sourceId, number: detail.number, method, deleteSourceBranch: del, message: method !== 'rebase' && edit && text.trim() ? text : null }); toast.success(t.mergedToast); if (result.warning) toast.info(result.warning); merged() } catch (failure) { toast.error(t.mergeFailed, message(failure)) } finally { setBusy(false) }
  }
  if (detail.state === 'MERGED') return <div className="pr-card"><div className="pr-row"><span className="ds-status tone-text tone-success"><MergeIcon /></span><b>{t.mergedBanner(detail.base)}</b></div></div>
  if (detail.state === 'CLOSED') return <div className="pr-card"><div className="pr-row"><b>{t.blockedClosed}</b></div></div>
  return <div className="pr-card">
    <div className="pr-row">{reason ? <StatusIcon status="manual" label={reason} big /> : <StatusIcon status="success" label={t.readyToMerge} big />}<b>{reason ?? t.readyToMerge}</b></div>
    <div className="pr-cardbody">
      <div className="pr-checks">
        <label className="pr-check" data-tip={detail.canDeleteSource ? undefined : t.deleteSourceFork}><Checkbox checked={del} onChange={setDeleteSource} disabled={Boolean(reason) || !detail.canDeleteSource} />{t.deleteSource}</label>
        {method !== 'rebase' && <label className="pr-check"><Checkbox checked={edit} onChange={setEdit} disabled={Boolean(reason)} />{t.editMessage}</label>}
      </div>
      <div className="pr-method"><span className="pr-muted">{t.mergeMethod}</span>
        <div className="gseg" role="radiogroup" aria-label={t.mergeMethod}>{methods.map((item) => <button type="button" key={item} role="radio" aria-checked={method === item} className={method === item ? 'on' : ''} disabled={Boolean(reason)} data-tip={t.mergeMethodNotes[item]} onClick={() => setMethod(item)}>{t.mergeMethodNames[item]}</button>)}</div></div>
      {method !== 'rebase' && edit && <textarea className="in" rows={4} value={text} maxLength={20000} aria-label={t.messageLabel} onChange={(event) => setText(event.target.value)} />}
      {commits !== null && <span className="pr-muted">{method === 'squash' ? t.squashInto(detail.base) : method === 'rebase' ? t.rebaseInto(commits, detail.base) : t.commitsInto(commits, detail.base)}</span>}
      <div><button type="button" className="mini" disabled={Boolean(reason) || busy} onClick={() => setAsking(true)}>{busy ? <Spinner /> : <MergeIcon />}{busy ? t.merging : t.mergeButton}</button></div>
    </div>
    {asking && <ConfirmDialog eyebrow={t.mergeTitle} title={t.mergeConfirmTitle} text={t.mergeConfirmText(detail.head, detail.base, method, del)} ok={t.mergeConfirmOk} danger={del} cancel={() => setAsking(false)} confirm={() => void run()} />}
  </div>
}

type Item = { at: string } & ({ kind: 'event'; author: string; body: string } | { kind: 'comment'; comment: PrComment } | { kind: 'review'; author: string; state: string; body: string } | { kind: 'thread'; thread: PrThread })
const time = (value: string): number => { const n = Date.parse(value); return Number.isNaN(n) ? 0 : n }

/** The lines a conversation points at (with two lines of context above), for the excerpt in the activity. */
function Excerpt({ thread, lines }: { thread: PrThread; lines: string[] | undefined }): React.JSX.Element | null {
  const rows = useMemo(() => lines ? parseFileDiff(lines) : [], [lines])
  const end = thread.line, start = thread.startLine ?? thread.line
  const hit = (row: (typeof rows)[number]): boolean => row.kind !== 'hunk' && (thread.side === 'new' ? row.kind !== 'del' && row.newLine !== null && row.newLine >= start && row.newLine <= end : row.kind !== 'add' && row.oldLine !== null && row.oldLine >= start && row.oldLine <= end)
  const first = rows.findIndex(hit), last = rows.length - 1 - [...rows].reverse().findIndex(hit)
  if (first < 0) return null
  const shown = rows.slice(Math.max(0, first - 2), last + 1).filter((row) => row.kind !== 'hunk')
  return <table className="prd-table unified pr-excerpt"><tbody>{shown.map((row) => <tr key={row.id} className={`prd-line ${row.kind} ${hit(row) ? 'sel' : ''}`}><td className="prd-ln"><span>{row.oldLine ?? ''}</span></td><td className="prd-ln"><span>{row.newLine ?? ''}</span></td><td className="prd-code"><span className="prd-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</span>{row.text}</td></tr>)}</tbody></table>
}

/**
 * Overview of a PR, in one column like GitLab: reactions, pipeline, approval, merge, the activity (history, comments, reviews and
 * line conversations with their code) and the comment box at the end.
 */
export function PrOverview({ sourceId, provider, detail, threads, setThreads, reactions, react, pipeline, commits, diffs, goPipelines, openFile, reload }: {
  sourceId: string; provider: 'github' | 'gitlab' | null; detail: PullRequestDetail; threads: PrThread[]; setThreads(update: (current: PrThread[]) => PrThread[]): void
  reactions: PullRequestDetail['reactions']; react(kind: 'up' | 'down'): void; pipeline: PrPipeline | null; commits: number | null; diffs: Map<string, { lines: string[] }>
  goPipelines(): void; openFile(path: string): void; reload(): void
}): React.JSX.Element {
  const t = useT().git.pr, ago = useAgo()
  const [text, setText] = useState(''), [busy, setBusy] = useState(''), [filter, setFilter] = useState<'all' | 'comments' | 'history'>('all')
  const act = async (name: string, run: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(name)
    try { await run(); setText(''); toast.success(done); reload() } catch (failure) { toast.error(t.failed, message(failure)) } finally { setBusy('') }
  }
  const review = (action: 'approve' | 'request-changes', body: string, done: string) => act(action, () => window.gearmod.invoke('prs:review', { sourceId, number: detail.number, action, body }), done)
  // General comments edited, reacted to or deleted here (null) until the next reload brings them from the host.
  const [touched, setTouched] = useState<Record<string, PrComment | null>>({})
  useEffect(() => setTouched({}), [detail])
  const items = useMemo((): Item[] => [
    ...detail.events.map((event) => ({ kind: 'event' as const, ...event })),
    ...detail.comments.flatMap((comment) => { const now = comment.id in touched ? touched[comment.id] : comment; return now ? [{ kind: 'comment' as const, comment: now, at: now.at }] : [] }),
    ...detail.reviews.filter((item) => item.at).map((item) => ({ kind: 'review' as const, ...item })),
    ...threads.map((thread) => ({ kind: 'thread' as const, thread, at: thread.comments[0]?.at ?? '' }))
  ].sort((a, b) => time(a.at) - time(b.at)), [detail, threads, touched])
  const quiet = (item: Item): boolean => item.kind === 'event' || (item.kind === 'review' && !item.body.trim())
  const shown = items.filter((item) => filter === 'all' || (filter === 'history' ? quiet(item) : !quiet(item)))
  const threadChanged = (next: PrThread): void => setThreads((current) => next.comments.length ? current.map((thread) => thread.id === next.id ? next : thread) : current.filter((thread) => thread.id !== next.id))
  const label = (status: string): string => t.pipeline[status] ?? status
  const replied = (threadId: string, comment: PrThreadComment): void => setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, comments: [...thread.comments, comment] } : thread))
  const resolved = (threadId: string, value: boolean): void => setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, resolved: value } : thread))
  const upload = provider === 'gitlab' ? async (file: File): Promise<string> => {
    const data = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000))
    try { return (await window.gearmod.invoke('prs:upload', { sourceId, name: file.name, dataBase64: btoa(binary) })).markdown } catch (failure) { toast.error(t.uploadFailed, message(failure)); return '' }
  } : undefined
  const open = detail.state === 'OPEN'
  return <div className="pr-overview">
    {detail.body.trim() && <div className="pr-card pr-desc"><div className="prs-text md"><Markdown source={detail.body} runnable={false} /></div></div>}
    <div className="pr-reacts">
      <button type="button" className={reactions.mineUp ? 'on' : ''} aria-pressed={reactions.mineUp} aria-label={t.likeTip} data-tip={t.likeTip} onClick={() => react('up')}><ThumbUpIcon />{reactions.up}</button>
      <button type="button" className={reactions.mineDown ? 'on' : ''} aria-pressed={reactions.mineDown} aria-label={t.dislikeTip} data-tip={t.dislikeTip} onClick={() => react('down')}><ThumbDownIcon />{reactions.down}</button>
    </div>
    {pipeline ? <div className="pr-card"><div className="pr-row"><StatusIcon status={pipeline.status === 'skipped' ? 'canceled' : pipeline.status} label={label(pipeline.status)} big />
      <span>{t.pipelineLine(pipeline.id, label(pipeline.status).toLowerCase())} <code className="pr-sha">{pipeline.sha.slice(0, 8)}</code>{pipeline.status === 'running' ? ` · ${t.jobsDone(pipeline.stages.flatMap((s) => s.jobs).filter((job) => job.status === 'success').length, pipeline.stages.flatMap((s) => s.jobs).length)}` : pipeline.duration !== null ? ` · ${duration(pipeline.duration)}` : ''}</span>
      <span className="pr-right"><StageDots pipeline={pipeline} label={label} /><button type="button" className="pr-link" onClick={goPipelines}>{t.seePipeline}<ChevronRightSmallIcon /></button></span></div></div>
      : detail.pipeline !== 'none' && <div className="pr-card"><div className="pr-row"><StatusIcon status={detail.pipeline} label={label(detail.pipeline)} big /><span>{t.pipelineLabel}: {label(detail.pipeline)}</span></div></div>}
    {open && <div className="pr-card"><div className="pr-row"><span className="ds-status pr-muted"><ApproverIcon /></span>
      {detail.approvedByMe ? <><span className="ds-chip tone-success"><i />{t.approvedByYou}</span>{detail.canUnapprove && <button type="button" className="mini secondary" disabled={Boolean(busy)} onClick={() => void act('unapprove', () => window.gearmod.invoke('prs:unapprove', { sourceId, number: detail.number }), t.unapproved)}>{busy === 'unapprove' ? <Spinner /> : null}{t.unapprove}</button>}</>
        : <button type="button" className="mini secondary" disabled={Boolean(busy)} onClick={() => void review('approve', '', t.approved)}>{busy === 'approve' ? <Spinner /> : <CheckIcon />}{t.approve}</button>}
      <span className="pr-muted">{detail.approvedBy.length ? t.approvedBy(detail.approvedBy.join(', ')) : t.approvalOptional}</span></div></div>}
    <MergeCard key={`${detail.number}:${detail.state}`} sourceId={sourceId} detail={detail} commits={commits} merged={reload} />

    <div className="pr-acthead"><h3>{t.activity}</h3><Select label={t.activityFilter} value={filter} options={(['all', 'comments', 'history'] as const).map((value) => ({ value, label: t.activityFilters[value] }))} onChange={(value) => setFilter(value as typeof filter)} /></div>
    <div className="pr-timeline">
      {!shown.length && <p className="gempty">{t.noActivity}</p>}
      {shown.map((item, index) => {
        if (item.kind === 'event' || (item.kind === 'review' && !item.body.trim())) return <div className="pr-ev" key={index}><b>{item.author}</b> {item.kind === 'event' ? <EventBody body={item.body} /> : t.review[item.state] ?? item.state.toLowerCase()} <span className="pr-muted" data-tip={fullDate(item.at)}>· {ago(item.at)}</span></div>
        if (item.kind === 'thread') { const first = item.thread.comments[0]
          return <div className="pr-note" key={`t${item.thread.id}`}><Avatar name={first?.author ?? ''} ai={isBot(first?.author ?? '')} />
            <div className="pr-notehead"><b>{first?.author}</b><span className="pr-muted">{t.commentedOn}</span><button type="button" className="pr-link pr-mono" onClick={() => openFile(item.thread.path)}>{item.thread.path}</button><span className="pr-muted" data-tip={fullDate(item.at)}>· {ago(item.at)}</span></div>
            <ThreadBox thread={item.thread} sourceId={sourceId} number={detail.number} replied={(comment) => replied(item.thread.id, comment)} resolved={(value) => resolved(item.thread.id, value)} changed={threadChanged}
              lead={<div className="pr-excerptbox"><div className="pr-excerpthead"><span className="pr-mono">{item.thread.path}</span><button type="button" className="pr-link" onClick={() => openFile(item.thread.path)}>{t.seeInFile}<ChevronRightSmallIcon /></button></div><Excerpt thread={item.thread} lines={diffs.get(item.thread.path)?.lines} /></div>} />
          </div> }
        if (item.kind === 'comment') { const comment = item.comment
          return <div className="pr-note" key={`c${comment.id || index}`}><Avatar name={comment.author} ai={isBot(comment.author)} />
            <div className="pr-notecard"><CommentView comment={comment} sourceId={sourceId} number={detail.number} changed={(next) => setTouched((current) => ({ ...current, [comment.id]: next }))} removed={() => setTouched((current) => ({ ...current, [comment.id]: null }))} /></div></div> }
        return <div className="pr-note" key={index}><Avatar name={item.author} ai={isBot(item.author)} />
          <div className="pr-notehead"><b>{item.author}</b>{item.kind === 'review' && <span className="pr-muted">{t.review[item.state] ?? item.state.toLowerCase()}</span>}<span className="pr-muted" data-tip={fullDate(item.at)}>· {ago(item.at)}</span></div>
          <div className="pr-notebody prs-text md"><Markdown source={item.body} runnable={false} /></div></div>
      })}
    </div>

    {open && <div className="pr-composer">
      <MarkdownEditor value={text} onChange={setText} label={t.commentOrReview} placeholder={t.commentPlaceholder} upload={upload} submit={() => { if (text.trim() && !busy) void act('comment', () => window.gearmod.invoke('prs:comment', { sourceId, number: detail.number, body: text }), t.commentPosted) }} />
      <div className="pr-acts">
        <button type="button" className="mini" disabled={Boolean(busy) || !text.trim()} onClick={() => void act('comment', () => window.gearmod.invoke('prs:comment', { sourceId, number: detail.number, body: text }), t.commentPosted)}>{busy === 'comment' ? <Spinner /> : <CommentIcon />}{busy === 'comment' ? t.commenting : t.comment}</button>
        {!detail.approvedByMe && <button type="button" className="mini secondary" disabled={Boolean(busy)} onClick={() => void review('approve', text, t.approved)}>{busy === 'approve' ? <Spinner /> : <CheckIcon />}{text.trim() ? t.commentAndApprove : t.approve}</button>}
        {provider !== 'gitlab' && <button type="button" className="mini danger" disabled={Boolean(busy) || !text.trim()} onClick={() => void review('request-changes', text, t.changesRequested)}>{busy === 'request-changes' ? <Spinner /> : null}{t.requestChanges}</button>}
        <span className="pr-muted">{t.ctrlEnter}</span>
      </div>
    </div>}
  </div>
}

/** Commits of the PR grouped by day: title, author, when and the hash to copy. */
export function PrCommits({ commits }: { commits: PrCommit[] | null }): React.JSX.Element {
  const t = useT().git.pr, ago = useAgo()
  if (!commits) return <div className="pr-pad"><Spinner /></div>
  if (!commits.length) return <p className="gempty pr-pad">{t.noCommits}</p>
  const groups = groupByDay([...commits].reverse(), (commit) => commit.at, shortDay)
  // The wrapper takes the page padding of .prs-scroll>*; the bordered list stays inside it.
  return <div><div className="pr-list">{groups.map((group) => <React.Fragment key={group.day}>
    <div className="pr-listday">{t.commitsOfDay(group.day, group.items.length)}</div>
    {group.items.map((commit) => <div className="pr-commit" key={commit.sha}><Avatar name={commit.author} email={commit.email} />
      <span className="pr-committext"><b>{commit.title}</b><span className="pr-muted">{commit.author} · <span data-tip={fullDate(commit.at)}>{ago(commit.at)}</span></span></span>
      <span className="rchip"><span className="rn">{commit.shortSha}</span></span><button type="button" className="pr-iconbtn" aria-label={t.copySha} data-tip={t.copySha} onClick={() => copyText(commit.sha, t.shaCopied, t.copyFailed)}><CopyIcon /></button></div>)}
  </React.Fragment>)}</div></div>
}
