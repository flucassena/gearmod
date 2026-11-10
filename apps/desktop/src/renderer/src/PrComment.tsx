import React, { useContext, useState } from 'react'
import type { PullRequestDetail } from '@gearmod/contracts'
import { toast } from './toasts'
import { plainError } from './NoticeDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { GitMenu } from './BranchMenu'
import { Markdown } from './markdown'
import { useT } from './i18n'
import { CheckIcon, LinkIcon, MoreIcon, PencilIcon, ResolveIcon, SmileIcon, ThumbDownIcon, ThumbUpIcon, TrashIcon } from './icons'
import { Avatar, MarkdownEditor, PrPeopleContext, Spinner, fullDate, isBot, toggleReaction, useAgo } from './prUi'

export type PrComment = PullRequestDetail['threads'][number]['comments'][number]
type Spot = { x: number; y: number }
const below = (event: React.MouseEvent<HTMLElement>): Spot => { const box = event.currentTarget.getBoundingClientRect(); return { x: box.right - 230, y: box.bottom + 4 } }

/**
 * One comment, as GitLab draws it: photo, author and when; on the right resolve (first comment of a thread), react (👍/👎), edit
 * (own comments) and ⋮ with copy link and delete (own comments; the host refuses what it does not allow). Its reactions sit under the text.
 */
export function CommentView({ comment, sourceId, number, resolve, changed, removed }: {
  comment: PrComment; sourceId: string; number: number
  resolve?: { resolved: boolean; busy: boolean; toggle(): void }
  changed(comment: PrComment): void; removed(): void
}): React.JSX.Element {
  const t = useT().git.pr, ago = useAgo(), viewer = useContext(PrPeopleContext).viewer
  const [editing, setEditing] = useState(false), [text, setText] = useState(comment.body), [busy, setBusy] = useState('')
  const [menu, setMenu] = useState<Spot>(), [pick, setPick] = useState<Spot>(), [confirm, setConfirm] = useState(false)
  // A comment just sent through an older path may lack an id: then only reading is possible.
  const known = /^\d{1,20}$/.test(comment.id), mine = known && Boolean(viewer && comment.author === viewer)
  const call = (action: 'edit' | 'delete' | 'react', extra: { body?: string; reaction?: 'up' | 'down' } = {}) => window.gearmod.invoke('prs:note', { sourceId, number, kind: comment.kind, id: comment.id, action, ...extra })
  const save = async (): Promise<void> => {
    setBusy('edit')
    try { const result = await call('edit', { body: text }); changed({ ...comment, body: result.body ?? text }); setEditing(false) } catch (reason) { toast.error(t.commentEditFailed, plainError(reason)) } finally { setBusy('') }
  }
  // Shows the click at once; the host's answer then sets the true counts, and a failure puts the comment's reactions back.
  const react = async (kind: 'up' | 'down'): Promise<void> => {
    setPick(undefined)
    changed({ ...comment, reactions: toggleReaction(comment.reactions, kind) })
    try { const result = await call('react', { reaction: kind }); if (result.reactions) changed({ ...comment, reactions: result.reactions }) } catch (reason) { changed(comment); toast.error(t.reactFailed, plainError(reason)) }
  }
  const remove = async (): Promise<void> => {
    setConfirm(false); setBusy('delete')
    try { await call('delete'); toast.success(t.commentDeleted); removed() } catch (reason) { toast.error(t.commentDeleteFailed, plainError(reason)); setBusy('') }
  }
  const copyLink = (): void => { void navigator.clipboard.writeText(comment.url).then(() => toast.success(t.linkCopied), () => toast.error(t.copyFailed)) }
  const reactions = comment.reactions
  const menuItems = [...(comment.url ? [{ key: 'link' as const, label: t.copyLink, icon: <LinkIcon /> }] : []), ...(mine ? [{ key: 'delete' as const, label: t.deleteComment, danger: true, icon: <TrashIcon /> }] : [])]
  return <div className="prc-note">
    <div className="prc-notehead">
      <Avatar name={comment.author} ai={isBot(comment.author)} size="sm" />
      <b>{comment.author}</b><span className="pr-muted" data-tip={fullDate(comment.at)}>· {ago(comment.at)}</span>
      <span className="prc-noteacts">
        {resolve && <button type="button" className={`pr-iconbtn ${resolve.resolved ? 'on' : ''}`} disabled={resolve.busy} aria-pressed={resolve.resolved} aria-label={resolve.resolved ? t.reopenThread : t.resolveThread} data-tip={resolve.resolved ? t.reopenThread : t.resolveThread} onClick={resolve.toggle}>{resolve.busy ? <Spinner /> : <ResolveIcon />}</button>}
        {known && <button type="button" className="pr-iconbtn" aria-label={t.reactTip} data-tip={t.reactTip} aria-haspopup="menu" onClick={(event) => setPick(pick ? undefined : below(event))}><SmileIcon /></button>}
        {mine && <button type="button" className="pr-iconbtn" aria-label={t.editComment} data-tip={t.editComment} onClick={() => { setText(comment.body); setEditing(true) }}><PencilIcon /></button>}
        {menuItems.length > 0 && <button type="button" className="pr-iconbtn" disabled={busy === 'delete'} aria-label={t.commentActions} data-tip={t.commentActions} aria-haspopup="menu" onClick={(event) => setMenu(menu ? undefined : below(event))}>{busy === 'delete' ? <Spinner /> : <MoreIcon />}</button>}
      </span>
    </div>
    {editing
      ? <div className="prc-noteedit"><MarkdownEditor value={text} onChange={setText} label={t.editComment} placeholder={t.replyPlaceholder} rows={4} submit={() => { if (text.trim() && !busy) void save() }} />
        <div className="pr-acts"><button type="button" className="mini" disabled={Boolean(busy) || !text.trim()} onClick={() => void save()}>{busy === 'edit' ? <Spinner /> : <CheckIcon />}{t.saveComment}</button><button type="button" className="mini secondary" onClick={() => setEditing(false)}>{t.cancel}</button></div></div>
      : <div className="prs-text md prc-notebody"><Markdown source={comment.body} runnable={false} /></div>}
    {(reactions.up > 0 || reactions.down > 0) && <div className="pr-reacts prc-reacts">
      {reactions.up > 0 && <button type="button" className={reactions.mineUp ? 'on' : ''} aria-pressed={reactions.mineUp} aria-label={t.likeTip} data-tip={t.likeTip} disabled={!known} onClick={() => void react('up')}><ThumbUpIcon />{reactions.up}</button>}
      {reactions.down > 0 && <button type="button" className={reactions.mineDown ? 'on' : ''} aria-pressed={reactions.mineDown} aria-label={t.dislikeTip} data-tip={t.dislikeTip} disabled={!known} onClick={() => void react('down')}><ThumbDownIcon />{reactions.down}</button>}</div>}
    {pick && <GitMenu x={pick.x} y={pick.y} title={t.reactTip} label={t.reactTip} items={[{ key: 'up' as const, label: t.likeTip, icon: <ThumbUpIcon /> }, { key: 'down' as const, label: t.dislikeTip, icon: <ThumbDownIcon /> }]} run={(key) => void react(key)} close={() => setPick(undefined)} />}
    {menu && <GitMenu x={menu.x} y={menu.y} title={comment.author} label={t.commentActions} items={menuItems} run={(key) => { setMenu(undefined); if (key === 'link') copyLink(); else setConfirm(true) }} close={() => setMenu(undefined)} />}
    {confirm && <ConfirmDialog eyebrow={t.deleteCommentEyebrow} title={t.deleteCommentTitle} text={t.deleteCommentText} ok={t.deleteComment} danger cancel={() => setConfirm(false)} confirm={() => void remove()} />}
  </div>
}
