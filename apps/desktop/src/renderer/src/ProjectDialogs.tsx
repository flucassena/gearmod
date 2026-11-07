import { providerLabels } from '@gearmod/contracts'
import React, { useEffect, useState } from 'react'
import type { AgentProbe, AgentProfile, AppTheme, Project, ProjectInspection } from '@gearmod/contracts'
import { AgentIcon } from './AgentIcon'
import { GitMenu } from './BranchMenu'
import { FolderGlyph } from './icons'
import { SkillsPanel } from './SkillsPanel'
import { McpPanel } from './McpPanel'
import { GitPolicyPanel } from './GitPolicyPanel'
import { GitAccountsPanel } from './GitAccountsPanel'
import { WorkflowPanel } from './WorkflowPanel'
import { SddSettings } from './SddSettings'
import { ToolsPanel, useToolsPending } from './ToolsPanel'
import { ProjectIconPicker } from './ProjectIcon'
import { ThemePicker } from './SettingsDialog'
import { tr, useT } from './i18n'
import { projectTheme, setProjectTheme } from './projectTheme'
import { Checkbox } from './Checkbox'
import { plainError } from './NoticeDialog'
import { useEscape } from './useEscape'
import { ProjectCardTypes } from './CardTypes'
import { ProjectCodeIndex } from './ProjectCodeIndex'

/** New project: choose or drag the folder (prototype: `.sourcePick`). */
export function ProjectDialog({ close, created }: { close(): void; created(project: Project): void }): React.JSX.Element {
  const t = useT(), tp = t.settings.project
  const [name, setName] = useState(''), [icon, setIcon] = useState<string | null>(null), [sources, setSources] = useState<ProjectInspection[]>([]), [excluded, setExcluded] = useState<string[]>([]), [error, setError] = useState(''), [choosing, setChoosing] = useState(false), [dragging, setDragging] = useState(false)
  useEscape(close)
  const addPath = async (path: string): Promise<void> => {
    const inspected = await window.gearmod.invoke('projects:inspect', { localPath: path })
    setSources((current) => current.some((source) => source.localPath.toLocaleLowerCase() === inspected.localPath.toLocaleLowerCase()) ? current : [...current, inspected])
    setName((current) => current.trim() ? current : inspected.name)
  }
  const choose = async (): Promise<void> => { try { setChoosing(true); setError(''); const path = await window.gearmod.invoke('projects:choose-directory', undefined); if (path) await addPath(path) } catch (reason) { setError(plainError(reason)) } finally { setChoosing(false) } }
  const drop = async (event: React.DragEvent): Promise<void> => {
    event.preventDefault(); setDragging(false); setError('')
    try { for (const file of Array.from(event.dataTransfer.files)) { const path = window.gearmod.getDroppedFilePath(file); if (path) await addPath(path) } } catch (reason) { setError(plainError(reason)) }
  }
  const visibleRepos = (source: ProjectInspection): ProjectInspection['repositories'] => source.repositories.filter((repository) => !excluded.includes(repository.localPath))
  /** Takes one repository out of the project; the folder that held the last one goes away with it. */
  const dropRepo = (source: ProjectInspection, localPath: string): void => {
    if (visibleRepos(source).filter((repository) => repository.localPath !== localPath).length) { setExcluded((current) => [...current, localPath]); return }
    setSources((current) => current.filter((item) => item.localPath !== source.localPath))
    setExcluded((current) => current.filter((path) => !source.repositories.some((repository) => repository.localPath === path)))
  }
  const submit = async (): Promise<void> => { try { created(await window.gearmod.invoke('projects:create', { name: name.trim() || undefined, sourcePaths: sources.map((source) => source.localPath), excludePaths: excluded.filter((path) => sources.some((source) => source.repositories.some((repository) => repository.localPath === path))), profileIds: [], icon })) } catch (reason) { setError(plainError(reason)) } }
  return <div className="overlay" role="dialog" aria-label={tp.newTitle}><div className="modal">
    <header><div><div className="eyebrow">{tp.newTitle}</div><h2>{tp.createTitle}</h2></div><button className="x" onClick={close} aria-label={t.common.close}>×</button></header>
    <div className="stack">
      <div className="f"><span>{tp.nameLabel}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ProjectIconPicker compact name={name} icon={icon} onChange={setIcon} />
          <input className="in" style={{ flex: 1, minWidth: 0 }} aria-label={tp.nameLabel} placeholder={tp.nameLabel} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      {sources.map((source) => <div className="srcbox" key={source.localPath}>
        <div className="srchead"><span className="t"><b>{source.name}</b><small>{source.localPath}</small></span><button type="button" className="mini secondary" onClick={() => setSources((current) => current.filter((item) => item.localPath !== source.localPath))}>{t.common.remove}</button></div>
        {source.repositories.length ? <><span className="sectitle">{tp.repoCount(visibleRepos(source).length)}</span>
          <ul className="repolist">{visibleRepos(source).map((repository) => <li key={repository.localPath}><FolderGlyph /><span className="rn">{repository.name}</span><span className="ctxchip" data-tip={tp.branchTip(repository.currentBranch)}>{repository.currentBranch}</span><button type="button" className="repo-x" data-tip={tp.removeRepoTip(repository.name)} aria-label={tp.removeRepoTip(repository.name)} onClick={() => dropRepo(source, repository.localPath)}>×</button></li>)}</ul></>
          : <small className="hint">{tp.noGit}</small>}
      </div>)}
      {!sources.length && <button className="sourcePick" type="button" disabled={choosing} style={dragging ? { borderColor: 'var(--accent)' } : undefined} onClick={() => void choose()} onDragEnter={(e) => { e.preventDefault(); setDragging(true) }} onDragOver={(e) => e.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(e) => void drop(e)}>📁 {choosing ? tp.openingFolders : tp.pickFolder}<small>{tp.pickFolderHint}</small></button>}
      {sources.length > 0 && <button type="button" className="secondary withicon" disabled={choosing} style={dragging ? { borderColor: 'var(--accent)' } : undefined} onClick={() => void choose()} onDragEnter={(e) => { e.preventDefault(); setDragging(true) }} onDragOver={(e) => e.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(e) => void drop(e)}><FolderGlyph />{choosing ? tp.openingFolders : tp.addAnotherFolder}</button>}
    </div>
    {error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}
    <div className="actions"><button className="secondary" onClick={close}>{t.common.cancel}</button><button disabled={!sources.length} onClick={() => void submit()}>{tp.create}</button></div>
  </div></div>
}

/** Configure project (prototype `pcfg`): General tab (name and allowed agents), Constitution and repository Skills. */

/** Project agent team: only the enabled ones, with the icon, the name below and a connection dot; the "+" at the end adds another. */
function AgentTeam({ profiles, allowed, setAllowed, probes }: { profiles: AgentProfile[]; allowed: string[]; setAllowed(value: string[]): void; probes: Record<string, AgentProbe> }): React.JSX.Element {
  const t = useT(), tp = t.settings.project
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const team = profiles.filter((profile) => allowed.includes(profile.id)), rest = profiles.filter((profile) => !allowed.includes(profile.id))
  const state = (id: string): { tone: 'on' | 'off' | 'wait'; text: string } => { const probe = probes[id]; return !probe ? { tone: 'wait', text: tp.teamChecking } : !probe.installed ? { tone: 'off', text: tp.teamNotInstalled } : !probe.authenticated ? { tone: 'off', text: tp.teamLoginNeeded } : { tone: 'on', text: tp.teamConnected } }
  return <div className="stack" style={{ gap: 8 }}><span className="sectitle">{tp.team}</span>
    {profiles.length === 0 && <div className="emptyBox">{tp.teamEmptyProfiles}</div>}
    <div className="team">
      {team.map((profile) => { const info = state(profile.id); return <div className="teamcard" key={profile.id}>
        <span className="teamav"><AgentIcon profile={profile} size="lg" tip={false} /><i className={`teamdot ${info.tone} tip`} data-tip={info.text} aria-label={info.text} /></span>
        <b data-tip={profile.label}>{profile.label}</b><small>{providerLabels[profile.provider]}</small>
        <button type="button" className="teamx tip" data-tip={tp.removeFromTeam} aria-label={tp.removeFromTeamAria(profile.label)} onClick={() => setAllowed(allowed.filter((id) => id !== profile.id))}>×</button></div> })}
      {profiles.length > 0 && <button type="button" className="teamadd tip" data-tip={rest.length ? tp.addToTeam : tp.allInTeam} aria-label={tp.addAgentToTeam} disabled={!rest.length} onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ x: box.left, y: box.bottom + 6 }) }}><span>+</span></button>}
    </div>
    {team.length === 0 && profiles.length > 0 && <small className="hint">{tp.emptyTeam}</small>}
    {menu && <GitMenu x={menu.x} y={menu.y} title={tp.addToTeam} label={tp.addAgentToTeam} items={rest.map((profile) => ({ key: profile.id, label: `${profile.label} · ${state(profile.id).text}` }))} run={(id) => { setMenu(null); setAllowed([...allowed, id]) }} close={() => setMenu(null)} />}
  </div>
}

export function ProjectConfigDialog({ project, profiles, saved, renamed, openConstitutionChat, initialTab, initialFocus }: { initialFocus?: 'git-accounts'; project: Project; profiles: AgentProfile[]; saved(): void | Promise<void>; renamed?(): void; openConstitutionChat(prompt?: string): void; initialTab?: 'general' | 'git' }): React.JSX.Element {
  // Opened to manage the Git accounts (e.g. "Add token" on the Git page): scrolls to them and gives a quick highlight.
  useEffect(() => {
    if (initialFocus !== 'git-accounts') return
    let tries = 0, timer = 0
    const find = (): void => {
      // Waits for the accounts to load (the server cards), otherwise the page still changes height after the scroll.
      const target = document.querySelector<HTMLElement>('.modal.pcfg .gacc'), cards = [...document.querySelectorAll<HTMLElement>('.modal.pcfg .gacc .gacc-host')]
      if (target && (cards.length || tries > 30)) {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          target.scrollIntoView({ block: 'start' })
          for (const card of cards) card.classList.add('focus-flash')
          timer = window.setTimeout(() => cards.forEach((card) => card.classList.remove('focus-flash')), 1600)
        }))
        return
      }
      if (tries++ < 60) timer = window.setTimeout(find, 50)
    }
    find(); return () => window.clearTimeout(timer)
  }, [initialFocus])
  const t = useT(), tp = t.settings.project
  const [tab, setTab] = useState<'general' | 'git' | 'workflow' | 'sdd' | 'tools' | 'theme' | 'constitution' | 'skills' | 'mcp'>(initialTab ?? 'general'), [name, setName] = useState(project.name), [icon, setIcon] = useState(project.icon), [allowed, setAllowed] = useState(project.allowedProfileIds), [editingName, setEditingName] = useState(false), [saveState, setSaveState] = useState<'idle' | 'waiting' | 'saving' | 'saved'>('idle'), [error, setError] = useState(''), [ownTheme, setOwnTheme] = useState<AppTheme | null>(() => projectTheme(project.id)), [probes, setProbes] = useState<Record<string, AgentProbe>>({})
  const toolsPending = useToolsPending(project.id)
  const savedIdentity = React.useRef({ name: project.name, icon: project.icon }), identity = React.useRef({ name, icon }), saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null), saveQueue = React.useRef<Promise<void>>(Promise.resolve()), profileQueue = React.useRef<Promise<boolean>>(Promise.resolve(true)), saveVersion = React.useRef(0), profileVersion = React.useRef(0), closing = React.useRef(false)
  identity.current = { name, icon }
  const renamedRef = React.useRef(renamed); renamedRef.current = renamed
  useEffect(() => { void window.gearmod.invoke('profiles:probe-all', undefined).then((all) => setProbes(Object.fromEntries(all.map((probe) => [probe.profileId, probe])))).catch(() => undefined) }, [])
  const persistIdentity = React.useCallback(async (nextName: string, nextIcon: string | null): Promise<boolean> => {
    const cleanName = nextName.trim()
    if (!cleanName) { setError(tr().settings.project.nameRequired); return false }
    if (savedIdentity.current.name === cleanName && savedIdentity.current.icon === nextIcon) return true
    const version = ++saveVersion.current
    setSaveState('saving'); setError('')
    const operation = saveQueue.current.catch(() => undefined).then(async () => {
      if (savedIdentity.current.name === cleanName && savedIdentity.current.icon === nextIcon) return
      await window.gearmod.invoke('projects:update', { projectId: project.id, name: cleanName, icon: nextIcon })
      savedIdentity.current = { name: cleanName, icon: nextIcon }
      // The sidebar and the title bar show the new name right away, without waiting for the dialog to close.
      renamedRef.current?.()
    })
    saveQueue.current = operation
    try { await operation; if (version === saveVersion.current) setSaveState('saved'); return true } catch (reason) { if (version === saveVersion.current) { setSaveState('idle'); setError(plainError(reason)) } return false }
  }, [project.id])
  useEffect(() => {
    if (!name.trim() || (savedIdentity.current.name === name.trim() && savedIdentity.current.icon === icon)) return
    setSaveState('waiting')
    saveTimer.current = setTimeout(() => { saveTimer.current = null; void persistIdentity(name, icon) }, 650)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); saveTimer.current = null }
  }, [icon, name, persistIdentity])
  const finish = React.useCallback(async (): Promise<void> => {
    if (closing.current) return
    closing.current = true
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    const current = identity.current
    const validName = current.name.trim() ? current.name : savedIdentity.current.name
    if (!current.name.trim()) setName(validName)
    if (!await persistIdentity(validName, current.icon)) { closing.current = false; return }
    await saveQueue.current.catch(() => undefined)
    if (!await profileQueue.current) { closing.current = false; return }
    await saved()
  }, [persistIdentity, saved])
  useEscape(() => { void finish() })
  const changeAllowed = (next: string[]): void => {
    const previous = allowed, version = ++profileVersion.current
    setAllowed(next); setSaveState('saving'); setError('')
    const operation = profileQueue.current.catch(() => false).then(async () => { await window.gearmod.invoke('projects:set-profiles', { projectId: project.id, profileIds: next }); return true })
    profileQueue.current = operation.catch(() => false)
    // Failed: goes back to the previous list (the saved one) and releases closing; otherwise × and Esc stayed stuck.
    void operation.then(() => { if (version === profileVersion.current) setSaveState('saved') }).catch((reason: unknown) => { if (version === profileVersion.current) { setAllowed(previous); setSaveState('idle'); setError(plainError(reason)); profileQueue.current = Promise.resolve(true) } })
  }
  const stopEditingName = (): void => { if (!name.trim()) setName(savedIdentity.current.name); setEditingName(false) }
  // Esc in the name field undoes the edit (back to the name before editing) without closing the dialog.
  const nameBeforeEdit = React.useRef(project.name)
  useEffect(() => { if (editingName) nameBeforeEdit.current = savedIdentity.current.name }, [editingName])
  useEscape(() => { setName(nameBeforeEdit.current); setError(''); setEditingName(false) }, editingName)
  const saveLabel = saveState === 'waiting' ? tp.autosavePending : saveState === 'saving' ? t.common.saving : saveState === 'saved' ? tp.autosaved : tp.autosaveInfo
  return <div className="overlay" role="dialog" aria-label={tp.configure}><div className="modal pcfg" style={{ width: 'min(920px,100%)' }}>
    <header><div className="pcfg-heading"><div className="eyebrow">{tp.configure}</div><div className="pcfg-identity"><ProjectIconPicker compact name={name} icon={icon} onChange={setIcon} /><div className="pcfg-name"><h2>{editingName
      ? <input className="pcfg-name-input" value={name} autoFocus aria-label={tp.nameLabel} onFocus={(event) => event.currentTarget.select()} onChange={(event) => { setName(event.target.value); setError('') }} onBlur={stopEditingName} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
      : <button type="button" className="pcfg-name-edit" onClick={() => setEditingName(true)} data-tip={tp.editNameTip}><span>{name.trim() || project.name}</span><span className="pcfg-name-pencil" aria-hidden="true">✎</span></button>}</h2><small className={`pcfg-save-state ${saveState}`}>{saveLabel}</small></div></div></div><button className="x" onClick={() => void finish()} aria-label={t.common.close}>×</button></header>
    <div className="tabs" role="tablist" style={{ marginBottom: 14 }}>{([['general', tp.tabGeneral], ['git', 'Git'], ['workflow', 'Workflow'], ['sdd', 'SDD'], ['tools', tp.tabTools], ['skills', t.settings.dialog.tabSkills], ['mcp', 'MCP']] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} className={`tab ${tab === value ? 'on' : ''}`} onClick={() => setTab(value)}>{label}{value === 'tools' && toolsPending && <i className="tab-dot" data-tip={tp.toolUpdateTip} />}</button>)}</div>
    <div className={`pcfg-body ${tab === 'skills' ? 'fill' : ''}`}>{tab === 'general' ? <>
      <div className="stack pcfg-general"><section className="cx-wfcard"><ThemePicker project value={ownTheme} onChange={(value) => { setOwnTheme(value); setProjectTheme(project.id, value) }} /></section>
        <section className="cx-wfcard"><AgentTeam profiles={profiles} allowed={allowed} setAllowed={changeAllowed} probes={probes} /></section>
        <section className="cx-wfcard"><ProjectCardTypes project={project} /></section>
        <section className="cx-wfcard"><ProjectCodeIndex project={project} /></section>
        </div>
      {error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}</>
      : tab === 'git' ? <><GitPolicyPanel projectId={project.id} /><GitAccountsPanel projectId={project.id} openFirst={initialFocus === 'git-accounts'} /></>
      : tab === 'workflow' ? <WorkflowPanel projectId={project.id} />
      : tab === 'sdd' ? <SddSettings project={project} openConstitutionChat={openConstitutionChat} onOpenReference={() => void finish()} />
      : tab === 'tools' ? <ToolsPanel projectId={project.id} openedTerminal={() => void finish()} />
      : tab === 'mcp' ? <div className="skwrap"><McpPanel scope="project" projectId={project.id} available={['claude', 'codex']} /></div>
      : <div className="skwrap"><SkillsPanel scope="project" projectId={project.id} profiles={profiles.filter((profile) => allowed.includes(profile.id))} globalCount={0} /></div>}</div>
  </div></div>
}

/** Card with no agent enabled in the project: enables an already registered one or leads to registration. */
export function NoAgentDialog({ project, profiles, close, allowed, openSettings }: { project: Project; profiles: AgentProfile[]; close(): void; allowed(): void; openSettings(): void }): React.JSX.Element {
  const t = useT(), tp = t.settings.project
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEscape(close)
  const use = async (profile: AgentProfile): Promise<void> => {
    setBusy(true); setError('')
    try { await window.gearmod.invoke('projects:set-profiles', { projectId: project.id, profileIds: [...new Set([...project.allowedProfileIds, profile.id])] }); allowed() } catch (reason) { setError(plainError(reason)) } finally { setBusy(false) }
  }
  return <div className="overlay" role="dialog" aria-label={tp.noAgentAria}><div className="modal" style={{ width: 'min(480px,100%)' }}>
    <header><div><div className="eyebrow">{t.common.agent}</div><h2>{tp.noAgentTitle}</h2></div><button className="x" onClick={close} aria-label={t.common.close}>×</button></header>
    <p style={{ marginBottom: 12 }}>{tp.noAgentText}</p>
    <div className="stack" style={{ gap: 8 }}>{profiles.map((profile) => <div className="ck-line" key={profile.id}><AgentIcon profile={profile} tip={false} /><span className="t">{profile.label}<small>{providerLabels[profile.provider]} · {profile.scope}</small></span><button className="mini" disabled={busy} onClick={() => void use(profile)}>{tp.use}</button></div>)}</div>
    {error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}
    <button className="bigadd" onClick={openSettings}>{tp.registerAgent}</button>
  </div></div>
}

/** Right after creating the project: which agents will work on it. With no agent registered, tells to register one in the system first. */
export function ProjectAgentsDialog({ project, profiles, close, saved, openSettings }: { project: Project; profiles: AgentProfile[]; close(): void; saved(): void; openSettings(): void }): React.JSX.Element {
  const t = useT(), tp = t.settings.project
  const [allowed, setAllowed] = useState<string[]>(project.allowedProfileIds), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEscape(close)
  const submit = async (): Promise<void> => {
    setBusy(true); setError('')
    try { await window.gearmod.invoke('projects:set-profiles', { projectId: project.id, profileIds: allowed }); saved() } catch (reason) { setError(plainError(reason)) } finally { setBusy(false) }
  }
  return <div className="overlay" role="dialog" aria-label={tp.agentsAria}><div className="modal" style={{ width: 'min(520px,100%)' }}>
    <header><div><div className="eyebrow">{tp.created}</div><h2>{tp.whichAgents(project.name)}</h2></div><button className="x" onClick={close} aria-label={t.common.close}>×</button></header>
    {profiles.length === 0 ? <>
      <div className="emptyBox">{tp.noneRegistered}</div>
      <button className="bigadd" onClick={openSettings}>{tp.registerInSystem}</button>
      <div className="actions"><button className="secondary" onClick={close}>{tp.notNow}</button></div></>
    : <>
      <p style={{ marginBottom: 12 }}>{tp.chooseAgents}</p>
      <div className="stack" style={{ gap: 8 }}>{profiles.map((profile) => <label className="ck-line" key={profile.id}>
        <Checkbox checked={allowed.includes(profile.id)} onChange={() => setAllowed(allowed.includes(profile.id) ? allowed.filter((id) => id !== profile.id) : [...allowed, profile.id])} />
        <AgentIcon profile={profile} tip={false} /><span className="t">{profile.label}<small>{providerLabels[profile.provider]} · {profile.scope}</small></span></label>)}</div>
      {error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}
      <div className="actions"><button className="secondary" onClick={openSettings}>{tp.registerAnother}</button><button className="secondary" onClick={close}>{tp.notNow}</button><button disabled={busy || allowed.length === 0} onClick={() => void submit()}>{tp.allowAgents}</button></div></>}
  </div></div>
}
