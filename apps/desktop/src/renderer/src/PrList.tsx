import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { PullRequestList, PullRequestSummary } from '@gearmod/contracts'
import { PrAccessNotice } from './PrPanel'
import { Select } from './Select'
import { Loading } from './Loading'
import { GitMenu } from './BranchMenu'
import { useT } from './i18n'
import type { PullRequestsState } from './usePullRequests'
import { appendPage, countLabel, filterPrs, quickFilter, sortPrs, stateChip, type PrQuick, type PrSort, type PrTab } from './prFilters'
import { ApproverIcon, ChevronDownSmallIcon, CommentIcon, PlusIcon, RefreshIcon } from './icons'
import { Avatar, LabelChip, PrPeopleContext, Spinner, StatusIcon, shortDay, type RunStatus } from './prUi'

const STATES = ['open', 'merged', 'closed'] as const
type State = typeof STATES[number]
type Entry = PullRequestList & { page: number }
/** Loaded pages by repository and state. */
type Lists = Record<string, Partial<Record<State, Entry>>>
type Check = { status: RunStatus; approvals: number | null }
const TABS: PrTab[] = ['open', 'merged', 'closed', 'all']
const SORTS: PrSort[] = ['updated-desc', 'updated-asc', 'created-desc', 'created-asc']
const QUICK: PrQuick[] = ['mine', 'review', 'draft', 'failed']
const CHIP_TONE = { merged: 'success', approved: 'success', changes: 'warning', draft: 'neutral', closed: 'neutral' } as const
/** Rows whose pipeline is still going are asked again this often. */
const LIVE_MS = 15_000
const statesOf = (which: PrTab): readonly State[] => which === 'all' ? STATES : [which]

/** A repository the list reads from. */
export interface PrRepo { sourceId: string; name: string }

/**
 * PRs/MRs of one repository or of every repository of the project at once (PR mode): tabs by state, search, quick filters, sort,
 * infinite scroll, and per row the pipeline, comments, approvals, state and labels. With several repositories each row says which one
 * it is from ("portal!261") and "Nova solicitação" asks for the repository.
 */
export function PrList({ repos, title, prs, open, create }: { repos: PrRepo[]; title: string; prs: PullRequestsState; open(pr: PullRequestSummary, sourceId: string): void; create(sourceId: string): void }): React.JSX.Element {
  const { common, git: { pr: t } } = useT()
  const many = repos.length > 1, key = repos.map((repo) => repo.sourceId).join(',')
  const [lists, setLists] = useState<Lists>({}), [loaded, setLoaded] = useState(false), [tab, setTab] = useState<PrTab>('open'), [query, setQuery] = useState(''), [sort, setSort] = useState<PrSort>('updated-desc'), [quick, setQuick] = useState<PrQuick | null>(null)
  const [checks, setChecks] = useState<Record<string, Check>>({}), [reloading, setReloading] = useState(false), [loadingMore, setLoadingMore] = useState(false), [pick, setPick] = useState<{ x: number; y: number }>()
  const shown = useRef(key); shown.current = key
  const fetchPage = (sourceId: string, state: State, page: number): Promise<PullRequestList> => window.gearmod.invoke('prs:list', { sourceId, state, ...(page > 1 ? { page } : {}) }).catch((): PullRequestList => ({ supported: true, provider: null, error: t.queryFailed, viewer: null, prs: [] }))
  const load = (): void => {
    setReloading(true)
    void Promise.all(repos.flatMap((repo) => STATES.map(async (state) => [repo.sourceId, state, { ...await fetchPage(repo.sourceId, state, 1), page: 1 }] as const)))
      .then((entries) => { if (shown.current !== key) return; const next: Lists = {}; for (const [sourceId, state, entry] of entries) (next[sourceId] ??= {})[state] = entry; setLists(next); setLoaded(true); setChecks({}) })
      .finally(() => setReloading(false))
  }
  useEffect(() => { setLists({}); setLoaded(false); setChecks({}); load() }, [key])
  // Which repository each PR object came from (the same number exists in several repositories).
  const origin = useMemo(() => { const map = new WeakMap<PullRequestSummary, string>(); for (const [sourceId, byState] of Object.entries(lists)) for (const entry of Object.values(byState)) for (const pr of entry?.prs ?? []) map.set(pr, sourceId); return map }, [lists])
  const entries = (which: PrTab): Array<{ sourceId: string; state: State; entry: Entry }> => Object.entries(lists).flatMap(([sourceId, byState]) => statesOf(which).flatMap((state) => { const entry = byState[state]; return entry ? [{ sourceId, state, entry }] : [] }))
  const base = (which: PrTab): PullRequestSummary[] => entries(which).flatMap((item) => item.entry.prs)
  const hasMore = (which: PrTab): boolean => entries(which).some((item) => Boolean(item.entry.more))
  const checkKey = (pr: PullRequestSummary): string => `${origin.get(pr) ?? ''}#${pr.number}`
  const provider = (sourceId: string): 'github' | 'gitlab' | null => lists[sourceId]?.open?.provider ?? null
  const repoName = (sourceId: string): string => repos.find((repo) => repo.sourceId === sourceId)?.name ?? ''
  // Infinite scroll: the next page of every repository and state of the tab that still has more, when the end of the list shows up.
  const loadMore = (): void => {
    const targets = entries(tab).filter((item) => item.entry.more)
    if (!targets.length || loadingMore || reloading) return
    setLoadingMore(true)
    void Promise.all(targets.map(async (item) => ({ ...item, page: item.entry.page + 1, got: await fetchPage(item.sourceId, item.state, item.entry.page + 1) })))
      .then((results) => { if (shown.current !== key) return; setLists((current) => { const next: Lists = { ...current }; for (const { sourceId, state, page, got } of results) { const list = current[sourceId]?.[state]; if (list) next[sourceId] = { ...next[sourceId], [state]: !got.error ? { ...list, prs: appendPage(list.prs, got.prs), more: Boolean(got.more), page } : { ...list, more: false } } } return next }) })
      .finally(() => setLoadingMore(false))
  }
  const more = useRef(loadMore); more.current = loadMore
  const rows = useRef<HTMLDivElement>(null), end = useRef<HTMLDivElement>(null)
  const viewer = Object.values(lists).map((byState) => byState.open?.viewer ?? null).find(Boolean) ?? null
  const visible = useMemo(() => sortPrs(quickFilter(filterPrs(base(tab), query), quick, { viewer, pipeline: (pr) => checks[checkKey(pr)]?.status }), sort), [lists, tab, query, sort, quick, checks, viewer])
  const moreHere = hasMore(tab)
  // Observed again when the list changes: if the end is still in view (short page, filters), the next page comes too.
  useEffect(() => {
    if (!moreHere || !end.current) return
    const observer = new IntersectionObserver((seen) => { if (seen.some((entry) => entry.isIntersecting)) more.current() }, { root: rows.current, rootMargin: '300px' })
    observer.observe(end.current)
    return () => observer.disconnect()
  }, [moreHere, visible.length, loadingMore])
  // Pipeline and approvals of the rows, 20 at a time as pages come, asked once per repository; rows still running are asked again every LIVE_MS.
  const ask = (keys: string[], update: (found: Record<string, Check>) => void, failed?: () => void): void => {
    const bySource = new Map<string, number[]>()
    for (const item of keys) { const [sourceId = '', number = ''] = item.split('#'); bySource.set(sourceId, [...(bySource.get(sourceId) ?? []), Number(number)]) }
    for (const [sourceId, numbers] of bySource) void window.gearmod.invoke('prs:checks', { sourceId, numbers }).then(({ checks: found }) => update(Object.fromEntries(found.map((item) => [`${sourceId}#${item.number}`, { status: item.status, approvals: item.approvals }]))), () => failed?.())
  }
  const pages = Math.max(1, ...entries(tab).map((item) => item.entry.page))
  const wanted = visible.slice(0, 20 * pages).map(checkKey).filter((item) => !(item in checks)).slice(0, 20).join(',')
  useEffect(() => {
    if (!wanted) return
    let alive = true
    const keys = wanted.split(',')
    ask(keys, (found) => { if (alive) setChecks((current) => ({ ...current, ...found })) }, () => { if (alive) setChecks((current) => ({ ...current, ...Object.fromEntries(keys.map((item) => [item, { status: 'none' as const, approvals: null }])) })) })
    return () => { alive = false }
  }, [wanted])
  const live = Object.entries(checks).filter(([, check]) => check.status === 'running' || check.status === 'pending').map(([item]) => item).slice(0, 20).join(',')
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => ask(live.split(','), (found) => setChecks((current) => ({ ...current, ...found }))), LIVE_MS)
    return () => window.clearInterval(timer)
  }, [live])
  const problem = entries('all').map((item) => item.entry).find((list) => list.error || !list.supported)
  const single = repos[0]?.sourceId ?? ''
  const startNew = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (!many) { create(single); return }
    const box = event.currentTarget.getBoundingClientRect(); setPick(pick ? undefined : { x: box.right - 260, y: box.bottom + 4 })
  }
  return <section className="prlist" aria-label={t.listTitle(title)}>
    <header className="pl-head"><h2>{t.listTitle(title)}</h2>
      <button type="button" className="mini" onClick={startNew} disabled={!many && lists[single]?.open?.supported === false} aria-haspopup={many ? 'menu' : undefined}><PlusIcon />{t.newRequest}{many && <ChevronDownSmallIcon />}</button>
      <button type="button" className="mini secondary" onClick={load} disabled={reloading}>{reloading ? <Spinner /> : <RefreshIcon />}{common.refresh}</button></header>
    {pick && <GitMenu x={pick.x} y={pick.y} title={t.pickRepoForNew} label={t.pickRepoForNew} items={repos.map((repo) => ({ key: repo.sourceId, label: repo.name }))} run={(sourceId) => { setPick(undefined); create(sourceId) }} close={() => setPick(undefined)} />}
    <div className="pr-tabs pl-tabs" role="tablist">{TABS.map((name) => <button type="button" role="tab" key={name} aria-selected={tab === name} className={tab === name ? 'on' : ''} onClick={() => setTab(name)}>{t.tabs[name]}{loaded && <span className="ds-count">{countLabel(base(name).length, hasMore(name))}</span>}</button>)}</div>
    <div className="pl-tools"><input className="in" type="search" value={query} placeholder={t.searchPrs} aria-label={t.searchPrs} onChange={(event) => setQuery(event.target.value)} />
      <Select label={t.sortLabel} value={sort} options={SORTS.map((value) => ({ value, label: t.sortOptions[value] ?? value }))} onChange={(value) => setSort(value as PrSort)} /></div>
    <div className="pl-quick" role="group" aria-label={t.quickAria}>{QUICK.map((name) => <button type="button" key={name} className={quick === name ? 'on' : ''} aria-pressed={quick === name} disabled={name === 'mine' && !viewer} onClick={() => setQuick(quick === name ? null : name)}>{t.quick[name]}</button>)}</div>
    {problem && (problem.supported ? <div className="pl-pad"><PrAccessNotice list={problem} /></div> : <p className="hint pl-pad">{problem.error}</p>)}
    {!loaded && <Loading />}
    <div className="pl-rows" ref={rows}>
      {loaded && !problem && visible.length === 0 && <p className="gempty pl-pad">{quick || query ? t.noMatch : t.emptyTab}</p>}
      {visible.map((pr) => { const sourceId = origin.get(pr) ?? single, check = checks[checkKey(pr)], chip = stateChip(pr, check?.approvals)
        return <button type="button" key={`${sourceId}:${pr.state}:${pr.number}`} className="pl-row" onClick={() => open(pr, sourceId)}>
          <span className="pl-main">
            <span className="pl-title">{prs.isUnread(sourceId, pr) && <i className="ds-dot tone-info" data-tip={t.newsTip} aria-label={t.newsTip} />}<span className="pl-num">{many && <span className="pl-repo">{repoName(sourceId)}</span>}{t.prRef(provider(sourceId), pr.number)}</span>{pr.title}</span>
            <span className="pl-sub"><span>{pr.author}</span><span>·</span><code>{pr.head}</code><span aria-hidden="true">→</span><code>{pr.base}</code>
              {pr.reviewRequested && pr.state === 'OPEN' && <span className="ds-chip sm tone-warning">{t.reviewAsked}</span>}
              {pr.labels.map((label) => <LabelChip key={label.name} label={label} />)}</span>
          </span>
          <span className="pl-icons">
            {check ? check.status !== 'none' && <StatusIcon status={check.status} label={`${t.pipelineLabel}: ${t.pipeline[check.status] ?? check.status}`} /> : <span className="pl-wait" aria-hidden="true" />}
            {pr.assignees.length > 0 && <span className="pl-assignees" data-tip={t.assignedTo(pr.assignees.map((person) => person.login).join(', '))}>{pr.assignees.slice(0, 3).map((person) =>
              <PrPeopleContext.Provider key={person.login} value={{ avatars: person.avatar ? { [person.login]: person.avatar } : {}, viewer: null }}><Avatar name={person.login} email={person.email} size="sm" /></PrPeopleContext.Provider>)}</span>}
            <span data-tip={t.commentsCount(pr.comments)}><CommentIcon />{pr.comments}</span>
            {check && check.approvals !== null && <span data-tip={t.approvalsCount(check.approvals)}><ApproverIcon />{check.approvals}</span>}
          </span>
          <span className="pl-chip">{chip && <span className={`ds-chip sm tone-${CHIP_TONE[chip]}`}>{t.stateChip[chip]}</span>}</span>
          <span className="pl-dates"><small>{t.createdAt(shortDay(pr.createdAt))}</small><small>{t.updatedAt(shortDay(pr.updatedAt))}</small></span>
        </button> })}
      {loaded && moreHere && <div ref={end} className="pl-more">{loadingMore && <Spinner />}</div>}
    </div>
  </section>
}
