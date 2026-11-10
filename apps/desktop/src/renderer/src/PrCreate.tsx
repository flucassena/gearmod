import React, { useEffect, useState } from 'react'
import type { PrCompare, PrCreateOptions, PullRequestDetail } from '@gearmod/contracts'
import { toast } from './toasts'
import { plainError } from './NoticeDialog'
import { Select, type SelectOption } from './Select'
import { MultiSelect } from './MultiSelect'
import { Checkbox } from './Checkbox'
import { useT } from './i18n'
import { groupByDay } from './prFilters'
import { ApproverIcon, CheckIcon, CloseIcon, CopyIcon, LabelIcon, MergeIcon, MilestoneIcon, PersonIcon, PullRequestIcon } from './icons'
import { Avatar, LabelChip, MarkdownEditor, Spinner, shortDay, useAgo } from './prUi'
import { copyText } from './PrOverview'

const toBase64 = async (file: File): Promise<string> => { const data = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000)); return btoa(binary) }

/** The MR being edited (the "Editar" of an open PR/MR): the form opens filled with it, the source branch stays fixed and only what changed is sent. */
export interface PrEdit { number: number; ref: string; provider: 'github' | 'gitlab' | null; detail: PullRequestDetail }
const DRAFT_PREFIX = /^\s*(\[draft\]|\(draft\)|draft:|wip:|\[wip\])\s*/i
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((item) => b.includes(item))

/**
 * New PR/MR (PR mode): branches with what goes in (commits ahead, files), title from the branch, draft, description with markdown,
 * and on the side assignee, reviewers, milestone, labels and merge options (what the host accepts). Below, the commits and files that go in.
 * With `edit` it is the "Editar" screen of an open one (same fields, filled; "Salvar alterações").
 */
export function PrCreate({ sourceId, branches, head, back, created, edit, saved }: { sourceId: string; branches: string[]; head: string | null; back(): void; created?(number: number | null): void; edit?: PrEdit; saved?(): void }): React.JSX.Element {
  const t = useT().git.pr, ago = useAgo()
  const e = edit?.detail
  const [from, setFrom] = useState(e ? e.head : head && branches.includes(head) ? head : branches[0] ?? ''), [base, setBase] = useState(() => e ? e.base : ['main', 'master', 'develop'].find((name) => branches.includes(name) && name !== head) ?? branches.find((name) => name !== head) ?? '')
  const startTitle = e ? e.title.replace(DRAFT_PREFIX, '') : from
  const [title, setTitle] = useState(startTitle), [titleEdited, setTitleEdited] = useState(Boolean(e)), [body, setBody] = useState(e?.body ?? ''), [draft, setDraft] = useState(e?.draft ?? false), [busy, setBusy] = useState(false)
  const [options, setOptions] = useState<PrCreateOptions>(), [assignees, setAssignees] = useState<string[]>(() => e?.assignees.map((person) => person.login) ?? []), [reviewers, setReviewers] = useState<string[]>(() => e?.reviewers.map((person) => person.login) ?? []), [milestone, setMilestone] = useState(e?.milestone ?? 'none'), [labels, setLabels] = useState<string[]>(() => e?.labels.map((label) => label.name) ?? [])
  const [deleteSource, setDeleteSource] = useState(e ? e.removeSourceOnMerge ?? false : true), [squash, setSquash] = useState(e?.squashOnMerge ?? false)
  const [compare, setCompare] = useState<PrCompare | null>(), [tab, setTab] = useState<'commits' | 'files'>('commits')
  // Target: the repository's default branch (origin/HEAD), when Git knows it (a new request only).
  useEffect(() => { if (edit) return; let alive = true; void window.gearmod.invoke('prs:default-base', { sourceId }).then(({ branch }) => { if (alive && branch && branches.includes(branch)) { setBase((current) => branch !== from ? branch : current) } }).catch(() => undefined); return () => { alive = false } }, [sourceId])
  useEffect(() => { let alive = true; void window.gearmod.invoke('prs:create-options', { sourceId }).then((value) => { if (alive) setOptions(value) }, () => undefined); return () => { alive = false } }, [sourceId])
  // What would go in: asked again (after a short pause) when a branch changes. Not when editing (the MR's tabs already show it).
  useEffect(() => {
    if (edit || !from || !base || from === base) { setCompare(null); return }
    let alive = true; setCompare(undefined)
    const timer = window.setTimeout(() => { void window.gearmod.invoke('prs:compare', { sourceId, head: from, base }).then((value) => { if (alive) setCompare(value) }, () => { if (alive) setCompare(null) }) }, 200)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [sourceId, from, base])
  // Title and description come from the newest commit going in; the branch name when there is none. Never over what was typed.
  const [titleSource, setTitleSource] = useState<'branch' | 'commit'>('branch'), [autoBody, setAutoBody] = useState('')
  useEffect(() => {
    if (edit || !compare || titleEdited) return
    const only = compare.ahead > 0 ? compare.commits[0] : undefined
    setTitle(only?.title || from); setTitleSource(only?.title ? 'commit' : 'branch')
    const next = only ? compare.message : ''
    setBody((current) => current === autoBody ? next : current); setAutoBody(next)
  }, [compare])
  const pickFrom = (value: string): void => { setFrom(value); if (!titleEdited) { setTitle(value); setTitleSource('branch') } if (value === base) setBase(branches.find((name) => name !== value) ?? '') }
  const supports = options?.supports
  const nothing = compare !== undefined && compare !== null && compare.ahead === 0
  // GitHub's REST API cannot change the draft of an open PR: the checkbox stays out when editing there.
  const canDraft = !edit || edit.provider === 'gitlab'
  const save = async (current: PrEdit): Promise<void> => {
    const d = current.detail, changes: { title?: string; body?: string; base?: string; draft?: boolean; assignees?: string[]; reviewers?: string[]; milestone?: string | null; labels?: string[]; squash?: boolean; deleteSourceBranch?: boolean } = {}
    if (title.trim() !== startTitle) changes.title = title.trim()
    if (body !== d.body) changes.body = body
    if (base !== d.base) changes.base = base
    if (canDraft && draft !== d.draft) changes.draft = draft
    if (!sameSet(assignees, d.assignees.map((person) => person.login))) changes.assignees = assignees
    if (!sameSet(reviewers, d.reviewers.map((person) => person.login))) changes.reviewers = reviewers
    if ((milestone === 'none' ? null : milestone) !== d.milestone) changes.milestone = milestone === 'none' ? null : milestone
    if (!sameSet(labels, d.labels.map((label) => label.name))) changes.labels = labels
    if (supports?.squash && squash !== (d.squashOnMerge ?? false)) changes.squash = squash
    if (supports?.deleteSource && deleteSource !== (d.removeSourceOnMerge ?? false)) changes.deleteSourceBranch = deleteSource
    if (!Object.keys(changes).length) { saved?.(); return }
    const result = await window.gearmod.invoke('prs:update', { sourceId, number: current.number, ...changes })
    toast.success(t.savedRequest)
    if (result.warning) toast.info(result.warning)
    saved?.()
  }
  const submit = async (event?: React.FormEvent): Promise<void> => {
    event?.preventDefault(); setBusy(true)
    if (edit) { try { await save(edit) } catch (reason) { toast.error(t.saveFailed, plainError(reason)) } finally { setBusy(false) } return }
    try {
      const result = await window.gearmod.invoke('prs:create', { sourceId, head: from, base, title, body, draft,
        ...(supports?.squash ? { squash } : {}), ...(supports?.deleteSource ? { deleteSourceBranch: deleteSource } : {}),
        ...(assignees.length ? { assignees } : {}), ...(reviewers.length ? { reviewers } : {}), ...(milestone !== 'none' ? { milestone } : {}), ...(labels.length ? { labels } : {}) })
      toast.success(t.opened, result.url)
      if (result.warning) toast.info(result.warning)
      const number = result.number ?? Number(/(\d+)\/?$/.exec(result.url)?.[1])
      created?.(Number.isFinite(number) && number > 0 ? number : null)
    } catch (reason) { toast.error(t.createFailed, plainError(reason)) } finally { setBusy(false) }
  }
  const upload = supports?.uploads ? async (file: File): Promise<string> => {
    try { return (await window.gearmod.invoke('prs:upload', { sourceId, name: file.name, dataBase64: await toBase64(file) })).markdown } catch (reason) { toast.error(t.uploadFailed, plainError(reason)); return '' }
  } : undefined
  const viewer = options?.viewer ?? null
  const people = (options?.members ?? []).map((person) => ({ value: person.login, label: person.login === viewer ? t.youName(person.name || person.login) : person.name || person.login, icon: <Avatar name={person.name || person.login} size="sm" /> }))
  const labelOptions = (options?.labels ?? []).map((label) => ({ value: label.name, label: label.name, icon: <i className="ds-dot" style={{ background: label.color }} /> }))
  const showPeople = (chosen: SelectOption[]): React.ReactNode => chosen.map((option) => <span key={option.value} className="msel-name">{option.icon}{option.label}</span>)
  const showLabels = (chosen: SelectOption[]): React.ReactNode => chosen.map((option) => { const label = options?.labels.find((item) => item.name === option.value); return label ? <LabelChip key={option.value} label={label} /> : null })
  const groups = compare ? groupByDay(compare.commits, (commit) => commit.at, shortDay) : []
  return <form className="prcreate" onSubmit={(event) => void submit(event)}>
    <div className="prc-scroll"><div className="prc-body">
      <button type="button" className="pr-iconbtn prs-close" onClick={back} aria-label={edit ? t.cancelEdit : t.cancelNew} data-tip={edit ? t.cancelEdit : t.cancelNew}><CloseIcon /></button>
      <h2>{edit ? t.editTitle(edit.ref) : t.newRequestTitle}</h2>
      <div className="prc-branches">
        <div className="f"><span className="cglabel">{t.fromBranch}</span>{edit ? <span className="prc-fixed"><span className="rchip"><span className="rn">{from}</span></span></span> : <Select label={t.fromBranch} value={from} options={branches.map((name) => ({ value: name, label: name }))} onChange={pickFrom} />}</div>
        <div className="f"><span className="cglabel">{t.toBranch}</span><Select label={t.toBranch} value={base} options={[...new Set([...(edit ? [edit.detail.base] : []), ...branches])].filter((name) => name !== from).map((name) => ({ value: name, label: name }))} onChange={setBase} /></div>
      </div>
      {!edit && <div className="prc-compare">{compare === undefined ? <><Spinner /><span className="pr-muted">{t.comparing}</span></>
        : compare === null ? from === base ? <div className="ds-note tone-danger"><span className="ds-note-i">!</span><span>{t.sameBranch}</span></div> : null
        : compare.ahead === 0 ? <><span className="ds-chip sm tone-warning">{t.noNewCommits}</span><span className="pr-muted">{t.nothingNew(from, base)}</span></>
        : <><span className="ds-chip sm tone-info">{t.commitsAhead(compare.ahead)}</span><span className="pr-muted">{t.filesCount(compare.files.length)}</span><span className="nums"><span className="p">+{compare.additions}</span> <span className="m">−{compare.deletions}</span></span></>}</div>}
      <div className="prc-cols">
        <div className="prc-main">
          <label className="f"><span className="cglabel">{t.title}</span><input className="in" value={title} maxLength={240} onChange={(event) => { setTitle(event.target.value); setTitleEdited(true) }} autoFocus />{!titleEdited && <small className="hint">{titleSource === 'commit' ? t.titleFromCommit : t.titleFromBranch}</small>}</label>
          {canDraft && <div className="f"><label className="pr-check"><Checkbox checked={draft} onChange={setDraft} />{edit ? t.markDraftOption : t.openAsDraft}</label><small className="hint prc-sub">{t.draftHint}</small></div>}
          <div className="f"><span className="cglabel">{t.description}</span><MarkdownEditor value={body} onChange={setBody} label={t.description} placeholder={t.descriptionPlaceholder} rows={8} upload={upload} submit={() => { if (!busy && title.trim() && !nothing) void submit() }} /></div>
        </div>
        <aside className="prc-side">
          {supports?.assignees !== false && <div className="f"><div className="prc-fh"><PersonIcon /><span className="cglabel">{t.assignee}</span>{viewer && <button type="button" className="pr-link" onClick={() => setAssignees((list) => list.includes(viewer) ? list : [...list, viewer])}>{t.assignToMe}</button>}</div>
            <MultiSelect label={t.assignee} empty={t.nobody} filterPlaceholder={t.filterPeople} options={people} value={assignees} onChange={setAssignees} chosen={showPeople} /></div>}
          {supports?.reviewers !== false && <div className="f"><div className="prc-fh"><ApproverIcon /><span className="cglabel">{t.reviewers}</span></div>
            <MultiSelect label={t.reviewers} empty={t.nobody} filterPlaceholder={t.filterPeople} options={people.filter((person) => person.value !== viewer)} value={reviewers} onChange={setReviewers} chosen={showPeople} /></div>}
          {supports?.milestone !== false && <div className="f"><div className="prc-fh"><MilestoneIcon /><span className="cglabel">{t.milestone}</span></div>
            <Select label={t.milestone} value={milestone} options={[{ value: 'none', label: t.noMilestone }, ...(options?.milestones ?? []).map((item) => ({ value: item.id, label: item.title, ...(item.due ? { sub: t.dueOn(shortDay(item.due)) } : {}) }))]} onChange={setMilestone} /></div>}
          {supports?.labels !== false && <div className="f"><div className="prc-fh"><LabelIcon /><span className="cglabel">{t.labels}</span></div>
            <MultiSelect label={t.labels} empty={t.noLabels} filterPlaceholder={t.filterLabels} options={labelOptions} value={labels} onChange={setLabels} chosen={showLabels} /></div>}
          {(supports?.deleteSource || supports?.squash) && <div className="f"><div className="prc-fh"><MergeIcon /><span className="cglabel">{t.mergeOptions}</span></div>
            {supports.deleteSource && <label className="pr-check"><Checkbox checked={deleteSource} onChange={setDeleteSource} />{t.deleteSourceOnAccept}</label>}
            {supports.squash && <label className="pr-check"><Checkbox checked={squash} onChange={setSquash} />{t.squashOnAccept}</label>}</div>}
        </aside>
      </div>
      {!edit && <p className="hint">{t.willPush(from)}</p>}
      <div className="pr-acts">{edit
        ? <button type="submit" className="mini" disabled={busy || !base || !title.trim() || from === base}>{busy ? <Spinner /> : <CheckIcon />}{busy ? t.saving : t.saveChanges}</button>
        : <button type="submit" className="mini" disabled={busy || !from || !base || !title.trim() || from === base || nothing}>{busy ? <Spinner /> : <PullRequestIcon />}{busy ? t.creating : t.create}</button>}
        <button type="button" className="mini secondary" onClick={back}>{t.cancel}</button></div>

      {!edit && compare && compare.ahead > 0 && <>
        <div className="pr-tabs prc-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'commits'} className={tab === 'commits' ? 'on' : ''} onClick={() => setTab('commits')}>{t.prTabs.commits}<span className="ds-count">{compare.commits.length}</span></button>
          <button type="button" role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>{t.prTabs.changes}<span className="ds-count">{compare.files.length}</span></button></div>
        <div className="pr-list">{tab === 'commits'
          ? groups.map((group) => <React.Fragment key={group.day}><div className="pr-listday">{t.commitsOfDay(group.day, group.items.length)}</div>
            {group.items.map((commit) => <div className="pr-commit" key={commit.sha}><Avatar name={commit.author} email={commit.email} /><span className="pr-committext"><b>{commit.title}</b><span className="pr-muted">{commit.author} · {ago(commit.at)}</span></span>
              <span className="rchip"><span className="rn">{commit.shortSha}</span></span><button type="button" className="pr-iconbtn" aria-label={t.copySha} data-tip={t.copySha} onClick={() => copyText(commit.sha, t.shaCopied, t.copyFailed)}><CopyIcon /></button></div>)}</React.Fragment>)
          : compare.files.map((file) => <div className="pr-file" key={file.path}><span className={`prf-st ${file.status}`} aria-label={t.fileStatus[file.status]}>{file.status === 'added' ? 'A' : file.status === 'removed' ? 'D' : file.status === 'renamed' ? 'R' : 'M'}</span><span className="pr-mono">{file.path}</span><span className="nums"><span className="p">+{file.additions}</span> <span className="m">−{file.deletions}</span></span></div>)}</div>
      </>}
    </div></div>
  </form>
}
