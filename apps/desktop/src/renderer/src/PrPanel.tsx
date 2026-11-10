import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { PrCommit, PrPipeline, PrVersion, PullRequestDetail, PullRequestList, PullRequestSummary } from '@gearmod/contracts'
import { toast } from './toasts'
import { plainError } from './NoticeDialog'
import { Checkbox } from './Checkbox'
import { Loading } from './Loading'
import { Select } from './Select'
import { KeyIcon, CloseIcon, CopyIcon, ExternalIcon, GearIcon, ChevronDownSmallIcon, ChevronLeftIcon, ChevronRightIcon, ListIcon, MergeIcon, MoreIcon, PencilIcon, PullRequestIcon, RefreshIcon, RowsIcon, SidePanelIcon, SplitIcon, TreeViewIcon } from './icons'
import { useT } from './i18n'
import { usePreferences } from './editor/preferences'
import { splitDiff } from './prDiff'
import { PrDiffFile, type PrThread, type PrThreadComment } from './PrDiffFile'
import { PrFiles } from './PrFiles'
import { PrCommits, PrOverview, copyText } from './PrOverview'
import { PrPipelines } from './PrPipelines'
import { LabelChip, PrPeopleContext, Spinner, toggleReaction, useAgo, fullDate } from './prUi'
import { PrCreate } from './PrCreate'
import { GitMenu } from './BranchMenu'
import { PrSide } from './PrSide'

const message = (error: unknown): string => plainError(error)
/** While a pipeline of the PR runs, the pipelines are asked again this often (the overview card, the tab dot and the Pipelines tab follow). */
const PIPES_MS = 8_000
type Tab = 'overview' | 'commits' | 'pipelines' | 'changes'

/**
 * A PR/MR in PR mode: fixed header (number, title, state, branches, open on the host, ✕ back to the list) and four tabs — overview
 * (activity, approval, merge), commits, live pipelines and the changes (bar with versions and preferences, file tree, diff with line comments).
 */
export function PrScreen({ sourceId, provider, pr, branches, close, changed, pick }: { sourceId: string; provider: 'github' | 'gitlab' | null; pr: PullRequestSummary; branches: string[]; close(): void; changed(): void; pick?: { path: string; at: number } }): React.JSX.Element {
  const t = useT().git.pr, ago = useAgo()
  const [editing, setEditing] = useState(false), [menu, setMenu] = useState<{ x: number; y: number }>(), [acting, setActing] = useState(false)
  const [preferences, setPreferences] = usePreferences()
  const [detail, setDetail] = useState<PullRequestDetail>(), [error, setError] = useState(''), [tab, setTab] = useState<Tab>('overview')
  const [threads, setThreads] = useState<PrThread[]>([]), [reactions, setReactions] = useState<PullRequestDetail['reactions']>()
  const [commits, setCommits] = useState<PrCommit[] | null>(null), [pipes, setPipes] = useState<{ pipelines: PrPipeline[]; canAct: boolean }>()
  const [versions, setVersions] = useState<PrVersion[]>([]), [version, setVersion] = useState<string | null>(null), [versionDiff, setVersionDiff] = useState<{ diff: string; files: PullRequestDetail['files']; headSha: string | null; baseSha: string | null; startSha: string | null }>()
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set()), [current, setCurrent] = useState<string>(), [prefsOpen, setPrefsOpen] = useState(false)
  const body = useRef<HTMLDivElement>(null), prefsBox = useRef<HTMLDivElement>(null)
  const number = pr.number
  const load = (): Promise<void> => window.gearmod.invoke('prs:view', { sourceId, number }).then((value) => { setDetail(value); setThreads(value.threads); setReactions(value.reactions) }, (reason) => setError(message(reason)))
  // "Atualizar" of the header: everything again from the host (something changed there and did not show here).
  const [refreshing, setRefreshing] = useState(false)
  const refresh = (): void => { setRefreshing(true); loadPipes(); loadCommits(); changed(); void load().finally(() => setRefreshing(false)) }
  const people = useMemo(() => ({ avatars: detail?.avatars ?? {}, viewer: detail?.viewer ?? null, emails: detail?.emails ?? {} }), [detail?.avatars, detail?.viewer, detail?.emails])
  const threadChanged = (next: PrThread): void => setThreads((list) => next.comments.length ? list.map((thread) => thread.id === next.id ? next : thread) : list.filter((thread) => thread.id !== next.id))
  const loadPipes = (): void => { void window.gearmod.invoke('prs:pipelines', { sourceId, number }).then(setPipes, () => setPipes({ pipelines: [], canAct: false })) }
  const loadCommits = (): void => { void window.gearmod.invoke('prs:commits', { sourceId, number }).then(({ commits: found }) => setCommits(found), () => setCommits([])) }
  const reload = (): void => { void load(); loadPipes(); loadCommits(); changed() }
  useEffect(() => {
    setDetail(undefined); setError(''); setTab('overview'); setCollapsed(new Set()); setCommits(null); setPipes(undefined); setVersions([]); setVersion(null); setVersionDiff(undefined); setCurrent(undefined)
    void load(); loadPipes(); loadCommits()
    if (provider === 'gitlab') void window.gearmod.invoke('prs:versions', { sourceId, number }).then(({ versions: found }) => setVersions(found), () => setVersions([]))
  }, [sourceId, number])
  const live = Boolean(pipes?.pipelines.some((pipe) => pipe.status === 'running' || pipe.status === 'pending'))
  useEffect(() => { if (!live) return; const timer = window.setInterval(loadPipes, PIPES_MS); return () => window.clearInterval(timer) }, [live, sourceId, number])
  useEffect(() => {
    if (!prefsOpen) return
    const away = (event: MouseEvent): void => { if (!prefsBox.current?.contains(event.target as Node)) setPrefsOpen(false) }
    document.addEventListener('mousedown', away); return () => document.removeEventListener('mousedown', away)
  }, [prefsOpen])
  // An older version of the MR (GitLab): its diff, read-only (comments live on the newest version). Loading shows while it comes (big MRs take a while).
  const [versionLoading, setVersionLoading] = useState(false)
  useEffect(() => {
    setVersionDiff(undefined)
    if (!version) { setVersionLoading(false); return }
    let alive = true; setVersionLoading(true)
    void window.gearmod.invoke('prs:version-diff', { sourceId, number, versionId: version }).then((value) => { if (alive) { setVersionDiff(value); setVersionLoading(false) } }, (reason) => { if (alive) { toast.error(t.versionFailed, message(reason)); setVersionLoading(false); setVersion(null) } })
    return () => { alive = false }
  }, [version])
  const latest = !version || !versionDiff
  const files = versionLoading ? [] : latest ? detail?.files ?? [] : versionDiff.files
  const diffs = useMemo(() => splitDiff((latest ? detail?.diff : versionDiff.diff) ?? ''), [latest, detail?.diff, versionDiff?.diff])
  const shas = latest ? (detail ?? { headSha: null, baseSha: null, startSha: null }) : { headSha: null, baseSha: null, startSha: null }
  const oneFile = preferences.prOneFile, showTree = tab === 'changes' && preferences.prTree
  const index = Math.max(0, files.findIndex((file) => file.path === current))
  const goFile = (path: string): void => {
    setTab('changes'); setCurrent(path); setCollapsed((set) => { const next = new Set(set); next.delete(path); return next })
    if (!preferences.prOneFile) window.requestAnimationFrame(() => { Array.from(body.current?.querySelectorAll<HTMLElement>('[data-prfile]') ?? []).find((element) => element.dataset.prfile === path)?.scrollIntoView({ block: 'start' }) })
    else body.current?.scrollTo({ top: 0 })
  }
  useEffect(() => { if (pick && detail) goFile(pick.path) }, [pick?.at, detail?.number])
  const openWeb = (url: string): void => { void window.gearmod.invoke('prs:open', { sourceId, url }).catch((reason) => toast.error(t.openFailed, message(reason))) }
  // Shows the click at once; the host's answer then sets the true counts, and a failure takes the click back.
  const react = (kind: 'up' | 'down'): void => {
    setReactions((current) => current && toggleReaction(current, kind))
    void window.gearmod.invoke('prs:react', { sourceId, number, kind }).then(setReactions, (reason) => { setReactions((current) => current && toggleReaction(current, kind)); toast.error(t.reactFailed, message(reason)) })
  }
  const replied = (threadId: string, comment: PrThreadComment): void => setThreads((list) => list.map((thread) => thread.id === threadId ? { ...thread, comments: [...thread.comments, comment] } : thread))
  const resolved = (threadId: string, value: boolean): void => setThreads((list) => list.map((thread) => thread.id === threadId ? { ...thread, resolved: value } : thread))
  const state = detail?.state ?? pr.state, draft = detail?.draft ?? pr.draft, ref = t.prRef(provider, number)
  const host = provider === 'gitlab' ? 'GitLab' : 'GitHub'
  const layout = preferences.diffLayout, cut = Boolean(latest && detail?.diff.includes('… diff cortado'))
  const allOpen = files.every((file) => !collapsed.has(file.path))
  const shownFiles = oneFile ? files.slice(index, index + 1) : files
  const counts = { overview: detail ? detail.comments.length + threads.length : null, commits: commits?.length ?? null, pipelines: pipes?.pipelines.length ?? null, changes: detail?.files.length ?? null }
  // The ⋮ menu: draft on/off (GitLab; GitHub's REST cannot) and close/reopen. Each one asks the host and reloads the MR.
  type MenuKey = 'draft' | 'ready' | 'close' | 'reopen'
  const act = (key: MenuKey): void => {
    setMenu(undefined); setActing(true)
    const change = key === 'draft' ? { draft: true } : key === 'ready' ? { draft: false } : { state: key }
    const done = { draft: t.markedDraft, ready: t.markedReady, close: t.requestClosed, reopen: t.requestReopened }[key]
    void window.gearmod.invoke('prs:update', { sourceId, number, ...change }).then((result) => { toast.success(done); if (result.warning) toast.info(result.warning); reload() }, (reason) => toast.error(t.actionFailed, message(reason))).finally(() => setActing(false))
  }
  const menuItems: Array<{ key: MenuKey; label: string; danger?: boolean }> = state === 'OPEN'
    ? [...(provider === 'gitlab' ? [draft ? { key: 'ready' as const, label: t.markReady } : { key: 'draft' as const, label: t.markDraft }] : []), { key: 'close', label: t.closeRequest, danger: true }]
    : state === 'CLOSED' ? [{ key: 'reopen', label: t.reopenRequest }] : []
  if (editing && detail) return <PrCreate sourceId={sourceId} branches={branches} head={detail.head} back={() => setEditing(false)} edit={{ number, ref, provider, detail }} saved={() => { setEditing(false); reload() }} />
  return <PrPeopleContext.Provider value={people}><div className="prs-wrap">
    <section className="prscreen" aria-label={`${ref} ${pr.title}`}>
      <header className="prs-head">
        <button type="button" className="pr-iconbtn prs-close" onClick={close} aria-label={t.closePr} data-tip={t.closePr}><CloseIcon /></button>
        <div className="prs-titlerow"><h2><span className="ds-chip prs-num">{ref}</span>{detail?.title ?? pr.title}</h2>
          {state === 'OPEN' && <button type="button" className="mini secondary" disabled={!detail || acting} onClick={() => setEditing(true)}><PencilIcon />{t.editRequest}</button>}
          <button type="button" className="mini secondary" onClick={() => openWeb(pr.url)}><ExternalIcon />{t.openOn(host)}</button>
          <button type="button" className="pr-iconbtn" disabled={refreshing} aria-label={t.refreshRequest} data-tip={t.refreshRequest} onClick={refresh}>{refreshing ? <Spinner /> : <RefreshIcon />}</button>
          {menuItems.length > 0 && <button type="button" className="pr-iconbtn" disabled={!detail || acting} aria-label={t.moreActions} data-tip={t.moreActions} aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setMenu(menu ? undefined : { x: box.right - 230, y: box.bottom + 4 }) }}>{acting ? <Spinner /> : <MoreIcon />}</button>}</div>
        {menu && <GitMenu x={menu.x} y={menu.y} title={ref} label={t.moreActions} items={menuItems} run={act} close={() => setMenu(undefined)} />}
        <div className="prs-meta">
          {state === 'MERGED' ? <span className="ds-chip tone-success"><MergeIcon />{t.stateLabel.MERGED}</span> : state === 'CLOSED' ? <span className="ds-chip">{t.stateLabel.CLOSED}</span> : <span className="ds-chip tone-info"><PullRequestIcon />{t.stateLabel.OPEN}</span>}
          {draft && <span className="ds-chip">{t.stateChip.draft}</span>}
          {detail?.mergeable === 'CONFLICTING' && <span className="ds-chip tone-danger">{t.withConflict}</span>}
          <span><b>{pr.author}</b> {t.wantsToMerge}</span><span className="rchip"><span className="rn">{pr.head}</span></span>
          <button type="button" className="pr-iconbtn" aria-label={t.copyBranch} data-tip={t.copyBranch} onClick={() => copyText(pr.head, t.branchCopied, t.copyFailed)}><CopyIcon /></button>
          <span>{t.into}</span><span className="rchip"><span className="rn">{detail?.base ?? pr.base}</span></span><span className="pr-muted" data-tip={fullDate(pr.createdAt)}>· {ago(pr.createdAt)}</span>
          {detail?.labels.map((label) => <LabelChip key={label.name} label={label} />)}
        </div>
        <div className="pr-tabs" role="tablist">{(['overview', 'commits', 'pipelines', 'changes'] as const).map((name) => <button type="button" role="tab" key={name} aria-selected={tab === name} className={tab === name ? 'on' : ''} onClick={() => setTab(name)}>
          {t.prTabs[name]}{counts[name] !== null && <span className="ds-count">{counts[name]}</span>}{name === 'pipelines' && live && <i className="ds-dot tone-info pr-pulse" aria-label={t.pipelineRunning} data-tip={t.pipelineRunning} />}</button>)}</div>
      </header>
      {error && <p className="error pr-pad">{error}</p>}
      {!detail && !error && <Loading />}
      {tab !== 'changes' && <div className="prs-scroll" ref={body}>
        {detail && reactions && tab === 'overview' && <PrOverview sourceId={sourceId} provider={provider} detail={detail} threads={threads} setThreads={setThreads} reactions={reactions} react={react} pipeline={pipes?.pipelines[0] ?? null} commits={commits?.length ?? null} diffs={diffs} goPipelines={() => setTab('pipelines')} openFile={goFile} reload={reload} />}
        {detail && tab === 'commits' && <PrCommits commits={commits} />}
        {detail && tab === 'pipelines' && <PrPipelines sourceId={sourceId} number={number} data={pipes} reload={loadPipes} openWeb={openWeb} />}
      </div>}
        {detail && tab === 'changes' && <div className="prs-changes">
          <div className="ch-bar">
            <button type="button" className={`pr-iconbtn ${preferences.prTree ? 'on' : ''}`} aria-pressed={preferences.prTree} aria-label={preferences.prTree ? t.hideTree : t.showTree} data-tip={preferences.prTree ? t.hideTree : t.showTree} onClick={() => setPreferences({ prTree: !preferences.prTree })}><SidePanelIcon /></button>
            <span className="ch-compare">{t.compare} <b>{detail.base}</b> {t.compareWith}</span>
            {versions.length > 1 ? <Select label={t.versionLabel} value={version ?? 'latest'} options={[{ value: 'latest', label: t.latestVersion(versions.length) }, ...versions.slice(1).map((item, i) => ({ value: item.id, label: t.versionOf(versions.length - 1 - i, item.headSha.slice(0, 8)) }))]} onChange={(value) => setVersion(value === 'latest' ? null : value)} /> : <b>{t.latestVersionShort}</b>}
            {!versionLoading && <span className="ch-sum"><span className="pr-muted">{t.filesCount(files.length)}</span><span className="nums"><span className="p">+{files.reduce((sum, file) => sum + file.additions, 0)}</span> <span className="m">−{files.reduce((sum, file) => sum + file.deletions, 0)}</span></span></span>}
            {!oneFile && <button type="button" className="mini secondary" onClick={() => setCollapsed(allOpen ? new Set(files.map((file) => file.path)) : new Set())}>{allOpen ? t.collapseAll : t.expandAll}</button>}
            <div className="ch-prefwrap" ref={prefsBox}><button type="button" className="mini secondary" aria-expanded={prefsOpen} aria-label={t.preferences} data-tip={t.preferences} onClick={() => setPrefsOpen(!prefsOpen)}><GearIcon /><ChevronDownSmallIcon /></button>
              {prefsOpen && <div className="ch-pref" role="dialog" aria-label={t.preferences}>
                <div className="ch-pt">{t.preferences}</div>
                <div className="ch-pl">{t.fileBrowser}</div>
                <div className="prseg ch-seg" role="group" aria-label={t.fileBrowser}><button type="button" className={preferences.prFileView === 'list' ? 'on' : ''} aria-pressed={preferences.prFileView === 'list'} onClick={() => setPreferences({ prFileView: 'list', prTree: true })}><ListIcon />{t.listView}</button><button type="button" className={preferences.prFileView === 'tree' ? 'on' : ''} aria-pressed={preferences.prFileView === 'tree'} onClick={() => setPreferences({ prFileView: 'tree', prTree: true })}><TreeViewIcon />{t.treeView}</button></div>
                <div className="ch-pl">{t.compareChanges}</div>
                <div className="prseg ch-seg" role="group" aria-label={t.layoutAria}><button type="button" className={layout === 'unified' ? 'on' : ''} aria-pressed={layout === 'unified'} onClick={() => setPreferences({ diffLayout: 'unified' })}><RowsIcon />{t.layoutInline}</button><button type="button" className={layout === 'split' ? 'on' : ''} aria-pressed={layout === 'split'} onClick={() => setPreferences({ diffLayout: 'split' })}><SplitIcon />{t.layoutSplit}</button></div>
                <label className="pr-check"><Checkbox checked={oneFile} onChange={(value) => { setPreferences({ prOneFile: value }); if (value && !current && files[0]) setCurrent(files[0].path) }} />{t.oneFileAtATime}</label>
              </div>}</div>
          </div>
          <div className="prs-chrow">
          {showTree && <PrFiles files={files} picked={current} view={preferences.prFileView} onPick={goFile} />}
          <div className="prs-scroll" ref={body}><div className="prs-chfiles">
          {!latest && <div className="ds-note tone-info"><span className="ds-note-i">i</span><span>{t.oldVersionNote}</span></div>}
          {cut && <div className="ds-note tone-warning"><span>{t.truncated}</span><button type="button" className="mini secondary" onClick={() => openWeb(pr.url)}><ExternalIcon />{t.openOn(host)}</button></div>}
          {versionLoading ? <Loading /> : files.length === 0 && <p className="gempty">{t.noDiff}</p>}
          {!versionLoading && <div className="prs-files">{shownFiles.map((file) => <PrDiffFile key={`${version ?? 'latest'}:${file.path}`} sourceId={sourceId} number={number} file={file} lines={diffs.get(file.path)?.lines ?? []} shas={shas} threads={latest ? threads.filter((thread) => thread.path === file.path) : []} layout={layout} collapsed={!oneFile && collapsed.has(file.path)}
            toggle={() => setCollapsed((set) => { const next = new Set(set); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next })}
            created={(thread: PrThread) => { setThreads((list) => [...list, thread]); void load() }} replied={replied} resolved={resolved} threadChanged={threadChanged} />)}</div>}
          {oneFile && !versionLoading && files.length > 0 && <div className="ch-pager"><div className="ch-pg">
            <button type="button" disabled={index === 0} onClick={() => goFile(files[index - 1]!.path)}><ChevronLeftIcon />{t.previousFile}</button>
            <button type="button" disabled={index >= files.length - 1} onClick={() => goFile(files[index + 1]!.path)}>{t.nextFile}<ChevronRightIcon /></button></div>
            <span className="pr-muted">{t.fileOf(index + 1, files.length)}</span></div>}
          </div></div></div>
        </div>}
    </section>
    {detail && <PrSide sourceId={sourceId} detail={detail} author={pr.author} threads={threads} editable={state === 'OPEN'} saved={reload} />}
  </div></PrPeopleContext.Provider>
}

/** Opens the project settings on the Git tab, where the accounts (tokens) live. */
export const openGitAccounts = (): void => { window.dispatchEvent(new CustomEvent('gearmod:open-project-config', { detail: { tab: 'git', focus: 'git-accounts' } })) }

/** Why the PRs did not load, with the right output: update the expired token or add one (in place of gh/glab). */
export function PrAccessNotice({ list }: { list: PullRequestList }): React.JSX.Element | null {
  const ta = useT().git.accounts
  if (list.problem === 'invalid-token') return <div className="cx-note warn gacc-note"><i className="gacc-dot" aria-hidden="true" /><span>{list.error ?? ta.invalidBanner}</span><button type="button" className="mini secondary withicon" onClick={openGitAccounts}><KeyIcon />{ta.updateToken}</button></div>
  if (list.problem === 'no-cli' || list.problem === 'not-logged-in') return <div className="cx-note gacc-note"><span>{list.error}</span><button type="button" className="mini secondary withicon" onClick={openGitAccounts}><KeyIcon />{ta.needToken}</button></div>
  return list.error ? <p className="error">{list.error}</p> : null
}
