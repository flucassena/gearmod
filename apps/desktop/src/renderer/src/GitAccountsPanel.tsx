import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GitAccountInfo, GitAccountsState, GitRepo, ProjectSource } from '@gearmod/contracts'
import { gitIcons } from './GitPage'
import { FolderGlyph, MoreIcon, TokenIcon, TrashIcon, CheckMiniIcon, CrossMiniIcon } from './icons'
import { GitMenu, type MenuItem } from './BranchMenu'
import { cachedGit, refreshGit } from './gitConfigCache'
import { gitChangedEvent } from './GitSetup'
import { plainError } from './NoticeDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { Select } from './Select'
import { toast } from './toasts'
import { useT } from './i18n'

type Host = GitAccountsState['hosts'][number]
type Target = { host: string; sourceId?: string; provider: 'github' | 'gitlab' }
export const gitAccountsChangedEvent = 'gearmod:git-accounts-changed'

/** Who the token's account is: name, user and email, plus the last 4 letters. The token itself never comes back to the screen. */
function Who({ info }: { info: GitAccountInfo }): React.JSX.Element {
  const t = useT().git.accounts
  return <span className="gacc-who">{info.invalid && <i className="gacc-dot" aria-hidden="true" />}<b>{info.name}</b> <span className="cx-muted">@{info.login}{info.email && info.email !== info.name ? ` · ${info.email}` : ''} · {info.hint}</span>{info.invalid && <small className="cx-warn"> {t.invalid}</small>}</span>
}

/** Project Git repositories and accounts: one token per server (applies to all its repositories) and, if wanted, a token of its own per repository.
 * Each repository appears once, with the current branch; those without a remote go in a separate block. */
export function GitAccountsPanel({ projectId, openFirst = false }: { projectId: string; openFirst?: boolean }): React.JSX.Element {
  const { git: { accounts: t, policy: tp }, settings: { project: tpj }, common } = useT()
  const [repos, setRepos] = useState<GitRepo[]>(cachedGit(projectId).repos ?? [])
  useEffect(() => {
    const sync = (): void => setRepos(cachedGit(projectId).repos ?? [])
    sync(); void refreshGit(projectId).then(sync).catch(() => undefined)
    window.addEventListener(gitChangedEvent, sync); return () => window.removeEventListener(gitChangedEvent, sync)
  }, [projectId])
  const repoInfo = (sourceId: string): GitRepo | undefined => repos.find((item) => item.sourceId === sourceId)
  const branch = (repo: GitRepo | undefined): React.JSX.Element | null => repo ? <span className="pillg ok" data-tip={repo.head ? `${tp.currentBranch}: ${repo.head}` : tp.currentBranch}>{gitIcons.branch}<span className="pillg-name">{repo.head ?? '—'}</span></span> : null
  // Base branch of each repository: where card worktrees start from (always from its latest version on the remote).
  const [sources, setSources] = useState<ProjectSource[]>([]), [branchLists, setBranchLists] = useState<Record<string, string[]>>({})
  const loadSources = useCallback(async (): Promise<void> => {
    const project = (await window.gearmod.invoke('projects:list', undefined)).find((item) => item.id === projectId)
    const list = project?.sources.filter((item) => item.isGitRepository) ?? []
    setSources(list)
    const found = await Promise.all(list.map((item) => window.gearmod.invoke('projects:branches', { localPath: item.localPath }).then((names) => [item.id, names] as const, () => [item.id, [] as string[]] as const)))
    setBranchLists(Object.fromEntries(found))
  }, [projectId])
  useEffect(() => { void loadSources().catch(() => undefined) }, [loadSources])
  const setBase = async (sourceId: string, value: string): Promise<void> => {
    try { setError(''); const project = await window.gearmod.invoke('projects:set-source-base', { projectId, sourceId, branch: value }); setSources(project.sources.filter((item) => item.isGitRepository)); toast.success(t.baseSaved(value)) } catch (reason) { setError(plainError(reason)) }
  }
  const base = (sourceId: string): React.JSX.Element | null => {
    const source = sources.find((item) => item.id === sourceId), names = branchLists[sourceId] ?? []
    if (!source) return null
    const value = source.baseBranch ?? source.currentBranch ?? ''
    return <span className="gacc-base" data-tip={t.baseTip}><Select className="repobase" label={t.baseOf(source.name)} menuWidth={220} options={[...(!names.includes(value) && value ? [{ value, label: value }] : []), ...names.map((name) => ({ value: name, label: name }))]} value={value} onChange={(next) => void setBase(sourceId, next)} /></span>
  }
  const [infoOpen, setInfoOpen] = useState(false)
  const [state, setState] = useState<GitAccountsState>(), [error, setError] = useState(''), [edit, setEdit] = useState<Target | null>(null), [token, setToken] = useState(''), [busy, setBusy] = useState(false), [removing, setRemoving] = useState<{ host: string; sourceId?: string; label: string } | null>(null)
  const load = useCallback(async (): Promise<void> => { try { setState(await window.gearmod.invoke('git-accounts:state', { projectId })); setError('') } catch (reason) { setError(plainError(reason)) } }, [projectId])
  useEffect(() => { void load() }, [load])
  // Opened by "Add token" on the Git page: with a single server and no token, the dialog opens right away.
  const autoOpened = useRef(false)
  useEffect(() => {
    if (!openFirst || autoOpened.current || !state) return
    autoOpened.current = true
    const only = state.hosts.length === 1 ? state.hosts[0] : undefined
    if (only && !only.project) open({ host: only.host, provider: only.provider ?? 'gitlab' })
  }, [openFirst, state])
  const changed = (next: GitAccountsState): void => { setState(next); window.dispatchEvent(new CustomEvent(gitAccountsChangedEvent, { detail: { projectId } })) }
  const open = (target: Target): void => { setEdit(target); setToken(''); setError('') }
  const save = async (): Promise<void> => {
    if (!edit || !token.trim()) return
    setBusy(true); setError('')
    try { changed(await window.gearmod.invoke('git-accounts:set', { projectId, sourceId: edit.sourceId, provider: edit.provider, host: edit.host, token: token.trim() })); setEdit(null); setToken(''); toast.success(t.saved) } catch (reason) { setError(plainError(reason)) } finally { setBusy(false) }
  }
  const remove = async (): Promise<void> => {
    if (!removing) return
    const target = removing; setRemoving(null)
    try { changed(await window.gearmod.invoke('git-accounts:remove', { projectId, sourceId: target.sourceId, host: target.host })); toast.success(t.removed) } catch (reason) { setError(plainError(reason)) }
  }
  // Repositories of the project: add a folder (its repositories) and take one out. The folder on disk is never touched.
  const [removingRepo, setRemovingRepo] = useState<{ sourceId: string; name: string }>(), [repoBusy, setRepoBusy] = useState(false)
  const afterRepos = async (): Promise<void> => {
    await refreshGit(projectId).catch(() => undefined)
    window.dispatchEvent(new Event(gitChangedEvent)); window.dispatchEvent(new Event('gearmod:board-changed'))
    await load(); await loadSources().catch(() => undefined)
  }
  const addFolder = async (): Promise<void> => {
    try {
      setRepoBusy(true); setError('')
      const path = await window.gearmod.invoke('projects:choose-directory', { projectId })
      if (path) { await window.gearmod.invoke('projects:add-repositories', { projectId, localPath: path }); await afterRepos() }
    } catch (reason) { setError(plainError(reason)) } finally { setRepoBusy(false) }
  }
  const removeRepo = async (): Promise<void> => {
    if (!removingRepo) return
    const target = removingRepo; setRemovingRepo(undefined)
    try { setRepoBusy(true); setError(''); await window.gearmod.invoke('projects:remove-repository', { projectId, sourceId: target.sourceId }); await afterRepos() } catch (reason) { setError(plainError(reason)) } finally { setRepoBusy(false) }
  }
  // Row actions: a three-dot button that opens the same menu as the Git screen (arrows, Enter, Esc).
  type RowAction = 'token' | 'remove-token' | 'remove-repo'
  const [menu, setMenu] = useState<{ x: number; y: number; title: string; items: Array<MenuItem<RowAction>>; run(key: RowAction): void }>()
  const more = (title: string, items: Array<MenuItem<RowAction>>, run: (key: RowAction) => void): React.JSX.Element => <button type="button" className="gacc-more tip" data-tip={t.actions} aria-label={t.actionsOf(title)} aria-haspopup="menu" onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ x: box.right - 230, y: box.bottom + 4, title, items, run: (key) => { setMenu(undefined); run(key) } }) }}><MoreIcon /></button>
  const removeRepoItem = (): MenuItem<RowAction> => ({ key: 'remove-repo', label: t.removeFromProject, danger: true, icon: <TrashIcon />, ...(repos.length <= 1 ? { off: tpj.lastRepoTip } : {}) })
  const repoMenu = (sourceId: string, name: string, items: Array<MenuItem<RowAction>>, run: (key: RowAction) => void = () => undefined): React.JSX.Element | null =>
    !items.length && repos.length <= 1 ? null : more(name, [...items, removeRepoItem()], (key) => { if (key === 'remove-repo') { if (!repoBusy) setRemovingRepo({ sourceId, name }) } else run(key) })
  // Token column: a chip says which token the repository uses; details (account, last letters) in the tooltip.
  const tokenChip = (repo: Host['repos'][number], host: Host): React.JSX.Element => {
    if (repo.own) return <span className={`gacc-chip own ${repo.own.invalid ? 'bad' : ''}`} data-tip={`${repo.own.name} · @${repo.own.login} · ${repo.own.hint}${repo.own.invalid ? ` · ${t.invalid}` : ''}`}>{repo.own.invalid ? <i className="gacc-dot" aria-hidden="true" /> : <CheckMiniIcon />}{t.chipOwn}</span>
    if (repo.using === 'project') return host.project?.invalid ? <span className="gacc-chip bad" data-tip={t.invalid}><i className="gacc-dot" aria-hidden="true" />{t.chipInvalid}</span> : <span className="gacc-chip project" data-tip={host.project ? `${host.project.name} · @${host.project.login}` : undefined}><CheckMiniIcon />{t.chipProject}</span>
    return <span className="gacc-chip none" data-tip={t.chipNoneTip}><CrossMiniIcon />{t.chipNone}</span>
  }
  const tableHead = <div className="gacc-tr gacc-th" role="row"><span role="columnheader">{t.colRepo}</span><span role="columnheader">{t.colBranch}</span><span role="columnheader" data-tip={t.baseTip}>{t.colBase}</span><span role="columnheader">{t.colToken}</span><span role="columnheader" aria-label={t.actions} /></div>
  const form = (host: Host, target: Target): React.JSX.Element => <div className="gacc-form">
    <p className="gacc-explain">{target.sourceId ? t.explainOwn(host.repos.find((item) => item.sourceId === target.sourceId)?.name ?? '', host.host) : t.explainProject(host.host)}</p>
    {!host.provider && !target.sourceId && <Select label={t.provider} value={target.provider} options={[{ value: 'gitlab', label: 'GitLab' }, { value: 'github', label: 'GitHub' }]} onChange={(value) => setEdit({ ...target, provider: value as 'github' | 'gitlab' })} />}
    <input className="in" type="password" autoComplete="off" spellCheck={false} autoFocus value={token} placeholder={t.tokenPlaceholder} aria-label={t.token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEdit(null) }} />
    <small className="hint"><b>{t.howToCreate}</b> {target.provider === 'github' ? t.helpGithub : t.helpGitlab}</small>
    <small className="hint">{t.tokenStored}</small>
    {error && <p className="error">{error}</p>}
    <div className="cgrow"><button type="button" className="mini" disabled={busy || !token.trim()} onClick={() => void save()}>{busy ? t.checking : t.save}</button><button type="button" className="mini secondary" disabled={busy} onClick={() => setEdit(null)}>{common.cancel}</button></div></div>
  return <div className="stack gacc">
    <div className="gacc-head"><div className="sectitle">{t.title}</div><button type="button" className="mini secondary withicon" disabled={repoBusy} onClick={() => void addFolder()}><FolderGlyph />{tpj.addAnotherFolder}</button></div>
    <div className="gacc-info" role="note"><span className="gacc-info-i" aria-hidden="true">i</span><div className="gacc-info-text"><p>{t.baseHint}</p>{infoOpen && <><p>{t.hint}</p><p>{tpj.reposHint}</p></>}</div><button type="button" className="gacc-info-toggle tip" data-tip={infoOpen ? t.lessInfo : t.moreInfo} aria-label={infoOpen ? t.lessInfo : t.moreInfo} aria-expanded={infoOpen} onClick={() => setInfoOpen(!infoOpen)}><svg viewBox="0 0 20 20" aria-hidden="true" style={{ transform: infoOpen ? "rotate(180deg)" : undefined }}><path d="m5 8 5 5 5-5" /></svg></button></div>
    {error && !edit && <p className="error">{error}</p>}
    {!state ? <small className="hint">{common.loading}</small> : !state.hosts.length && !repos.length ? <small className="hint">{t.noRemotes}</small> : state.hosts.map((host) => {
      const provider = host.provider ?? 'gitlab', projectTarget: Target = { host: host.host, provider }
      return <section className="cx-wfcard gacc-host" key={host.host}>
        <h4>{host.host}<small className="cx-muted"> · {provider === 'github' ? 'GitHub' : 'GitLab'}</small></h4>
        <div className={`gacc-token ${host.project ? 'on' : ''}`}><span className="gacc-token-label">{host.project && <i className="gacc-ok" aria-hidden="true" />}{t.projectToken}</span>{host.project ? <Who info={host.project} /> : <span className="cx-muted">{t.none}</span>}
          <span className="grow1" />
          {more(`${t.projectToken} · ${host.host}`, [{ key: 'token', label: host.project ? t.replace : t.add, icon: <TokenIcon /> }, ...(host.project ? [{ key: 'remove-token' as const, label: t.removeToken, danger: true, icon: <TrashIcon /> }] : [])], (key) => { if (key === 'token') open(projectTarget); else if (key === 'remove-token') setRemoving({ host: host.host, label: host.host }) })}</div>
        {host.repos.length > 0 && <div className="gacc-table" role="table" aria-label={host.host}>{tableHead}{host.repos.map((repo) => {
          const target: Target = { host: host.host, sourceId: repo.sourceId, provider: host.project?.provider ?? provider }
          const info = repoInfo(repo.sourceId)
          return <div key={repo.sourceId} className="gacc-tr" role="row"><b role="cell" data-tip={info?.path}>{repo.name}</b><span role="cell">{branch(info)}</span><span role="cell">{base(repo.sourceId)}</span><span role="cell">{tokenChip(repo, host)}</span>
            <span role="cell" className="gacc-act">{repoMenu(repo.sourceId, repo.name, [{ key: 'token', label: repo.own ? t.replaceOwnToken : t.useOwnToken, icon: <TokenIcon /> }, ...(repo.own ? [{ key: 'remove-token' as const, label: t.removeOwnToken, danger: true, icon: <TrashIcon /> }] : [])], (key) => { if (key === 'token') open(target); else if (key === 'remove-token') setRemoving({ host: host.host, sourceId: repo.sourceId, label: repo.name }) })}</span></div>
        })}</div>}
      </section>
    })}
    {state && repos.some((repo) => !repo.hasRemote) && <section className="cx-wfcard gacc-host">
      <h4>{t.noRemoteTitle}<small className="cx-muted"> · {t.noRemoteHint}</small></h4>
      <div className="gacc-table" role="table" aria-label={t.noRemoteTitle}>{tableHead}{repos.filter((repo) => !repo.hasRemote).map((repo) => <div key={repo.sourceId} className="gacc-tr" role="row"><b role="cell" data-tip={repo.path}>{repo.name}</b><span role="cell">{branch(repo)}</span><span role="cell">{base(repo.sourceId)}</span><span role="cell"><span className="gacc-chip none"><CrossMiniIcon />{t.noRemoteToken}</span></span><span role="cell" className="gacc-act">{repoMenu(repo.sourceId, repo.name, [])}</span></div>)}</div>
    </section>}
    {edit && state && (() => {
      const host = state.hosts.find((item) => item.host === edit.host), repo = edit.sourceId ? host?.repos.find((item) => item.sourceId === edit.sourceId) : undefined
      if (!host) return null
      return <div className="overlay" role="dialog" aria-label={t.token}><div className="modal tokdialog">
        <header><div><div className="eyebrow">{host.host}</div><h2>{repo ? `${t.ownToken} · ${repo.name}` : t.projectToken}</h2></div><button type="button" className="x" aria-label={common.close} onClick={() => setEdit(null)}>×</button></header>
        {form(host, edit)}
      </div></div>
    })()}
    {removingRepo && <ConfirmDialog eyebrow={tpj.reposTitle} title={tpj.removeRepoTitle(removingRepo.name)} text={tpj.removeRepoText} ok={common.remove} danger cancel={() => setRemovingRepo(undefined)} confirm={() => void removeRepo()} />}
    {menu && createPortal(<GitMenu x={menu.x} y={menu.y} title={menu.title} label={t.actionsOf(menu.title)} items={menu.items} run={menu.run} close={() => setMenu(undefined)} />, document.body)}
    {removing && <ConfirmDialog eyebrow={t.title} title={t.removeTitle(removing.label)} text={t.removeText} ok={t.remove} danger cancel={() => setRemoving(null)} confirm={() => void remove()} />}
  </div>
}
