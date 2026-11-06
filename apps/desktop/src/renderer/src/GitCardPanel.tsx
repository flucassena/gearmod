import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { codeMirrorKey, loadShortcuts } from './shortcuts'
import type { AgentProfile, GitCard, GitCardRepo, GitCommitFile, GitRequest } from '@gearmod/contracts'
import { AgentIcon } from './AgentIcon'
import { gitIcons, GitCheck, FileRow } from './GitPage'
import { laneColor, ruleLabel, ruleNote, shortAgo } from './gitView'
import { GitDiffEditor } from './editor/GitDiffEditor'
import { CodeEditor } from './editor/CodeEditor'
import { Prec, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { openInEditor } from './openInEditor'
import { plainError } from './NoticeDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { WorktreeDeleteDialog } from './WorktreeDelete'
import { Select } from './Select'
import { useAsk } from './useAsk'
import { useT } from './i18n'
import { SparkIcon, TrashIcon } from './icons'

/** This card's agent commit requests (pending and the latest decided); reloads when the card changes. */
export function useGitRequests(cardId: string): { items: GitRequest[]; reload(): Promise<void> } {
  const [items, setItems] = useState<GitRequest[]>([])
  const reload = useCallback(async (): Promise<void> => { if (!cardId) return setItems([]); try { setItems(await window.gearmod.invoke('git:requests', { cardId })) } catch { /* the chat carries on without the notice */ } }, [cardId])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => window.gearmod.onRunEvent((event) => { if (['gearmod/card-updated', 'gearmod/run-completed'].includes(event.eventType)) void reload() }), [reload])
  return { items, reload }
}

/** Agent commit request: authorize, edit the message or decline. Appears in the implementation chat and in the card's Git panel. */
export function CommitAsk({ request, agent, branch, ruleWhy, onDecided, openGit, variant }: { request: GitRequest; agent?: AgentProfile; branch?: string | null; ruleWhy?: string; onDecided(request: GitRequest): void; openGit?(): void; variant: 'chat' | 'panel' }): React.JSX.Element {
  const t = useT().git.cardPanel
  const [editing, setEditing] = useState(false), [message, setMessage] = useState(request.message), [error, setError] = useState(request.error ?? ''), [busy, setBusy] = useState(false)
  const decide = async (decision: 'allow' | 'deny'): Promise<void> => {
    setBusy(true); setError('')
    try { onDecided(await window.gearmod.invoke('git:request-decide', { requestId: request.id, decision, message: decision === 'allow' && message.trim() !== request.message ? message.trim() : undefined })) } catch (reason) { setError(plainError(reason)) } finally { setBusy(false) }
  }
  return <div className={variant === 'chat' ? 'cask' : 'cgprop'}>
    <div className="cgprop-h">{agent && <AgentIcon profile={agent} size="sm" tip={false} />}<b>{variant === 'chat' ? t.wantsCommit(branch) : t.agentWantsCommit(agent?.label ?? t.theAgent)}</b><small>{variant === 'chat' ? t.asksPermission(ruleWhy ?? t.projectRule) : shortAgo(request.createdAt)}</small></div>
    {editing ? <textarea className="autogrow" value={message} onChange={(e) => setMessage(e.target.value)} aria-label={t.commitMessage} /> : <p className="cgprop-msg">{request.message}</p>}
    <div className="cgnote">{t.filesInRepo(request.files.length, request.repoName, request.files.slice(0, 4).map((file) => file.split('/').pop()).join(', ') + (request.files.length > 4 ? '…' : ''))}</div>
    {error && <p className="error">{error}</p>}
    <div className="cgrow"><button type="button" className="mini" disabled={busy || !message.trim()} onClick={() => void decide('allow')}>{t.authorizeCommit}</button>
      {!editing && <button type="button" className="mini secondary" onClick={() => setEditing(true)}>{t.editMessage}</button>}
      {openGit && <button type="button" className="mini secondary" onClick={openGit}>{t.seeInGit}</button>}<span className="grow1" />
      <button type="button" className="mini secondary" disabled={busy} onClick={() => void decide('deny')}>{t.deny}</button></div></div>
}

/** In the implementation chat: the pending requests and the result of those the user just decided. */
export function CommitAsks({ cardId, branch, profiles, openGit }: { cardId: string; branch?: string | null; profiles: AgentProfile[]; openGit(): void }): React.JSX.Element | null {
  const t = useT().git.cardPanel
  const { items, reload } = useGitRequests(cardId), [results, setResults] = useState<GitRequest[]>([])
  const pending = items.filter((item) => item.status === 'pending')
  if (!pending.length && !results.length) return null
  return <>{results.map((item) => <div className="msg sys" key={item.id}>{item.status === 'done' ? t.commitAuthorized(item.message.split('\n')[0] ?? '') : item.status === 'failed' ? t.commitNotDone(item.error ?? undefined) : t.commitDenied}</div>)}
    {pending.map((item) => <CommitAsk key={item.id} request={item} variant="chat" branch={branch} agent={profiles.find((profile) => profile.id === item.agentProfileId)} onDecided={(done) => { setResults((current) => [...current, done]); void reload() }} openGit={openGit} />)}</>
}

/** This repository's origin: each has its own. Choosing another makes the card's commits be counted from it. */
function BaseSelect({ repo, cardId, base, reload }: { repo: GitCardRepo; cardId: string; base: string; reload(): Promise<void> }): React.JSX.Element {
  const t = useT().git.cardPanel
  const [options, setOptions] = useState<string[]>([]), [error, setError] = useState('')
  const load = (): void => { if (!options.length) void window.gearmod.invoke('git:base-options', { sourceId: repo.sourceId }).then(setOptions).catch(() => undefined) }
  const change = async (value: string): Promise<void> => { try { await window.gearmod.invoke('git:set-base', { cardId, sourceId: repo.sourceId, baseRef: value }); setError(''); await reload() } catch (reason) { setError(plainError(reason)) } }
  const list = options.includes(base) ? options : [base, ...options]
  return <span className="basepick" onMouseEnter={load} onFocus={load}><Select label={t.originOf(repo.name)} className="ghostsel" value={base} options={list.map((name) => ({ value: name, label: name }))} onChange={(value) => void change(value)} />{error && <small className="cx-warn">{error}</small>}</span>
}

const editOptions = { wrap: true, tabSize: 2, indentWithTab: true, whitespace: false, guides: false, scrollPastEnd: false }
export type DiffTarget = { sourceId: string; path: string; hash?: string }

/** Changed file panel, to the left of the chat: the diff (of the commit or still uncommitted) with line selection for the AI. */
export function DiffPane({ cardId, target, close, ask, style }: { cardId: string; target: DiffTarget; close(): void; ask(prompt: string): boolean | Promise<boolean>; style?: React.CSSProperties }): React.JSX.Element {
  const { common, git: { cardPanel: t, page: tp } } = useT()
  const { sourceId, path, hash } = target, [error, setError] = useState(''), [version, setVersion] = useState(0)
  const [draft, setDraft] = useState<string>(), [original, setOriginal] = useState(''), [saving, setSaving] = useState(false), [loadingFile, setLoadingFile] = useState(false)
  useEffect(() => { setDraft(undefined) }, [sourceId, path, hash])
  useEffect(() => { setError('') }, [sourceId, cardId, path, hash, version])
  const edit = (): void => {
    setLoadingFile(true); setError('')
    void window.gearmod.invoke('git:file-read', { sourceId, cardId, path }).then((out) => { setOriginal(out.content); setDraft(out.content) }).catch((reason: unknown) => setError(plainError(reason))).finally(() => setLoadingFile(false))
  }
  const save = (): void => {
    if (draft === undefined) return
    setSaving(true); setError('')
    void window.gearmod.invoke('git:file-write', { sourceId, cardId, path, content: draft }).then(() => { setDraft(undefined); setVersion((value) => value + 1) }).catch((reason: unknown) => setError(plainError(reason))).finally(() => setSaving(false))
  }
  const editing = draft !== undefined, dirty = editing && draft !== original
  const saveRef = useRef(save); saveRef.current = () => { if (dirty) save() }
  const saveKeys = useMemo<Extension[]>(() => [Prec.highest(keymap.of([{ key: codeMirrorKey(loadShortcuts().save), preventDefault: true, run: () => { saveRef.current(); return true } }]))], [])
  const { ask: confirmAsk, dialog: askDialog } = useAsk()
  const leave = async (): Promise<void> => { if (dirty && !(await confirmAsk({ eyebrow: t.editFileEyebrow, title: t.discardEditsTitle, text: t.discardEditsText(path), ok: tp.discard, danger: true }))) return; setDraft(undefined) }
  return <aside className="fview gdiffpane" style={style} aria-label={tp.changesOf(path)}>{askDialog}
    <div className="fv-head"><div className="fv-path" data-tip={path}>{path}</div>{hash && <small className="fv-size">{tp.commitHash(hash.slice(0, 7))}</small>}
      <button type="button" className="fv-toggle" data-tip={tp.openCurrentTip} disabled={editing} onClick={() => void openInEditor({ sourceId, cardId, path }).then(() => close()).catch((reason: unknown) => setError(plainError(reason)))}>{tp.openInEditor}</button>
      {!hash && (editing ? <><button type="button" className="fv-toggle" disabled={saving} onClick={() => void leave()}>{common.cancel}</button><button type="button" className="fv-toggle on" disabled={saving || !dirty} onClick={save}>{saving ? common.saving : common.save}</button></>
        : <button type="button" className="fv-toggle" disabled={loadingFile} onClick={edit}>{t.editFile}</button>)}
      <button type="button" className="x" aria-label={common.close} onClick={() => { if (editing) void leave(); if (!dirty) close() }}>×</button></div>
    <div className="fv-body">{error && <p className="fv-note err">{error}</p>}
      {editing ? <div className="fv-editorbox"><CodeEditor value={draft} path={path} options={editOptions} extensions={saveKeys} ariaLabel={t.editPath(path)} onChange={setDraft} /></div>
        : <GitDiffEditor sourceId={sourceId} cardId={cardId} path={path} hash={hash} review={{ path, send: ask }} reloadKey={version} />}</div>
  </aside>
}

/** Files of a card commit; each one opens the diff. */
function CommitFiles({ sourceId, hash, pick }: { sourceId: string; hash: string; pick(path: string): void }): React.JSX.Element {
  const common = useT().common
  const [files, setFiles] = useState<GitCommitFile[]>()
  useEffect(() => { void window.gearmod.invoke('git:commit-detail', { sourceId, hash }).then((out) => setFiles(out.files)).catch(() => setFiles([])) }, [sourceId, hash])
  return <div className="cgcfiles gfiles">{!files ? <small>{common.loading}</small> : files.map((file) => <FileRow key={file.path} file={file} onOpen={() => pick(file.path)} />)}</div>
}

const ALL_REPOS = '__all__'

/** Commit message (with an AI suggestion) for one or several repositories; in each only what is checked goes. */
function CommitBox({ repos, cardId, excluded, reload, onDone, onCancel, onSeeFiles }: { repos: GitCardRepo[]; cardId: string; excluded(repo: GitCardRepo): string[]; reload(): Promise<void>; onDone?(): void; onCancel?(): void; onSeeFiles?(): void }): React.JSX.Element {
  const T = useT(), t = T.git.cardPanel, box = useRef<HTMLDivElement>(null)
  useEffect(() => { if (onCancel) box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [])
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [done, setDone] = useState(''), [busy, setBusy] = useState(false), [suggesting, setSuggesting] = useState(false), [amend, setAmend] = useState(false), [lastMessage, setLastMessage] = useState('')
  const ready = repos.map((repo) => ({ repo, paths: [...new Set(repo.files.map((file) => file.path))].filter((path) => !excluded(repo).includes(path)) })).filter((item) => item.paths.length > 0)
  const amendTargets = repos.filter((repo) => repo.commits.length > 0).map((repo) => ({ repo, paths: ready.find((item) => item.repo.sourceId === repo.sourceId)?.paths ?? [] }))
  const published = amend && amendTargets.some((item) => item.repo.published)
  // Checking Amend brings the last commit's message into the field (if it is empty); unchecking removes it, if it was not touched. With several repositories each keeps its own.
  const toggleAmend = (value: boolean): void => {
    setAmend(value); setError('')
    if (value) {
      if (message.trim() || amendTargets.length !== 1) return
      const target = amendTargets[0]!.repo
      void window.gearmod.invoke('git:changes', { sourceId: target.sourceId, cardId }).then((out) => { if (out.lastMessage) { setLastMessage(out.lastMessage); setMessage((current) => current.trim() ? current : out.lastMessage) } }).catch((reason) => setError(plainError(reason)))
    } else if (lastMessage && message.trim() === lastMessage.trim()) { setMessage(''); setLastMessage('') }
  }
  const suggest = async (): Promise<void> => {
    const main = [...ready].sort((a, b) => b.paths.length - a.paths.length)[0]
    if (!main) return setError(t.checkOneFile)
    setSuggesting(true); setError('')
    try { setMessage((await window.gearmod.invoke('git:suggest-message', { sourceId: main.repo.sourceId, cardId, paths: main.paths })).message) } catch (reason) { setError(plainError(reason)) } finally { setSuggesting(false) }
  }
  const commit = async (): Promise<void> => {
    const targets = amend ? amendTargets : ready
    if (!amend && !message.trim()) return setError(t.writeMessage)
    if (!targets.length) return setError(amend ? t.amendNoCommits : t.checkOneFile)
    setBusy(true); setError(''); setDone('')
    let created = 0, last = ''
    try {
      for (const item of targets) { const out = await window.gearmod.invoke('git:commit', { sourceId: item.repo.sourceId, cardId, message: message.trim(), paths: item.paths, ...(amend ? { amend: true } : {}) }); created += 1; last = out.hash.slice(0, 7) }
      setMessage(''); setAmend(false); setLastMessage(''); setDone(created > 1 ? t.commitCreatedIn(created) : t.commitCreated(last)); onDone?.()
    } catch (reason) { setError(plainError(reason)) } finally { setBusy(false); await reload() }
  }
  const total = ready.reduce((sum, item) => sum + item.paths.length, 0)
  return <div className="cgcommit" ref={box}>
    {onCancel && <div className="cgnote">{total ? t.willCommit(total, ready.length) : t.willCommitNone}{onSeeFiles && <> · <button type="button" className="cglink" onClick={onSeeFiles}>{t.seeFilesToCommit}</button></>}</div>}
    <div className="cgmsg"><textarea className="autogrow" placeholder={amend ? t.amendPlaceholder : t.yourCommitMessage} aria-label={t.yourCommitMessage} value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!busy && !suggesting) void commit() } }} />
      <button type="button" className="cgai" data-tip={suggesting ? t.suggesting : t.suggestTip} aria-label={t.suggestWithAi} disabled={busy || suggesting} onClick={() => void suggest()}><SparkIcon /></button></div>
    <label className="cgamend"><GitCheck checked={amend} onChange={toggleAmend} label={t.amendOption} /> <span>{t.amendOption}</span>{amend && <small className="cx-muted"> · {amendTargets.length ? t.amendHint : t.amendNoCommits}</small>}</label>
    {published && <p className="cgnote">{t.amendPublished}</p>}
    {error && <p className="error">{error}</p>}{done && <div className="cgnote">{done}</div>}
    <div className="cgrow"><span className="grow1" />{onCancel && <button type="button" className="mini secondary" disabled={busy} onClick={onCancel}>{T.common.cancel}</button>}<button type="button" className="mini" disabled={busy || suggesting || (amend && !amendTargets.length)} onClick={() => void commit()}>{amend ? t.amendButton : t.commit}</button></div></div>
}

function RepoSection({ repo, cardId, branch, base, profiles, excluded, setExcluded, reload, openGraph, decided, diff, setDiff }: { repo: GitCardRepo; cardId: string; branch: string; base: string; profiles: AgentProfile[]; excluded: string[]; setExcluded(value: string[]): void; reload(): Promise<void>; openGraph(): void; decided(request: GitRequest): void; diff?: DiffTarget; setDiff(value: DiffTarget | undefined): void }): React.JSX.Element {
  const t = useT().git.cardPanel, td = useT().board.delivery
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [openCommit, setOpenCommit] = useState<string>(), [expanded, setExpanded] = useState(false), [confirming, setConfirming] = useState(false), [opening, setOpening] = useState(false), [committing, setCommitting] = useState(false)
  const paths = useMemo(() => [...new Set(repo.files.map((file) => file.path))], [repo.files])
  const quiet = !repo.commits.length && !paths.length
  if (quiet) return <></>
  const color = laneColor(1)
  const push = async (): Promise<void> => { setBusy(true); setError(''); try { await window.gearmod.invoke('git:sync', { sourceId: repo.sourceId, cardId, action: 'push' }); await reload() } catch (reason) { setError(plainError(reason)) } finally { setBusy(false) } }
  const canPr = repo.ahead > 0 && repo.state === 'active' && !repo.prUrl
  const openPr = async (): Promise<void> => {
    setConfirming(false); setOpening(true); setError('')
    try { const out = await window.gearmod.invoke('git:create-prs', { cardId, draft: true, sourceId: repo.sourceId }); const failed = out.results.find((item) => item.error); if (failed?.error) setError(failed.error); await reload() } catch (reason) { setError(plainError(reason)) } finally { setOpening(false) }
  }
  const openLink = (url: string): void => { void window.gearmod.invoke('git:open-pr', { cardId, url }).catch((reason) => setError(plainError(reason))) }
  return <section className={`cgrepo ${expanded ? 'open' : 'shut'}`}><header><button type="button" className="cgtoggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><span className="cgchev" aria-hidden="true">▸</span>{gitIcons.repo}<span className="cgrname">{repo.name}</span></button><span className="cnts">{repo.ahead > 0 && <span className="pillg up">↑ {repo.ahead}</span>}{repo.behind > 0 && <span className="pillg down">↓ {repo.behind}</span>}{paths.length > 0 && <span className="pillg down">{t.uncommitted(paths.length)}</span>}{repo.published && <span className="pillg ok">{t.published}</span>}</span></header>
    {expanded && <div className="cgbody"><div className="cgnote" style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{repo.worktreePath}</div>
      <div><div className="cglabel" style={{ marginBottom: 4 }}>{t.cardCommits}</div>{repo.commits.length ? <div className="cgcommits" style={{ '--lc': color } as React.CSSProperties}>
        {repo.commits.map((commit) => { const agent = profiles.find((profile) => profile.id === commit.agentProfileId); return <React.Fragment key={commit.hash}><div className="cgc"><i /><button type="button" className="cgfile" data-tip={t.seeCommitFiles} onClick={() => setOpenCommit(openCommit === commit.hash ? undefined : commit.hash)} style={{ flex: 1, textAlign: 'left' }}>{commit.subject}</button><code>{agent ? `${agent.label} · ` : `${t.you} · `}{commit.short}</code></div>{openCommit === commit.hash && <CommitFiles sourceId={repo.sourceId} hash={commit.hash} pick={(path) => setDiff({ sourceId: repo.sourceId, path, hash: commit.hash })} />}</React.Fragment> })}
        <div className="cgc basec"><i className="base" /><span>{t.baseLabel} <BaseSelect repo={repo} cardId={cardId} base={base} reload={reload} />{repo.behind ? ` · ${t.newOnBase(repo.behind, base)}` : ''}</span><code /></div></div> : <div className="cgnote">{t.noCommitsYet}</div>}</div>
      {repo.request && <CommitAsk request={repo.request} variant="panel" agent={profiles.find((profile) => profile.id === repo.request!.agentProfileId)} onDecided={decided} />}
      {paths.length > 0 && <div className="cgform"><div className="cglabel">{t.uncommittedFiles(paths.length)}</div>
        <div className="cgfiles">{paths.map((path) => { const file = repo.files.find((item) => item.path === path)!; const on = !excluded.includes(path)
          return <label className="cgck" key={path}><GitCheck checked={on} label={path} onChange={(value) => setExcluded(value ? excluded.filter((item) => item !== path) : [...excluded, path])} /><span className={`st ${file.status}`}>{file.status}</span>
            <button type="button" className="cgfile" data-tip={t.seeChanges} onClick={(e) => { e.preventDefault(); setDiff(diff?.path === path && !diff.hash && diff.sourceId === repo.sourceId ? undefined : { sourceId: repo.sourceId, path }) }}>{path}</button><span className="nums"><span className="p">+{repo.files.filter((item) => item.path === path).reduce((sum, item) => sum + item.additions, 0)}</span> <span className="m">−{repo.files.filter((item) => item.path === path).reduce((sum, item) => sum + item.deletions, 0)}</span></span></label> })}</div></div>}
</div>}
    <footer className="cgrepo-foot"><div className="cgrow">{(paths.length > 0 || repo.commits.length > 0) && !committing && <button type="button" className="mini" onClick={() => setCommitting(true)}>{t.commitHere}</button>}{repo.hasRemote && repo.ahead > 0 && <button type="button" className="mini secondary" disabled={busy} onClick={() => void push()}>{repo.published ? t.push : t.publishBranch}</button>}{repo.prUrl ? <button type="button" className="mini secondary" onClick={() => openLink(repo.prUrl!)}>PR · {repo.prUrl.replace(/^https?:\/\//, '')}</button> : <button type="button" className="mini secondary" disabled={opening || !canPr} onClick={() => setConfirming(true)}>{opening ? td.openingPrs : td.openPrs(1)}</button>}<span className="grow1" /><button type="button" className="mini secondary" onClick={openGraph}>{t.seeInGraph}</button></div>{error && <p className="error">{error}</p>}{committing && (paths.length > 0 || repo.commits.length > 0) && <CommitBox repos={[repo]} cardId={cardId} excluded={() => excluded} reload={reload} onDone={() => setCommitting(false)} onCancel={() => setCommitting(false)} onSeeFiles={() => setExpanded(true)} />}</footer>
    {confirming && <ConfirmDialog eyebrow={td.confirmEyebrow} title={td.confirmTitle(1)} text={td.confirmText(branch, repo.name)} ok={td.publishAndOpen} cancel={() => setConfirming(false)} confirm={() => void openPr()} />}</section>
}

/** Card Git panel (Chat | Git button): the source branch and the card's, one section per repository and the commit pinned at the footer. */
export function GitCardPanel({ cardId, profiles, openRules, openGraph, diff, setDiff }: { cardId: string; profiles: AgentProfile[]; openRules(): void; openGraph(cardId: string): void; diff?: DiffTarget; setDiff(value: DiffTarget | undefined): void }): React.JSX.Element {
  const T = useT(), t = T.git.cardPanel, tw = T.git.worktreeDelete
  const [data, setData] = useState<GitCard>(), [error, setError] = useState(''), [excluded, setExcluded] = useState<Record<string, string[]>>({}), [target, setTarget] = useState<string>(), [wtDelete, setWtDelete] = useState(false)
  const alive = useRef(true)
  const load = useCallback(async (): Promise<void> => { try { const next = await window.gearmod.invoke('git:card', { cardId }); if (alive.current) { setData(next); setError('') } } catch (reason) { if (alive.current) setError(plainError(reason)) } }, [cardId])
  useEffect(() => { alive.current = true; void load(); const timer = window.setInterval(() => void load(), 5000); return () => { alive.current = false; window.clearInterval(timer) } }, [load])
  useEffect(() => window.gearmod.onRunEvent((event) => { if (['gearmod/card-updated', 'gearmod/run-completed', 'gearmod/tool-activity'].includes(event.eventType)) void load() }), [load])
  if (error && !data) return <div className="cgwrap"><div className="cgit"><p className="error">{error}</p></div></div>
  if (!data) return <div className="cgwrap"><div className="cgit"><div className="cgnote">{t.loadingCardGit}</div></div></div>
  if (!data.branch) return <div className="cgwrap"><div className="cgit"><div className="cgsum"><div className="br">{gitIcons.branch}<em>{t.noBranchYet}</em></div><p className="cgnote">{t.noBranchA}<b>gearmod/…</b>{t.noBranchB}</p></div></div></div>
  const withFiles = data.repos.filter((repo) => repo.files.length > 0)
  const targetRepo = withFiles.find((repo) => repo.sourceId === target) ?? withFiles[0]
  const commitRepos = target === ALL_REPOS && withFiles.length > 1 ? withFiles : targetRepo ? [targetRepo] : []
  const { rule } = data
  return <div className="cgwrap"><div className="cgit">
    <div className="cgsum"><div className="br"><span className="bchip base" data-tip={t.baseBranchTip}>{gitIcons.branch}<span>{data.baseBranch ?? '—'}</span></span><span className="barrow" data-tip={t.originatedTip}>→</span><span className="bchip cur" data-tip={t.cardBranchTip}>{gitIcons.branch}<span>{data.branch}</span></span></div>
      <small>{t.sameBranchNote}</small>
      <button type="button" className="wsdel all" onClick={() => setWtDelete(true)}><TrashIcon />{tw.deleteButton}</button>
      <div className={`cgpol pol-${rule.rule}`}><span className="pd" /><span><span>{t.agentCommit} <b>{ruleLabel(rule.rule)}</b> · {ruleNote(rule.rule)}</span><small>{rule.why}</small></span><button type="button" className="ghost" onClick={openRules}>{t.rules}</button></div></div>
    {!data.repos.some((repo) => repo.commits.length || repo.files.length) && <div className="cgnote">{t.noReposChanged}</div>}
    {data.repos.map((repo) => <RepoSection key={repo.sourceId} repo={repo} cardId={cardId} branch={data.branch ?? ''} base={repo.baseRef} profiles={profiles} excluded={excluded[repo.sourceId] ?? []} setExcluded={(value) => setExcluded({ ...excluded, [repo.sourceId]: value })} reload={load} openGraph={() => openGraph(cardId)} decided={() => void load()} diff={diff} setDiff={setDiff} />)}
  </div>
  {targetRepo && <div className="cgfoot"><div className="cglabel">{withFiles.length > 1 ? t.yourCommitIn : t.yourCommit}{withFiles.length > 1 ? ' ' : ''}{withFiles.length > 1 && <Select className="cg-repo-select" label={t.commitRepo} value={target === ALL_REPOS ? ALL_REPOS : targetRepo.sourceId} onChange={setTarget} options={[...withFiles.map((repo) => ({ value: repo.sourceId, label: repo.name })), { value: ALL_REPOS, label: t.commitAll }]} />}</div>
    <CommitBox key={commitRepos.map((repo) => repo.sourceId).join()} repos={commitRepos} cardId={cardId} excluded={(repo) => excluded[repo.sourceId] ?? []} reload={load} /></div>}
  {wtDelete && <WorktreeDeleteDialog cardId={cardId} close={() => setWtDelete(false)} done={() => { setWtDelete(false); void load() }} />}
  </div>
}
