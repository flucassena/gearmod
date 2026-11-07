import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { GitAccountInfo, GitAccountsState, GitRepo } from '@gearmod/contracts'
import { gitIcons } from './GitPage'
import { FolderGlyph, KeyIcon, TrashIcon } from './icons'
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
  return <span className="gacc-who">{info.invalid && <i className="gacc-dot" aria-hidden="true" />}<b>{info.name}</b> <span className="cx-muted">@{info.login}{info.email ? ` · ${info.email}` : ''} · {info.hint}</span>{info.invalid && <small className="cx-warn"> {t.invalid}</small>}</span>
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
  const branch = (repo: GitRepo | undefined): React.JSX.Element | null => repo ? <span className="pillg ok" data-tip={tp.currentBranch}>{gitIcons.branch}{repo.head ?? '—'}</span> : null
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
    await load()
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
  const repoX = (sourceId: string, name: string): React.JSX.Element => <button type="button" className="trashbtn tip" disabled={repoBusy || repos.length <= 1} data-tip={repos.length <= 1 ? tpj.lastRepoTip : tpj.removeRepoTip(name)} aria-label={tpj.removeRepoTip(name)} onClick={() => setRemovingRepo({ sourceId, name })}><TrashIcon /></button>
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
    <small className="hint">{t.hint}</small>
    <small className="hint">{tpj.reposHint}</small>
    {error && !edit && <p className="error">{error}</p>}
    {!state ? <small className="hint">{common.loading}</small> : !state.hosts.length && !repos.length ? <small className="hint">{t.noRemotes}</small> : state.hosts.map((host) => {
      const provider = host.provider ?? 'gitlab', projectTarget: Target = { host: host.host, provider }
      return <section className="cx-wfcard gacc-host" key={host.host}>
        <h4>{host.host}<small className="cx-muted"> · {provider === 'github' ? 'GitHub' : 'GitLab'}</small></h4>
        <div className={`gacc-token ${host.project ? 'on' : ''}`}><span className="gacc-token-label">{host.project && <i className="gacc-ok" aria-hidden="true" />}{t.projectToken}</span>{host.project ? <Who info={host.project} /> : <span className="cx-muted">{t.none}</span>}
          <span className="grow1" />
          <button type="button" className="mini secondary withicon" onClick={() => open(projectTarget)}><KeyIcon />{host.project ? t.replace : t.add}</button>
          {host.project && <button type="button" className="mini danger" onClick={() => setRemoving({ host: host.host, label: host.host })}>{t.removeToken}</button>}</div>
        {host.repos.length > 0 && <div className="gacc-repos">{host.repos.map((repo) => {
          const target: Target = { host: host.host, sourceId: repo.sourceId, provider: host.project?.provider ?? provider }
          const info = repoInfo(repo.sourceId)
          return <div key={repo.sourceId}><div className="gacc-row"><b data-tip={info?.path}>{repo.name}</b>{branch(info)}
            {repo.own ? <Who info={repo.own} /> : <span className="cx-muted">{repo.using === 'project' ? (host.project?.invalid ? t.projectInvalid : t.usesProject) : t.noToken}</span>}
            <span className="grow1" />
            <button type="button" className="mini secondary withicon" onClick={() => open(target)}><KeyIcon />{repo.own ? t.replace : t.ownToken}</button>
            {repo.own && <button type="button" className="mini danger" onClick={() => setRemoving({ host: host.host, sourceId: repo.sourceId, label: repo.name })}>{t.removeToken}</button>}{repoX(repo.sourceId, repo.name)}</div>
          </div>
        })}</div>}
      </section>
    })}
    {state && repos.some((repo) => !repo.hasRemote) && <section className="cx-wfcard gacc-host">
      <h4>{t.noRemoteTitle}<small className="cx-muted"> · {t.noRemoteHint}</small></h4>
      <div className="gacc-repos">{repos.filter((repo) => !repo.hasRemote).map((repo) => <div key={repo.sourceId} className="gacc-row"><b data-tip={repo.path}>{repo.name}</b>{branch(repo)}<span className="grow1" />{repoX(repo.sourceId, repo.name)}</div>)}</div>
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
    {removing && <ConfirmDialog eyebrow={t.title} title={t.removeTitle(removing.label)} text={t.removeText} ok={t.remove} danger cancel={() => setRemoving(null)} confirm={() => void remove()} />}
  </div>
}
