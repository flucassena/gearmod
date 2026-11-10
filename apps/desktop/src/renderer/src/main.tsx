import React, { useEffect, useRef, useState } from 'react'
import { loadLatest } from './toolUpdates'
import ReactDOM from 'react-dom/client'
import type { AgentConfig, AgentProfile, AppSettings, Project, ProjectBoard } from '@gearmod/contracts'
import './theme-tokens.css'
import './prototype.css'
import { installCloseOnScroll } from './closeOnScroll'
import { Board } from './Board'
import { ProjectAgentsDialog, ProjectConfigDialog, ProjectDialog } from './ProjectDialogs'
import { AgentDialog, applySettings, applyTheme, SettingsDialog } from './SettingsDialog'
import { markInviteSeen, readInviteSeen, shouldInviteAgent } from './agentLogin'
import { RunLimitPrompt } from './RunLimitPrompt'
import { projectTheme, projectThemeEvent } from './projectTheme'
import { Sidebar } from './Sidebar'
import { FolderGlyph } from './icons'
import logo from './assets/logo.png'
import { BrandMark } from './Thinking'
import { ConfirmDialog } from './ConfirmDialog'
import { TooltipLayer } from './Tooltip'
import { pop } from './popout'
import { applyMessageSpacing } from './chatPrefs'
import { TerminalPanel } from './TerminalPanel'
import { terminal, useTerminal } from './terminalStore'
import { WorkspaceFiles } from './WorkspaceFiles'
import { filesQuickEvent, shortcutEvent, shortcutFor } from './shortcuts'
import { FileContextMenu } from './FileContextMenu'
import { WindowIcon } from './WindowLayoutMenu'
import { gitChangedEvent } from './GitSetup'
import { TasksButton } from './TasksButton'
import { ToastHost } from './ToastHost'
import { toast } from './toasts'
import { plainError } from './NoticeDialog'
import { useT } from './i18n'
import { refreshGit } from './gitConfigCache'
import type { FileChange } from './changes'
import { markPlatform } from './platform'
import { hasAttachmentTarget, hasCommentTarget, queueContextFile, queueContextText } from './Attachments'

const defaultSettings: AppSettings = { tema: 'green', idioma: 'pt-BR', voz: 'small', notificacoes: true, retomarSozinho: true, fotosGravatar: false, execucoesSimultaneas: null }
/** Last project opened in the main window (localStorage: just a local preference). */
const lastProjectKey = 'gearmod.lastProject'

// Reads the local cache right at startup. With valid data (for 24 h), this makes no network call and the Tools tab already opens with the warnings.
void loadLatest().catch(() => undefined)

function App(): React.JSX.Element {
  const t = useT()  // changing language re-renders the whole tree
  const terminalState = useTerminal()
  const filePop = pop?.kind === 'file' || pop?.kind === 'files' ? pop : null, filePopout = Boolean(filePop)
  const [filesOpen, setFilesOpen] = useState(filePopout), [fileContext, setFileContext] = useState<{ projectId: string; cardId: string | null; path?: string; reveal?: { path: string; at: number } } | null>(filePop ? { projectId: filePop.projectId, cardId: filePop.cardId, path: filePop.path ?? undefined } : null)
  const [changesView, setChangesView] = useState<{ projectId: string; cardId: string; files: FileChange[]; at: number } | null>(null)
  const [fileSessions, setFileSessions] = useState<Array<{ projectId: string; cardId: string | null; path?: string; reveal?: { path: string; at: number } }>>(fileContext ? [fileContext] : [])
  const showFiles = (target: { projectId: string; cardId: string | null; path?: string; reveal?: { path: string; at: number } }): void => {
    setFileSessions((all) => all.some((item) => item.projectId === target.projectId && item.cardId === target.cardId) ? all.map((item) => item.projectId === target.projectId && item.cardId === target.cardId ? { ...item, ...target } : item) : [...all, target]); setFileContext(target); setFilesOpen(true)
  }
  const [projects, setProjects] = useState<Project[]>([]), [profiles, setProfiles] = useState<AgentProfile[]>([]), [selected, setSelected] = useState<string | undefined>(pop?.projectId), [board, setBoard] = useState<ProjectBoard>()
  const selectedRef = useRef(selected); selectedRef.current = selected
  const [profilesLoaded, setProfilesLoaded] = useState(false), [agentInvite, setAgentInvite] = useState<string>(), [addingAgent, setAddingAgent] = useState(false)
  const [removed, setRemoved] = useState<AgentProfile[]>([]), [freeRequest, setFreeRequest] = useState<{ projectId: string; at: number }>(), [constitutionRequest, setConstitutionRequest] = useState<{ projectId: string; prompt?: string; at: number; mode?: 'constitution' | 'test-setup'; config?: AgentConfig }>(), [openTarget, setOpenTarget] = useState<{ projectId: string; cardId: string | null; chatId: string | null; purpose: string | null } | undefined>(pop?.kind === 'chat' && (pop.cardId || pop.chatId) ? { projectId: pop.projectId, cardId: pop.cardId, chatId: pop.chatId, purpose: pop.purpose } : undefined), [newProject, setNewProject] = useState(false), [settingsOpen, setSettingsOpen] = useState(false), [settingsTab, setSettingsTab] = useState<'general' | 'agents'>(), [projectConfig, setProjectConfig] = useState<string>(), [settings, setSettings] = useState<AppSettings>(defaultSettings), [collapsed, setCollapsed] = useState(false), [agentsPrompt, setAgentsPrompt] = useState<string>(), [error, setError] = useState(''), [deleting, setDeleting] = useState<Project>()
  const [configTab, setConfigTab] = useState<'general' | 'git' | 'tests'>('general'), [configFocus, setConfigFocus] = useState<'git-accounts'>()
  const [panelMenu, setPanelMenu] = useState<{ kind: 'files' | 'terminal'; x: number; y: number }>()
  const openPanelWindow = async (kind: 'files' | 'terminal'): Promise<void> => {
    if (!selected) return
    try {
      const state = terminal.snapshot(), context = state.context?.projectId === selected ? state.context : { projectId: selected, cardId: null }
      const terminalId = kind === 'terminal' ? state.active ?? await terminal.newTab() : undefined
      if (kind === 'terminal' && !terminalId) return
      await window.gearmod.invoke('windows:open', { kind, projectId: selected, cardId: (kind === 'files' && fileContext?.projectId === selected ? fileContext.cardId : context.cardId) ?? undefined, ...(terminalId ? { terminalId } : {}), placement: 'new' })
    } catch (reason) { toast.error(t.shell.app.openWindowFailed, plainError(reason)) }
  }
  const reloadProjects = async (): Promise<void> => { const [p, a, gone] = await Promise.all([window.gearmod.invoke('projects:list', undefined), window.gearmod.invoke('profiles:list', undefined), window.gearmod.invoke('profiles:removed', undefined)]); setProjects(p); setProfiles(a); setProfilesLoaded(true); setRemoved(gone.map((item) => ({ ...item, label: t.shell.app.disabledSuffix(item.label) }))) }
  const reloadBoard = async (id = selected): Promise<void> => { if (id) setBoard(await window.gearmod.invoke('board:get', { projectId: id })) }
  const refresh = async (): Promise<void> => { await Promise.all([reloadBoard(), reloadProjects()]) }
  const toggleFiles = (): void => {
    if (filesOpen && fileContext?.projectId === selected) { setFilesOpen(false); return }
    if (!selected) return
    const context = terminal.snapshot().context
    showFiles({ projectId: selected, cardId: context?.projectId === selected ? context.cardId : null })
  }
  const toggleTerminal = (): void => { const current = terminal.snapshot(); if (current.open) terminal.setOpen(false); else if (!current.tabs.length) void terminal.newTab(); else terminal.setOpen(true) }
  useEffect(() => {
    if (!selected) { if (terminal.snapshot().context) terminal.setContext(null) }
    else if (terminal.snapshot().context?.projectId !== selected) terminal.setContext({ projectId: selected, cardId: null })
  }, [selected])
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.repeat) return
      const id = shortcutFor(event)
      if (!id) return
      event.preventDefault()
      if (id === 'toggleFiles') toggleFiles()
      else if (id === 'quickOpenFile' || id === 'searchInFiles' || id === 'searchSymbols') {
        const mode = id === 'quickOpenFile' ? 'files' : id === 'searchInFiles' ? 'content' : 'symbols'
        const ask = (): void => { window.dispatchEvent(new CustomEvent(filesQuickEvent, { detail: { mode } })) }
        if (filesOpen && fileContext?.projectId === selected) ask(); else if (selected) { toggleFiles(); window.setTimeout(ask, 250) }
      }
      else if (id === 'toggleTerminal') toggleTerminal()
      else if (id === 'toggleSidebar') { autoCollapsed.current = false; setCollapsed((value) => !value) }
      else window.dispatchEvent(new CustomEvent(shortcutEvent, { detail: { id } }))
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [selected, filesOpen, fileContext])
  useEffect(() => window.gearmod.onRunEvent((event) => {
    if (event.eventType === 'gearmod/attach-file' && !pop) {
      const target = event.payload as { projectId: string; cardId: string | null; path: string }
      const attached = hasAttachmentTarget(target); queueContextFile(target); setSelected(target.projectId)
      if (!attached) { if (target.cardId) setOpenTarget({ projectId: target.projectId, cardId: target.cardId, chatId: null, purpose: 'execution' }); else setFreeRequest({ projectId: target.projectId, at: Date.now() }) }
      setFilesOpen(false); return
    }
    if (event.eventType === 'gearmod/comment-file' && !pop) {
      const target = event.payload as { projectId: string; cardId: string | null; text: string }
      const attached = hasCommentTarget(target); queueContextText(target); setSelected(target.projectId)
      if (!attached) { if (target.cardId) setOpenTarget({ projectId: target.projectId, cardId: target.cardId, chatId: null, purpose: 'execution' }); else setFreeRequest({ projectId: target.projectId, at: Date.now() }) }
      setFilesOpen(false); return
    }
    if (event.eventType !== 'gearmod/open-file' || pop) return
    const target = event.payload as { projectId: string; cardId: string | null; path: string }
    setSelected(target.projectId); showFiles(target)
  }), [])
  useEffect(() => {
    const open = (event: Event): void => { const target = (event as CustomEvent<{ projectId: string; cardId: string | null; path?: string; directory?: boolean }>).detail; setSelected(target.projectId); showFiles(target.directory ? { projectId: target.projectId, cardId: target.cardId, path: undefined, reveal: target.path ? { path: target.path, at: Date.now() } : undefined } : { ...target, reveal: undefined }) }
    const changes = (event: Event): void => { const detail = (event as CustomEvent<{ projectId: string; cardId: string; files: FileChange[] }>).detail; setSelected(detail.projectId); setChangesView({ ...detail, at: Date.now() }) }
    const config = (event: Event): void => { const detail = (event as CustomEvent<{ tab?: 'general' | 'git' | 'tests'; focus?: 'git-accounts' }>).detail; setConfigTab(detail?.tab ?? 'general'); setConfigFocus(detail?.focus); setProjectConfig(selectedRef.current) }
    window.addEventListener('gearmod:open-project-config', config)
    window.addEventListener('gearmod:open-file', open); window.addEventListener('gearmod:open-changes', changes)
    return () => { window.removeEventListener('gearmod:open-file', open); window.removeEventListener('gearmod:open-changes', changes); window.removeEventListener('gearmod:open-project-config', config) }
  }, [])
  useEffect(() => { void window.gearmod.invoke('settings:get', undefined).then(setSettings).catch((e: unknown) => setError(plainError(e))) }, [])
  // First visit to a project with no agent: invites the user to add one (the new-project dialog already covers a just-created project).
  useEffect(() => {
    if (pop || !profilesLoaded || !selected) return
    if (agentsPrompt === selected) { markInviteSeen(selected); return }
    if (shouldInviteAgent({ projectId: selected, agentCount: profiles.length, seen: readInviteSeen(), busy: settingsOpen || newProject })) { markInviteSeen(selected); setAgentInvite(selected) }
  }, [selected, profilesLoaded, profiles.length])
  const [themeTick, setThemeTick] = useState(0)
  useEffect(() => { const again = (): void => setThemeTick((value) => value + 1); window.addEventListener(projectThemeEvent, again); return () => window.removeEventListener(projectThemeEvent, again) }, [])
  // Global theme in settings; each project can have its own (Configure project > General) and it applies while that project is open.
  useEffect(() => { applySettings(settings); const own = projectTheme(selected); if (own) applyTheme(own) }, [settings, selected, themeTick])
  useEffect(() => { void reloadProjects().catch((e: unknown) => setError(plainError(e))) }, [])
  // The main window remembers the last opened project: when reloading or reopening the app, it goes back to it (if it still exists).
  const restoredProject = useRef(false)
  useEffect(() => { if (pop || !selected) return; try { localStorage.setItem(lastProjectKey, selected) } catch { /* local preference */ } }, [selected])
  useEffect(() => {
    if (pop || restoredProject.current || !projects.length) return
    restoredProject.current = true
    if (selected) return
    try { const last = localStorage.getItem(lastProjectKey); if (last && projects.some((project) => project.id === last)) setSelected(last) } catch { /* no storage: starts with no project */ }
  }, [projects])
  // Click on a system notification: goes to the project and opens the card's chat (or the free chat).
  useEffect(() => window.gearmod.onRunEvent((event) => { if (event.eventType === 'gearmod/open-target') { const target = event.payload as { projectId: string; cardId: string | null; chatId: string | null; purpose: string | null }; setSelected(target.projectId); setOpenTarget(target) } }), [])
  useEffect(() => window.gearmod.onRunEvent((event) => { if (['gearmod/run-started', 'gearmod/run-completed', 'gearmod/card-updated', 'gearmod/permission-requested', 'gearmod/permission-resolved'].includes(event.eventType)) void reloadProjects() }), [])
  // Opening the files collapses the main menu (the panel sits beside the board); on closing, the menu comes back if the app was the one that collapsed it.
  const [viewSlot, setViewSlot] = useState<HTMLElement | null>(null), [gearSlot, setGearSlot] = useState<HTMLElement | null>(null), [traySlot, setTraySlot] = useState<HTMLElement | null>(null)
  // Narrow bar: the buttons next to the gear move to the three-dot menu before passing under the window buttons.
  const [narrowBar, setNarrowBar] = useState(false), [trayOpen, setTrayOpen] = useState(false), actionsRef = useRef<HTMLDivElement>(null)
  useEffect(() => { const measure = (): void => setNarrowBar(window.innerWidth < (collapsed ? 840 : 1040)); measure(); window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure) }, [collapsed])
  useEffect(() => { if (!narrowBar) setTrayOpen(false) }, [narrowBar])
  useEffect(() => {
    if (!trayOpen) return
    const close = (event: MouseEvent): void => { if (!actionsRef.current?.contains(event.target as Node)) setTrayOpen(false) }
    const esc = (event: KeyboardEvent): void => { if (event.key === 'Escape') setTrayOpen(false) }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [trayOpen])
  const autoCollapsed = useRef(false)
  useEffect(() => {
    if (pop) return
    if (filesOpen && !collapsed) { autoCollapsed.current = true; setCollapsed(true) }
    else if (!filesOpen && autoCollapsed.current) { autoCollapsed.current = false; setCollapsed(false) }
  }, [filesOpen])
  // When the project opens, looks for repositories created or configured externally and, if the registry changed, reloads the board.
  useEffect(() => {
    if (!selected) { setBoard(undefined); return }
    let alive = true
    void reloadBoard(selected).then(() => refreshGit(selected)).then((changed) => { if (alive && changed) return reloadBoard(selected) }).catch((e: unknown) => { if (alive) setError(plainError(e)) })
    return () => { alive = false }
  }, [selected])
  useEffect(() => { const again = (): void => { void refresh().catch(() => undefined) }; window.addEventListener(gitChangedEvent, again); return () => window.removeEventListener(gitChangedEvent, again) }, [selected])
  const configProject = projects.find((project) => project.id === projectConfig)
  return <>
    {/* Top strip: drags the window; the Windows buttons sit on the right, on top of it. */}
    <div className={`titlebar ${collapsed ? 'collapsed' : ''}`}>{!pop && <span className="tb-side" />}<span className="tb-brand"><BrandMark src={logo} size={26} />GearMod</span><span className="tb-slot tb-slot-gear" ref={setGearSlot} />{board && <span className="tb-title" data-tip={board.project.name}>{board.project.name}</span>}{board && <button type="button" className="pathchip tb-path tip" data-tip={t.shell.app.pathChipTip} aria-label={t.shell.app.pathChipLabel(board.project.localPath)} onClick={(event) => { if (event.detail === 0) void window.gearmod.invoke('workspace:external', { projectId: board.project.id, cardId: null, path: board.project.localPath, target: 'default' }).catch((reason: unknown) => toast.error(t.shell.app.openFolderFailed, plainError(reason))) }} onDoubleClick={() => { void window.gearmod.invoke('workspace:external', { projectId: board.project.id, cardId: null, path: board.project.localPath, target: 'default' }).catch((reason: unknown) => toast.error(t.shell.app.openFolderFailed, plainError(reason))) }}><FolderGlyph />{board.project.localPath}</button>}{!filePopout && <div className={`tb-actions ${narrowBar ? 'narrow' : ''} ${trayOpen ? 'open' : ''}`} ref={actionsRef}><span className="tb-slot tb-slot-view" ref={setViewSlot} />{narrowBar && <button type="button" className={`ibtn tip tb-more ${trayOpen ? 'on' : ''}`} data-tip={t.shell.app.more} aria-label={t.shell.app.moreBarOptions} aria-haspopup="true" aria-expanded={trayOpen} onClick={() => setTrayOpen(!trayOpen)}><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="4" r="1.4" /><circle cx="10" cy="10" r="1.4" /><circle cx="10" cy="16" r="1.4" /></svg></button>}<div className="tb-tray">{selected && <button type="button" className={`ibtn tip ${filesOpen ? 'on' : ''}`} data-tip={t.shell.app.filesTip} aria-label={t.shell.app.toggleFiles} aria-pressed={filesOpen} onContextMenu={(event) => { event.preventDefault(); setPanelMenu({ kind: 'files', x: event.clientX, y: event.clientY }) }} onClick={toggleFiles}><FolderGlyph /></button>}<button type="button" className={`ibtn tip ${terminalState.open ? 'on' : ''}`} data-tip={t.shell.app.terminalTip} aria-label={t.shell.app.toggleTerminal} aria-pressed={terminalState.open} onContextMenu={(event) => { event.preventDefault(); setPanelMenu({ kind: 'terminal', x: event.clientX, y: event.clientY }) }} onClick={toggleTerminal}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 5 5 5-5 5M11 15h5" /></svg></button><TasksButton /><span className="tb-slot" ref={setTraySlot} /></div></div>}</div>
    <div className={`shell ${collapsed ? 'collapsed' : ''} ${pop ? 'popout' : ''}`}>
    {!pop && <Sidebar projects={projects} profiles={profiles} selected={selected} collapsed={collapsed} onSelect={setSelected} onOpenCard={(projectId, cardId) => { setSelected(projectId); setOpenTarget({ projectId, cardId, chatId: null, purpose: null }) }} onNew={() => setNewProject(true)} onSettings={() => setSettingsOpen(true)} onAddAgent={() => { setSettingsTab('agents'); setSettingsOpen(true) }} onProjectSettings={(id) => { setConfigTab('general'); setConfigFocus(undefined); setProjectConfig(id) }} onNewChat={(id) => { setSelected(id); setFreeRequest({ projectId: id, at: Date.now() }) }} onToggle={() => setCollapsed(!collapsed)}
      onReorder={(ids) => { setProjects((current) => ids.map((id) => current.find((item) => item.id === id)!).filter(Boolean)); void window.gearmod.invoke('projects:reorder', { projectIds: ids }).then(setProjects).catch((e: unknown) => setError(plainError(e))) }}
      onDelete={setDeleting} />}
    {filePopout || pop?.kind === 'terminal' ? <div /> : board ? <Board key={board.project.id} slots={{ view: viewSlot, gear: gearSlot, tray: traySlot }} board={board} profiles={profiles} history={[...profiles, ...removed]} refresh={refresh} onProjectConfig={(tab) => { setConfigFocus(undefined); setConfigTab(tab ?? 'general'); setProjectConfig(board.project.id) }} openSettings={() => { setSettingsTab('agents'); setSettingsOpen(true) }} freeRequest={freeRequest} freeHandled={() => setFreeRequest(undefined)} constitutionRequest={constitutionRequest} constitutionHandled={() => setConstitutionRequest(undefined)} openTarget={openTarget} targetHandled={() => setOpenTarget(undefined)} />
      : <div className="content"><main><div className="head"><div className="lead"><div><div className="eyebrow">{t.shell.app.emptyEyebrow}</div><h1>{projects.length ? t.shell.app.pickProject : t.shell.app.startWithFolder}</h1><p>{t.shell.app.emptyText}</p></div></div></div>{!projects.length && <button style={{ marginTop: 18 }} onClick={() => setNewProject(true)}>{t.shell.app.addFirstProject}</button>}{error && <p className="error" style={{ marginTop: 14 }}>{error}</p>}</main></div>}
    {newProject && <ProjectDialog close={() => setNewProject(false)} created={async (project) => { setNewProject(false); await reloadProjects(); setSelected(project.id); setAgentsPrompt(project.id) }} />}
    {settingsOpen && <SettingsDialog profiles={profiles} settings={settings} initialTab={settingsTab} close={() => { setSettingsOpen(false); setSettingsTab(undefined) }} changed={refresh} settingsChanged={setSettings} />}
    {agentInvite && !settingsOpen && !newProject && !addingAgent && <ConfirmDialog eyebrow={t.common.agent} title={t.settings.agentInvite.title} text={t.settings.agentInvite.text} ok={t.settings.agentInvite.ok} cancel={() => setAgentInvite(undefined)} confirm={() => { setAgentInvite(undefined); setAddingAgent(true) }} />}
    {addingAgent && <AgentDialog close={() => setAddingAgent(false)} changed={refresh} />}
    <RunLimitPrompt openSettings={() => { setSettingsTab('general'); setSettingsOpen(true) }} />
    {agentsPrompt && !settingsOpen && !newProject && projects.find((item) => item.id === agentsPrompt) && <ProjectAgentsDialog project={projects.find((item) => item.id === agentsPrompt)!} profiles={profiles} close={() => setAgentsPrompt(undefined)} saved={async () => { setAgentsPrompt(undefined); await refresh() }} openSettings={() => { setSettingsTab('agents'); setSettingsOpen(true) }} />}
    {configProject && <ProjectConfigDialog initialTab={configTab} initialFocus={configFocus} project={configProject} profiles={profiles} renamed={() => void reloadProjects()} saved={async () => { setProjectConfig(undefined); await refresh() }} openConstitutionChat={(prompt) => { setProjectConfig(undefined); setSelected(configProject.id); setConstitutionRequest({ projectId: configProject.id, prompt, at: Date.now() }) }} openTestSetupChat={(prompt, config) => { setProjectConfig(undefined); setSelected(configProject.id); setConstitutionRequest({ projectId: configProject.id, prompt, at: Date.now(), mode: 'test-setup', config }) }} />}
    {deleting && <ConfirmDialog eyebrow={t.shell.app.deleteProject} title={deleting.name} text={t.shell.app.deleteProjectText} ok={t.shell.app.deleteProject} danger cancel={() => setDeleting(undefined)} confirm={() => { const gone = deleting; setDeleting(undefined); void window.gearmod.invoke('projects:delete', { projectId: gone.id }).then(async () => { if (selected === gone.id) setSelected(undefined); await reloadProjects() }).catch((e: unknown) => setError(plainError(e).replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, ''))) }} />}
  </div>
    <ToastHost />
    {changesView && <div className="wf-host"><WorkspaceFiles key={changesView.at} projectId={changesView.projectId} cardId={changesView.cardId} changes={changesView.files} startExpanded close={() => setChangesView(null)} /></div>}
    {fileSessions.map((session) => <div key={`${session.projectId}:${session.cardId}`} className="wf-host" style={{ display: filesOpen && session.projectId === selected && session.projectId === fileContext?.projectId && session.cardId === fileContext.cardId ? undefined : 'none' }}><WorkspaceFiles projectId={session.projectId} cardId={session.cardId} initialPath={session.path} initialReveal={session.reveal} initialPaths={filePop?.paths ?? []} standalone={filePopout} isolated={filePop?.kind === 'file'} startExpanded={filePop?.kind === 'files'} close={() => { if (filePopout) window.close(); else setFilesOpen(false) }} /></div>)}
    <TerminalPanel standalone={pop?.kind === 'terminal'} />
    {panelMenu && <FileContextMenu x={panelMenu.x} y={panelMenu.y} label={panelMenu.kind === 'files' ? t.shell.app.filesActions : t.shell.app.terminalActions} items={[{ label: t.shell.app.openInNewWindow, icon: <WindowIcon />, disabled: !selected, action: () => void openPanelWindow(panelMenu.kind) }]} close={() => setPanelMenu(undefined)} />}
    <TooltipLayer />
  </>
}

applyMessageSpacing()
markPlatform(document.documentElement)
installCloseOnScroll()
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
