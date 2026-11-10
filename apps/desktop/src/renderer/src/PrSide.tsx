import React, { useEffect, useMemo, useState } from 'react'
import type { PrCreateOptions, PullRequestDetail } from '@gearmod/contracts'
import { useT } from './i18n'
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon } from './icons'
import { Avatar, LabelChip, Spinner, shortDay } from './prUi'
import { copyText } from './PrOverview'
import type { PrThread } from './PrDiffFile'
import { MultiSelect } from './MultiSelect'
import { Select, type SelectOption } from './Select'
import { toast } from './toasts'
import { plainError } from './NoticeDialog'

const KEY = 'gearmod.prSideHidden'
const readHidden = (): boolean => { try { return window.localStorage.getItem(KEY) === '1' } catch { return false } }
const saveHidden = (value: boolean): void => { try { window.localStorage.setItem(KEY, value ? '1' : '0') } catch { /* only a convenience */ } }

/** Short reference of the request as the host writes it: `group/project!261` (GitLab) or `owner/repo#5` (GitHub); the URL when it fits neither. */
export function prReference(url: string, number: number): string {
  const gitlab = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/.exec(url)
  if (gitlab) return `${gitlab[1]}!${number}`
  const github = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url)
  return github ? `${github[1]}#${number}` : url
}

type Field = 'assignees' | 'reviewers' | 'labels' | 'milestone'
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((item) => b.includes(item))

/**
 * Fixed column on the right of an open PR/MR, as GitLab's: assignee, reviewers, labels, milestone, participants, reference and source
 * branch. "Editar" turns that field into its picker right here and "Concluir" saves it (open requests only); › folds the column into a
 * thin strip, remembered on this machine.
 */
export function PrSide({ sourceId, detail, author, threads, editable, saved }: {
  sourceId: string; detail: PullRequestDetail; author: string; threads: PrThread[]; editable: boolean; saved(): void
}): React.JSX.Element {
  const t = useT().git.pr
  const [hidden, setHidden] = useState(readHidden)
  const [editing, setEditing] = useState<Field | null>(null), [draft, setDraft] = useState<string[]>([]), [saving, setSaving] = useState(false)
  const [options, setOptions] = useState<PrCreateOptions>()
  const fold = (value: boolean): void => { setHidden(value); saveHidden(value) }
  useEffect(() => {
    if (!editable || options) return
    let alive = true
    void window.gearmod.invoke('prs:create-options', { sourceId }).then((value) => { if (alive) setOptions(value) }, () => undefined)
    return () => { alive = false }
  }, [editable, options, sourceId])
  const participants = useMemo(() => {
    const seen = new Set<string>()
    const add = (login: string | undefined): void => { if (login) seen.add(login) }
    add(author)
    detail.assignees.forEach((person) => add(person.login)); detail.reviewers.forEach((person) => add(person.login))
    detail.comments.forEach((comment) => add(comment.author)); threads.forEach((thread) => thread.comments.forEach((comment) => add(comment.author)))
    detail.events.forEach((event) => add(event.author))
    return [...seen]
  }, [detail, author, threads])

  const current = (field: Field): string[] => field === 'milestone' ? [detail.milestone ?? 'none'] : field === 'labels' ? detail.labels.map((label) => label.name) : detail[field].map((person) => person.login)
  const start = (field: Field): void => { setEditing(field); setDraft(current(field)) }
  const finish = async (): Promise<void> => {
    const field = editing
    if (!field) return
    if (sameSet(draft, current(field))) { setEditing(null); return }
    setSaving(true)
    try {
      const change = field === 'milestone' ? { milestone: draft[0] && draft[0] !== 'none' ? draft[0] : null } : { [field]: draft }
      const result = await window.gearmod.invoke('prs:update', { sourceId, number: detail.number, ...change })
      toast.success(t.savedRequest)
      if (result.warning) toast.info(result.warning)
      setEditing(null); saved()
    } catch (reason) { toast.error(t.saveFailed, plainError(reason)) } finally { setSaving(false) }
  }

  if (hidden) return <aside className="prs-side folded" aria-label={t.sideAria}>
    <button type="button" className="pr-iconbtn" aria-label={t.showSide} data-tip={t.showSide} onClick={() => fold(false)}><ChevronLeftIcon /></button>
  </aside>

  const viewer = options?.viewer ?? detail.viewer
  const people: SelectOption[] = (options?.members ?? []).map((person) => ({ value: person.login, label: person.login === viewer ? t.youName(person.name || person.login) : person.name || person.login, icon: <Avatar name={person.login} size="sm" /> }))
  const showPeople = (chosen: SelectOption[]): React.ReactNode => chosen.map((option) => <span key={option.value} className="msel-name">{option.icon}{option.label}</span>)
  const supported = (field: Field): boolean => !options || options.supports[field] !== false
  const picker = (field: Field): React.JSX.Element => {
    if (!options) return <Spinner />
    if (field === 'milestone') return <Select label={t.milestone} value={draft[0] ?? 'none'} onChange={(value) => setDraft([value])}
      options={[{ value: 'none', label: t.noMilestone }, ...options.milestones.map((item) => ({ value: item.id, label: item.title, ...(item.due ? { sub: t.dueOn(shortDay(item.due)) } : {}) }))]} />
    if (field === 'labels') return <MultiSelect label={t.labels} empty={t.noLabels} filterPlaceholder={t.filterLabels} value={draft} onChange={setDraft}
      options={options.labels.map((label) => ({ value: label.name, label: label.name, icon: <i className="ds-dot" style={{ background: label.color }} /> }))}
      chosen={(chosen) => chosen.map((option) => { const label = options.labels.find((item) => item.name === option.value); return label ? <LabelChip key={option.value} label={label} /> : null })} />
    return <MultiSelect label={field === 'assignees' ? t.assignee : t.reviewers} empty={t.nobody} filterPlaceholder={t.filterPeople} value={draft} onChange={setDraft} chosen={showPeople}
      options={field === 'reviewers' ? people.filter((person) => person.value !== viewer) : people} />
  }
  const head = (title: string, field: Field): React.JSX.Element => <div className="psd-head"><b>{title}</b>
    {editable && supported(field) && (editing === field
      ? <button type="button" className="pr-link" disabled={saving} onClick={() => void finish()}>{saving && <Spinner />}{t.doneSide}</button>
      : <button type="button" className="pr-link" disabled={saving || editing !== null} onClick={() => start(field)}>{t.editSide}</button>)}</div>
  const body = (field: Field, view: React.ReactNode): React.ReactNode => editing === field
    ? <div className="psd-edit">{picker(field)}<button type="button" className="pr-link psd-cancel" disabled={saving} onClick={() => setEditing(null)}>{t.cancel}</button></div>
    : view
  const list = (persons: PullRequestDetail['assignees']): React.JSX.Element => persons.length
    ? <div className="psd-people">{persons.map((person) => <span className="psd-person" key={person.login}><Avatar name={person.login} size="sm" /><span>{person.name || person.login}</span></span>)}</div>
    : <span className="pr-muted">{t.noneYet}</span>
  const reference = prReference(detail.url, detail.number)
  return <aside className="prs-side" aria-label={t.sideAria}>
    <div className="psd-top"><button type="button" className="pr-iconbtn" aria-label={t.hideSide} data-tip={t.hideSide} onClick={() => fold(true)}><ChevronRightIcon /></button></div>
    <section className="psd-sec">{head(t.assignee, 'assignees')}{body('assignees', list(detail.assignees))}</section>
    <section className="psd-sec">{head(t.reviewers, 'reviewers')}{body('reviewers', list(detail.reviewers))}</section>
    <section className="psd-sec">{head(t.labels, 'labels')}{body('labels', detail.labels.length
      ? <div className="psd-labels">{detail.labels.map((label) => <LabelChip key={label.name} label={label} />)}</div> : <span className="pr-muted">{t.noLabels}</span>)}</section>
    <section className="psd-sec">{head(t.milestone, 'milestone')}{body('milestone', <span className={detail.milestoneTitle ? '' : 'pr-muted'}>{detail.milestoneTitle ?? t.noMilestone}</span>)}</section>
    <section className="psd-sec"><div className="psd-head"><b>{t.participants(participants.length)}</b></div>
      <div className="psd-avatars">{participants.map((login) => <span key={login} data-tip={login}><Avatar name={login} /></span>)}</div></section>
    <section className="psd-sec psd-refs">
      <div className="psd-ref"><span className="pr-muted">{t.reference}:</span><span className="psd-val" title={reference}>{reference}</span>
        <button type="button" className="pr-iconbtn" aria-label={t.copyReference} data-tip={t.copyReference} onClick={() => copyText(reference, t.referenceCopied, t.copyFailed)}><CopyIcon /></button></div>
      <div className="psd-ref"><span className="pr-muted">{t.sourceBranch}:</span><span className="psd-val pr-mono" title={detail.head}>{detail.head}</span>
        <button type="button" className="pr-iconbtn" aria-label={t.copyBranch} data-tip={t.copyBranch} onClick={() => copyText(detail.head, t.branchCopied, t.copyFailed)}><CopyIcon /></button></div>
    </section>
  </aside>
}
