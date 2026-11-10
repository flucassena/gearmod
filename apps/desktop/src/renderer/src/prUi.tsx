import React, { useContext, useRef, useState } from 'react'
import type { PrLabel, PullRequestDetail } from '@gearmod/contracts'
type PrReactions = PullRequestDetail['reactions']
import { Markdown } from './markdown'
import { useT, dateLocale } from './i18n'
import { useGravatar, usePhotosOn } from './gravatarSetting'
import {
  StatusSuccessIcon, StatusFailedIcon, StatusRunningIcon, StatusPendingIcon, StatusCanceledIcon, StatusManualIcon,
  BoldIcon, ItalicIcon, StrikeIcon, QuoteIcon, CodeIcon, LinkIcon, BulletListIcon, NumberedListIcon, TaskListIcon, TableIcon, PaperclipIcon, SparkIcon
} from './icons'

/** Status of a pipeline, job or check, as the PR screens show it. */
export type RunStatus = 'success' | 'failed' | 'running' | 'pending' | 'canceled' | 'skipped' | 'manual' | 'none'
/** Design system tone of each status: passed success, failed danger (always), running info, waiting for someone warning, the rest neutral. */
export const statusTone: Record<RunStatus, 'success' | 'danger' | 'info' | 'warning' | 'neutral'> = { success: 'success', failed: 'danger', running: 'info', pending: 'neutral', canceled: 'neutral', skipped: 'neutral', manual: 'warning', none: 'neutral' }
const statusIcon: Record<RunStatus, (props: { className?: string }) => React.JSX.Element> = { success: StatusSuccessIcon, failed: StatusFailedIcon, running: StatusRunningIcon, pending: StatusPendingIcon, canceled: StatusCanceledIcon, skipped: StatusCanceledIcon, manual: StatusManualIcon, none: StatusPendingIcon }

/** Phase of a spinner, fixed when it appears: a negative delay from the clock keeps every spinner in step and a redrawn one in place. */
function usePhase(): React.CSSProperties { const [phase] = useState(() => `-${Date.now() % 1000}ms`); return { '--ds-phase': phase } as React.CSSProperties }

/** Turning icon for "running" and "sending…" (the box turns, not the svg; see .ds-spin). */
export function Spinner({ className = '' }: { className?: string }): React.JSX.Element {
  return <span className={`ds-spin ${className}`} style={usePhase()} aria-hidden="true"><StatusRunningIcon /></span>
}

/** The status icon in its tone, with the status name as tooltip and label. */
export function StatusIcon({ status, label, big = false }: { status: RunStatus; label: string; big?: boolean }): React.JSX.Element {
  const Icon = statusIcon[status], phase = usePhase()
  return <span className={`ds-status tone-text tone-${statusTone[status]} ${big ? 'big' : ''} ${status === 'running' ? 'ds-spin' : ''}`} style={status === 'running' ? phase : undefined} role="img" aria-label={label} data-tip={label}><Icon /></span>
}

/** A project label: its own color is data from the host (outside the tones, like card type colors). */
export function LabelChip({ label }: { label: PrLabel }): React.JSX.Element {
  return <span className="ds-chip sm pr-label"><i className="ds-dot" style={{ background: label.color }} />{label.name}</span>
}

const initials = (name: string): string => { const parts = name.replace(/[@._-]+/g, ' ').trim().split(/\s+/).filter(Boolean); return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts.at(-1)![0] : parts[0]?.[1] ?? '')).toUpperCase() }
/** People of the open PR/MR: each login's photo as the host gave it, and who is looking (whose comments can be edited or deleted). */
export const PrPeopleContext = React.createContext<{ avatars: Record<string, string>; viewer: string | null; emails?: Record<string, string> }>({ avatars: {}, viewer: null })

/**
 * Round avatar: the person's photo when photos are on in Settings — the host's avatar for a login on the page, otherwise Gravatar by
 * email — or the initials; `ai` for the review bot (the AI is ✦ in info).
 */
export function Avatar({ name, email = '', ai = false, size = 'md' }: { name: string; email?: string; ai?: boolean; size?: 'sm' | 'md' }): React.JSX.Element {
  const people = useContext(PrPeopleContext), host = people.avatars[name], on = usePhotosOn(), [broken, setBroken] = useState(false)
  // Gravatar by e-mail first (given, or the login's e-mail known from the host); the host's own photo only when Gravatar has none.
  const gravatar = useGravatar(ai ? '' : email || people.emails?.[name] || '')
  const photo = ai ? null : gravatar ?? (on && host && !broken ? host : null)
  return <span className={`pr-av${size === 'sm' ? ' pr-av-sm' : ''}${ai ? ' pr-av-ai' : ''}`} aria-hidden="true">{ai ? <SparkIcon /> : photo ? <img src={photo} alt="" onError={() => setBroken(true)} /> : initials(name)}</span>
}
const entities: Record<string, string> = { lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' }
/** One line of a history note as plain text: `<code>` becomes backticks, other tags go, links keep only their label (relative ones, like GitLab's "Compare with previous version", go whole: they point inside the host's page). */
const eventLine = (value: string): string => value
  .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`').replace(/<[^>]+>/g, '')
  .replace(/\[([^\]]*)\]\((?!https?:)[^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/&(lt|gt|quot|#39|amp);/g, (_, name: string) => entities[name]!).replace(/\s+/g, ' ').trim()
/** A history note (GitLab system notes come with HTML lists and markdown links): its sentence and the list items under it. */
export function eventText(body: string): { text: string; items: string[] } {
  const items: string[] = []
  const rest = body.replace(/<ul>([\s\S]*?)<\/ul>/gi, (_, list: string) => { for (const match of list.matchAll(/<li>([\s\S]*?)<\/li>/gi)) { const item = eventLine(match[1] ?? ''); if (item) items.push(item) } return ' ' })
  return { text: eventLine(rest), items }
}
/** Text with `code` spans drawn as code. */
export function InlineCode({ text }: { text: string }): React.JSX.Element {
  return <>{text.split('`').map((part, index) => index % 2 ? <code key={index}>{part}</code> : part)}</>
}
/** A history note of the activity: the sentence, then its list (e.g. the commits added). */
export function EventBody({ body }: { body: string }): React.JSX.Element {
  const { text, items } = eventText(body)
  return <><InlineCode text={text} />{items.length > 0 && <ul className="pr-evlist">{items.map((item, index) => <li key={index}><InlineCode text={item} /></li>)}</ul>}</>
}

/** Whether an author is a bot (review bots of GitLab/GitHub). */
export const isBot = (author: string): boolean => /\bbot\b|\[bot\]|_bot_|^project_\d+_bot/i.test(author)

/** "há 3 h", "há 2 dias", or the date when older than a month. */
export function useAgo(): (value: string) => string {
  const t = useT().git.pr
  return (value: string): string => {
    const date = new Date(value), ms = Date.now() - date.getTime()
    if (Number.isNaN(date.getTime())) return ''
    const min = Math.round(ms / 60_000), h = Math.round(ms / 3_600_000), d = Math.round(ms / 86_400_000)
    if (min < 1) return t.ago.now
    if (min < 60) return t.ago.minutes(min)
    if (h < 24) return t.ago.hours(h)
    if (d < 30) return t.ago.days(d)
    return date.toLocaleDateString(dateLocale(), { dateStyle: 'short' })
  }
}
export const fullDate = (value: string): string => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' }) }
/** My 👍/👎 flipped at once, before the host answers (the click shows right away; a failure flips it back, the same call undoing it). */
export const toggleReaction = (r: PrReactions, kind: 'up' | 'down'): PrReactions => kind === 'up'
  ? { ...r, mineUp: !r.mineUp, up: Math.max(0, r.up + (r.mineUp ? -1 : 1)) }
  : { ...r, mineDown: !r.mineDown, down: Math.max(0, r.down + (r.mineDown ? -1 : 1)) }
export const shortDay = (value: string): string => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(dateLocale(), { dateStyle: 'short' }) }
/** "42 s", "3 min 12 s", "1 h 4 min". */
export const duration = (seconds: number | null): string => {
  if (seconds === null) return ''
  const s = Math.round(seconds)
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

type MdAction = 'bold' | 'italic' | 'strike' | 'quote' | 'code' | 'link' | 'ul' | 'ol' | 'task' | 'table'
/** Words put in place when nothing is selected (from the dictionary). */
export interface MdWords { text: string; code: string; column: string }
const markdownOf = (action: MdAction, words: MdWords): [string, string, string] => ({
  bold: ['**', '**', words.text], italic: ['_', '_', words.text], strike: ['~~', '~~', words.text], code: ['`', '`', words.code], link: ['[', '](https://)', words.text],
  quote: ['\n> ', '', ''], ul: ['\n- ', '', ''], ol: ['\n1. ', '', ''], task: ['\n- [ ] ', '', ''], table: [`\n| ${words.column} | ${words.column} |\n| --- | --- |\n| `, ' |  |\n', '']
} as Record<MdAction, [string, string, string]>)[action]
/** Wraps the selection (or a placeholder) with the markdown of the action; returns the new text and selection. */
export function applyMarkdown(text: string, start: number, end: number, action: MdAction, words: MdWords): { text: string; start: number; end: number } {
  const [open, close, placeholder] = markdownOf(action, words), picked = text.slice(start, end) || placeholder
  const before = text.slice(0, start), lead = open.startsWith('\n') && (before === '' || before.endsWith('\n')) ? open.slice(1) : open
  return { text: before + lead + picked + close + text.slice(end), start: start + lead.length, end: start + lead.length + picked.length }
}

/** Text with Write/Preview and the markdown toolbar (and attach, when the host takes uploads). Ctrl+Enter runs `submit`. */
export function MarkdownEditor({ value, onChange, placeholder, label, rows = 6, upload, submit, autoFocus = false }: {
  value: string; onChange(value: string): void; placeholder: string; label: string; rows?: number; upload?: (file: File) => Promise<string>; submit?: () => void; autoFocus?: boolean
}): React.JSX.Element {
  const t = useT().git.pr, area = useRef<HTMLTextAreaElement>(null), file = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState(false), [uploading, setUploading] = useState(false)
  const act = (action: MdAction): void => {
    const el = area.current; if (!el) return
    const next = applyMarkdown(value, el.selectionStart, el.selectionEnd, action, t.md.words)
    onChange(next.text)
    window.requestAnimationFrame(() => { el.focus(); el.setSelectionRange(next.start, next.end) })
  }
  const attach = async (picked: File | undefined): Promise<void> => {
    if (!picked || !upload) return
    setUploading(true)
    try { const markdown = await upload(picked); const el = area.current, at = el ? el.selectionEnd : value.length; onChange(`${value.slice(0, at)}${markdown}${value.slice(at)}`) } finally { setUploading(false); if (file.current) file.current.value = '' }
  }
  const tools: Array<[MdAction, React.ReactNode, string] | 'sep'> = [['bold', <BoldIcon />, t.md.bold], ['italic', <ItalicIcon />, t.md.italic], ['strike', <StrikeIcon />, t.md.strike], 'sep', ['quote', <QuoteIcon />, t.md.quote], ['code', <CodeIcon />, t.md.code], ['link', <LinkIcon />, t.md.link], 'sep', ['ul', <BulletListIcon />, t.md.ul], ['ol', <NumberedListIcon />, t.md.ol], ['task', <TaskListIcon />, t.md.task], ['table', <TableIcon />, t.md.table]]
  return <div className="pr-editor">
    <div className="pr-editor-bar">
      <div className="prseg" role="group" aria-label={label}><button type="button" className={!preview ? 'on' : ''} aria-pressed={!preview} onClick={() => setPreview(false)}>{t.write}</button><button type="button" className={preview ? 'on' : ''} aria-pressed={preview} onClick={() => setPreview(true)}>{t.preview}</button></div>
      {!preview && <span className="pr-editor-tools">{tools.map((tool, index) => tool === 'sep' ? <i key={index} className="pr-editor-sep" /> : <button type="button" key={tool[0]} className="pr-iconbtn" aria-label={tool[2]} data-tip={tool[2]} onClick={() => act(tool[0])}>{tool[1]}</button>)}
        {upload && <><i className="pr-editor-sep" /><button type="button" className="pr-iconbtn" aria-label={t.md.attach} data-tip={t.md.attach} disabled={uploading} onClick={() => file.current?.click()}>{uploading ? <Spinner /> : <PaperclipIcon />}</button><input ref={file} type="file" hidden onChange={(event) => void attach(event.target.files?.[0])} /></>}</span>}
    </div>
    {preview ? <div className="pr-editor-preview prs-text md">{value.trim() ? <Markdown source={value} runnable={false} /> : <p className="gempty">{t.nothingToPreview}</p>}</div>
      : <textarea ref={area} className="in" rows={rows} value={value} maxLength={20000} placeholder={placeholder} aria-label={label} autoFocus={autoFocus} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && submit) { event.preventDefault(); submit() } }} />}
    <div className="pr-editor-foot">{t.md.hint}</div>
  </div>
}
