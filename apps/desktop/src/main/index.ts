import { pngToIco, tintIcon } from './brandIcon'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, shell, Tray, utilityProcess, type OpenDialogOptions } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { chmod, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { oppositePlacement, placementBounds, popoutQuery, type PopoutTarget, type WindowPlacement } from './windows'
import { TerminalService } from './terminals'
import { FileWatchService } from './file-watch'
import { SpecToolsService } from './spec-tools'
import { ToolUpdateService } from './tool-updates'
import { BackupService } from './backup'
import { AppDatabase, SchemaTooNewError } from './database'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { registerIpc } from './ipc'
import { readAbout, UpdateService } from './updater'
import { StorageService } from './storage'
import { boundsFor, readWindowState, writeWindowState } from './window-state'
import { release as osRelease, version as osVersion } from 'node:os'
import { SpecKitRuntime } from './speckit'
import { McpRegistry } from './mcp-registry'
import { GeminiCliAdapter } from './gemini-adapter'
import { NoteRepository } from './repository'
import { recommendedConcurrency } from './capacity'
import { SettingsRepository } from './settings'
import { AgentContextService } from './agent-context'
import { McpBridge } from './mcp-bridge'
import { AgentWriteback } from './agent-writeback'
import { ExecutionService } from './executions'
import { AgentConfigRepository } from './agent-config'
import { SkillService } from './skills'
import { VoiceService } from './voice'
import { UsageService } from './usage'
import { CollaborationService } from './collaboration'
import { BoardRepository, GitService, ProfileRepository, ProjectRepository, setLiveWaitingChats } from './projects'
import { AgentProbeService } from './agents'
import { finishNotice, Notifier } from './notifier'
import { hiddenNotice, quitPrompt, trayTooltip } from './background'
import { ConversationRepository } from './conversations'
import { ClaudeCliAdapter, CodexAppServerAdapter, nodeProcesses, listCodexModels, probeClaudeLimits, readCodexQuota } from './adapters'
import { AgentOrchestrator } from './orchestrator'
import { WorktreeService } from './worktrees'
import { GitManager } from './git-manager'
import { PullRequestService } from './pull-requests'
import { GitAccounts } from './git-accounts'
import { QualityService } from './quality'
import { ConstitutionRepository } from './constitution'
import { CardHistoryService } from './history'
import { exportPlanArtifacts, refreshArtifactCopies, resolvedSddRoot } from './workflows'
import { HarnessService } from './harness'
import { PlaywrightCliService } from './playwright-cli'
import { ChecklistRepository, failedChecklistItems } from './checklists'
import { AutoResumeRepository, AutoResumeService } from './auto-resume'
import { UsageLedgerService } from './usage-ledger'
import { CardUsageExport } from './card-usage-export'
import { DbConnections } from './db/connections'
import { PgDriver } from './db/pg-driver'
import { ConnectionManager } from './db/connection-manager'
import { DbService } from './db/service'
import { DbAudit } from './db/audit'
import { SecretStore } from './secrets'
import { ApprovalService } from './approvals'
import { PolicyEngine } from './policy'
import { SddResolver } from './sdd/sdd-resolver'
import { SddWriter } from './sdd/sdd-writer'
import { onMainLocaleChange, setMainLocale, tm } from './i18n'
import { CodeIndexService, type HostProcess } from './code-index/service'
import { CodeIndexSettings } from './code-index/project-setting'
import { loadShellPath } from './shell-path'
import { titleBarOverlay } from './title-bar'
import { appMenuTemplate, primaryModifier, titleBarOptions } from './mac'

// Linux and macOS: the PATH of the user's shell (Homebrew, nvm, ~/.npm-global/bin...), so the agent CLIs are found when the app is opened from the menu or the Dock.
loadShellPath()

// Fixed data folder at %APPDATA%\GearMod, independent of the npm package name.
// Separate profile (e.g. GEARMOD_PROFILE=test, used by test.ps1): another data folder and another single-instance lock, to run alongside the stable install.
const profileName = (process.env.GEARMOD_PROFILE ?? '').replace(/[^\w-]/g, '')
app.setName('GearMod')
app.setPath('userData', join(app.getPath('appData'), profileName ? `GearMod-${profileName}` : 'GearMod'))

const appVersion = app.getVersion()
const dataDir = process.env.GEARMOD_DATA_DIR || join(app.getPath('userData'), 'data')
const database = new AppDatabase(join(dataDir, 'gearmod.sqlite'), appVersion)
const backups = new BackupService(dataDir, appVersion)
const git = new GitService()
const profiles = new ProfileRepository(database, homedir())
const agentProbes = new AgentProbeService(profiles)
const projects = new ProjectRepository(database, git)
const board = new BoardRepository(database, projects)
const notes = new NoteRepository(database)
const settings = new SettingsRepository(database, () => app.getLocale())
const conversations = new ConversationRepository(database)
const constitution = new ConstitutionRepository(database)
const checklists = new ChecklistRepository(database)
const worktrees = new WorktreeService(database, dataDir)
// Code index (symbol graph) for the gearmod_code_* tools: runs in a utility process, started on first use.
const codeIndex = new CodeIndexService({ dataDir, fork: () => utilityProcess.fork(join(__dirname, 'codeIndexHost.js'), [], { serviceName: 'GearMod code index', stdio: 'ignore' }) as unknown as HostProcess })
/** Folders the index covers: the card worktree's repositories, otherwise the project sources. Applies to the agents and the editor. */
const projectCodeRoots = ({ projectId, cardId }: { projectId: string; cardId: string | null }): string[] => {
  const worktree = cardId ? worktrees.get(cardId) : null
  if (cardId && worktree && existsSync(worktree.path)) {
    const members = worktrees.repositories(cardId).filter((repo) => repo.status === 'active').map((repo) => repo.path)
    return members.length ? members : [worktree.path]
  }
  const project = projects.get(projectId)
  const sources = [...new Set(project.sources.map((source) => source.localPath))]
  return sources.length ? sources : [project.localPath]
}
const runProject = ({ cardId, chatId }: { cardId: string | null; chatId: string }): string => cardId ? board.card(cardId).projectId : conversations.projectOf(chatId)
const codeRoots = (run: { cardId: string | null; chatId: string }): string[] => projectCodeRoots({ projectId: runProject(run), cardId: run.cardId })
const codeIndexSettings = new CodeIndexSettings(database)
const codeEnabled = (run: { cardId: string | null; chatId: string }): boolean => codeIndexSettings.enabled(runProject(run))
const quality = new QualityService(database, worktrees, (cardId) => pushEvent('gearmod/card-updated', { cardId }))
const pluginDir = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'gearmod-plugin' : 'resources/gearmod-plugin')
const approvals = new ApprovalService(database)
const policy = new PolicyEngine(database)
const gitManager = new GitManager(database, undefined, undefined, approvals, (path) => fileActions.trashItem(path), join(dataDir, 'git-undo'))
gitManager.onFolderRemoved = (path) => { void codeIndex.forget(path).catch(() => undefined) }
const gitAccounts = new GitAccounts(database, new SecretStore(join(dataDir, 'git-accounts.bin'), safeStorage))
const pullRequests = new PullRequestService(database, undefined, undefined, gitAccounts)
const history = new CardHistoryService(database, dataDir)
// The spec.md/plan.md/tasks.md copies in the artifacts folder follow the card documents (checking a task rewrites tasks.md).
board.documents.onWrite = (cardId, kind) => { if (kind === 'especificacao' || kind === 'plano' || kind === 'tasks') refreshArtifactCopies(history, board, cardId) }
const sddResolver = new SddResolver(history, board, projects, worktrees)
const sddWriter = new SddWriter(worktrees)
const playwright = new PlaywrightCliService(database, history, undefined, join(dataDir, 'tools'))
const specTools = new SpecToolsService(database)
const toolUpdates = new ToolUpdateService(join(app.getPath('userData'), 'tool-versions.json'))
const agentContext = new AgentContextService(board, settings, existsSync(pluginDir) ? pluginDir : null, constitution, (cardId) => gitManager.agentRule(cardId), history, (cardId) => {
  // Multi-repository: the agent sees the card's repositories and each one's folder in the worktree; the tester, the Playwright CLI when on.
  const card = board.card(cardId), sources = projects.get(card.projectId).sources.filter((source) => source.isGitRepository)
  const repos = worktrees.repositories(cardId)
  const repositorios = sources.length > 1 ? sources.map((source) => {
    const member = repos.find((repo) => repo.repoPath.toLowerCase() === source.localPath.toLowerCase())
    return { nome: source.name, noCard: card.repoIds ? card.repoIds.includes(source.id) : true, ...(member ? { pasta: member.path, estado: member.status, ...(member.error ? { erro: member.error } : {}) } : {}) }
  }) : undefined
  const playwrightCli = playwright.forCard(cardId)
  // The developer does not read the tester's checklist (that tool is the tester's): the failures of the last test pass travel in the context.
  const falhasDoTeste = failedChecklistItems(checklists.get(cardId).contentMd)
  return { ...(repositorios ? { repositorios, regraRepositorios: 'A worktree do card começa com todos os repositórios. Assim que souber quais o card vai mudar, chame gearmod_set_repositories só com eles: os outros saem da worktree (um repositório com alterações ou commits próprios fica). Se depois precisar de outro, chame de novo incluindo-o.' } : {}), ...(playwrightCli ? { playwrightCli } : {}), ...(falhasDoTeste.length ? { falhasDoTeste, regraFalhasDoTeste: 'Items the tester marked as failed in the last test pass. The developer fixes them when asked, following the documents; the tester verifies them again in the next pass.' } : {}) }
}, sddResolver)
const agentConfigs = new AgentConfigRepository(database, board, profiles, (profileId) => listCodexModels(profiles.get(profileId)))
const usageLedger = new UsageLedgerService(database)
const cardUsageExport = new CardUsageExport(database, board, history, sddResolver, worktrees, sddWriter)
board.setOnDone((cardId) => { void cardUsageExport.export(cardId).catch(() => console.error('Falha ao exportar consumo do card.')) })
const usage = new UsageService(database, profiles, (profile) => probeClaudeLimits(profile), undefined, (profile) => readCodexQuota(profile), usageLedger)
const appIcon = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'tray' : 'resources/tray', 'app.png')
const mcpServerScript = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'gearmod-mcp' : 'resources/gearmod-mcp', 'server.mjs')
const collab = new CollaborationService(database, board, conversations, agentConfigs, (cardId) => { BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('runs:event-pushed', { runId: '', eventType: 'gearmod/card-updated', payload: { cardId, type: 'document' } })); watchWaiting(cardId) }, checklists)
// S05, behind the flag (default off until soak, Q-05): an immediate agent move becomes a pending approval request.
const mcpBridge = new McpBridge({ board, context: agentContext, serverScript: mcpServerScript, testCommand: { repos: (projectId) => quality.repoCommands(projectId), setRepo: (projectId, sourceId, input) => quality.setRepoCommand(projectId, sourceId, input), findRepo: (projectId, ref) => quality.findRepo(projectId, ref), suggest: (cardId) => quality.detectCommand(cardId).command }, collab, conversations, constitution, checklists, git: gitManager, history, approvals, policy, sddResolver, sddWriter, planReady: (cardId) => exportPlanArtifacts(history, board, cardId), prepareWorktree: (cardId) => worktrees.prepare(cardId), trimWorktree: async (cardId, keep) => {
  // The SDD repository never leaves: the card's documents live in it.
  const card = board.card(cardId), sdd = await sddResolver.locate({ projectId: card.projectId, cardId }).then((location) => location.sourceId, () => null)
  return worktrees.trim(cardId, sdd ? [...new Set([...keep, sdd])] : keep)
}, repositories: (cardId) => worktrees.repositories(cardId), agentMoveApproval: process.env.GEARMOD_AGENT_MOVE_APPROVAL === '1', codeIndex, codeRoots, codeEnabled })
const writeback = new AgentWriteback(board, mcpBridge)
const shownNotifications = new Set<Notification>()
const notifier = new Notifier({
  enabled: () => settings.get().notificacoes,
  focused: () => BrowserWindow.getAllWindows().some((window) => window.isFocused()),
  show: (notice, onClick) => {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title: notice.title, body: notice.body, icon: brandIcons?.app ?? appIcon })
    shownNotifications.add(notification)  // keeps the reference until click or close, otherwise the system may discard it
    notification.on('click', () => { shownNotifications.delete(notification); onClick() })
    notification.on('close', () => shownNotifications.delete(notification))
    notification.show()
  },
  open: (target) => {
    const window = mainWindow
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show(); window.focus()
    window.webContents.send('runs:event-pushed', { runId: '', eventType: 'gearmod/open-target', payload: target })
  }
})
const mcpRegistry = new McpRegistry(database, join(dataDir, 'mcp', 'secrets'), safeStorage)
const speckit = new SpecKitRuntime({ history, board: Object.assign(Object.create(board), { documents: board.documents }) as typeof board, worktrees, approvals, root: (projectId) => resolvedSddRoot(history, board, projectId, 'speckit') })
const orchestrator = new AgentOrchestrator(conversations, { codex: new CodexAppServerAdapter(), claude: new ClaudeCliAdapter(), gemini: new GeminiCliAdapter(nodeProcesses) }, (event) => {
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('runs:event-pushed', event))
  watchEvent(event.eventType, event.payload)
  // The count only drops after the run leaves the orchestrator queue, hence the small delay.
  if (event.eventType.startsWith('gearmod/run-')) setTimeout(updateTray, 100)
}, worktrees, () => settings.get().execucoesSimultaneas ?? recommendedConcurrency(), agentContext, writeback, agentConfigs, usage, collab, (info) => {
  if (info.cardId) void cardUsageExport.export(info.cardId).catch(() => console.error('Falha ao exportar consumo do card.'))
  // Run-end event (metrics and implementation/verification reports in the card artifacts folder).
  if (info.cardId && info.purpose !== 'free' && info.purpose !== 'constitution' && info.purpose !== 'conflict' && info.purpose !== 'test-setup') { try { history.runFinished({ cardId: info.cardId, runId: info.runId, chatId: info.chatId, purpose: info.purpose, status: info.status }) } catch { /* artifact is best-effort */ } }
  // System notification when an agent finishes (only with the app out of focus); the click opens the card chat or the free chat.
  const card = info.cardId ? board.card(info.cardId) : null
  const title = card?.title || conversations.listChats(conversations.projectOf(info.chatId)).find((chat) => chat.id === info.chatId)?.title || ''
  const notice = finishNotice({ status: info.status, purpose: info.purpose, title, hasPlan: card?.hasPlan ?? false, pending: card?.pending ?? { changes: 0, questions: 0 }, error: info.error })
  if (notice) notifier.notify(notice, { projectId: card?.projectId ?? conversations.projectOf(info.chatId), cardId: info.cardId, chatId: info.chatId, purpose: info.purpose })
  // Stopped by usage limit: schedules the resume for when the limit comes back.
  void autoResume.onFinished({ ...info, profileId: conversations.context(info.chatId).profile.id }).catch(() => undefined)
}, usageLedger, profiles, speckit, mcpRegistry)
const pushEvent = (eventType: string, payload: Record<string, unknown>): void => { BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('runs:event-pushed', { runId: '', eventType, payload })); watchEvent(eventType, payload) }
setLiveWaitingChats(() => orchestrator.permissions.chats())
/**
 * The agent needs the user (a question, a change or approval to decide, a permission prompt): a system notification when that
 * appears on a card, once per new item (only with the app out of focus, like the others). The click opens the card.
 */
const waitingSeen = new Map<string, number>()
function watchWaiting(cardId: string | null | undefined): void {
  if (!cardId) return
  let card: ReturnType<typeof board.card>
  try { card = board.card(cardId) } catch { return }
  const now = card.waiting ?? 0, before = waitingSeen.get(cardId) ?? 0
  waitingSeen.set(cardId, now)
  if (now > before) notifier.notify({ title: tm().notifier.needsYou, body: card.title.trim() || tm().notifier.newCard }, { projectId: card.projectId, cardId, chatId: null, purpose: null })
}
function watchEvent(eventType: string, payload: Record<string, unknown> | undefined): void {
  if (eventType === 'gearmod/card-updated') { watchWaiting(typeof payload?.cardId === 'string' ? payload.cardId : null); return }
  if (eventType !== 'gearmod/permission-requested' && eventType !== 'gearmod/permission-resolved') return
  try { watchWaiting(conversations.context(String(payload?.chatId ?? '')).cardId) } catch { /* free chat or chat gone */ }
}
/** Build date of the packaged app: when its `app.asar` was written (null in development). */
function aboutBuildDate(): string | null { try { return app.isPackaged ? statSync(join(process.resourcesPath, 'app.asar')).mtime.toISOString() : null } catch { return null } }

// The installer runs apart from the app, which quits right after it starts (the Windows installer cannot replace files in use).
const updates = new UpdateService({
  currentVersion: appVersion, platform: process.platform, repo: 'flucassena/gearmod', downloadDir: join(app.getPath('temp'), 'gearmod-update'),
  emit: (state) => pushEvent('gearmod/app-update', { ...state }),
  appImagePath: process.env.APPIMAGE,
  launch: async (file) => {
    if (process.platform === 'win32') { spawn(file, [], { detached: true, stdio: 'ignore' }).unref(); return }
    const appImage = process.env.APPIMAGE
    if (appImage) {
      // Replacing the file (rename) is safe while it runs; the next start already uses the new one. `execPath` because the running copy lives in a temporary mount.
      const next = `${appImage}.new`
      await copyFile(file, next); await chmod(next, 0o755); await rename(next, appImage)
      app.relaunch({ execPath: appImage }); return
    }
    // Debian package: the system asks for the administrator password (polkit) and apt resolves the dependencies.
    await promisify(execFile)('pkexec', ['apt-get', 'install', '-y', file])
    app.relaunch()
  },
  quit: () => { quitting = true; app.quit() }
})
const storage = new StorageService({ dataDir, toolsDir: join(dataDir, 'tools'), updatesDir: join(app.getPath('temp'), 'gearmod-update') })
const terminals = new TerminalService(pushEvent)
const fileWatch = new FileWatchService(pushEvent)
const autoResume = new AutoResumeService({
  repository: new AutoResumeRepository(database),
  enabled: () => settings.get().retomarSozinho,
  usage: async (profileId) => (await usage.refresh()).find((item) => item.profileId === profileId)?.windows ?? [],
  resume: (item) => {
    if (item.cardId && (item.purpose === 'execution' || item.purpose === 'test')) { executions.resume(item.cardId, item.purpose); return }
    orchestrator.start({ chatId: item.chatId, prompt: 'O limite de uso voltou. Continue de onde parou.', planning: true, notice: tm().autoResume.resumingNotice, automatic: true })
  },
  notify: (chatId, body) => { conversations.addMessage({ chatId, role: 'system', body, status: 'complete' }); pushEvent('gearmod/tool-activity', { chatId }) }
})
const skills = new SkillService(profiles, projects, { adapters: { codex: new CodexAppServerAdapter(), claude: new ClaudeCliAdapter(), gemini: new GeminiCliAdapter(nodeProcesses) }, profile: (id) => profiles.get(id) }, homedir(), (type, payload) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('runs:event-pushed', { runId: '', eventType: type, payload })), usageLedger)
collab.setStarter((action) => { orchestrator.start({ ...action, automatic: true }) })
orchestrator.setHarness(new HarnessService(database, history, worktrees))
/** Groq key encrypted by the system (DPAPI on Windows); it never goes to the database or the backup. */
const groqKeyFile = join(dataDir, 'whisper', 'groq.key')
const voiceSecrets = new SecretStore(groqKeyFile, safeStorage)
const dbConnections = new DbConnections(database, join(dataDir, 'db', 'secrets'), safeStorage)
const dbSessions = new ConnectionManager(dbConnections, new PgDriver())
const dbManager = new DbService(dbConnections, dbSessions, new DbAudit(database, join(dataDir, 'db', 'history')))
const voice = new VoiceService({ dataDir, secrets: voiceSecrets, emit: (type, payload) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('runs:event-pushed', { runId: '', eventType: type, payload })) })
const executions = new ExecutionService(board, conversations, orchestrator, agentConfigs, git, history, speckit)
let disposeIpc: (() => void) | undefined

async function openDatabase(): Promise<void> {
  await database.open(async (db, from, to) => {
    await backups.create(db, `schema-upgrade-${from}-to-${to}`)
  })
  conversations.reconcileInterrupted()
  quality.reconcileInterrupted()
  // Runs deleted from SQLite may still exist in the card's versioned history; the (run_id, seq) key makes recovery idempotent.
  for (const project of projects.list()) for (const card of board.get(project.id).cards) {
    try { usageLedger.importHistory(card.id, history.artifactsDir(card.id)) } catch { /* history on disk is optional */ }
  }
  // Events that did not reach history.jsonl (app closed midway, folder unavailable) are written now.
  try { history.reconcile() } catch { /* tries again on the next open */ }
}

/** Height of the top strip (the same `--titlebar` as the CSS). */
const titleBarHeight = 44

let mainWindow: BrowserWindow | undefined

/** Main window or, with `popout`, an extra window with only one part of the app (chat, Git or board) — all state lives in the main process, so both stay up to date. */
async function createWindow(popout?: { target: PopoutTarget; bounds: Electron.Rectangle }): Promise<BrowserWindow> {
  // The main window opens as it was left (size, position, maximized); the first time, maximized. Popouts keep the bounds they were given.
  const stateFile = join(dataDir, 'window-state.json')
  const saved = popout ? null : readWindowState(stateFile)
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: popout ? 480 : 760,
    minHeight: popout ? 360 : 560,
    ...(saved ? boundsFor(saved, screen.getAllDisplays().map((display) => display.workArea)) : {}),
    ...(popout?.bounds ?? {}),
    show: false,
    backgroundColor: '#0b0b0b',
    // Custom title bar: the app draws the top strip (and it can be dragged); the minimize, maximize and
    // close buttons remain the system's (on the right on Windows/Linux, on the left on the Mac).
    ...titleBarOptions(process.platform, titleBarHeight),
    icon: brandIcons?.app ?? appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  if (!popout) mainWindow = window
  if (lastTaskbarIcon) window.setAppDetails({ appId: 'dev.gearmod.desktop', appIconPath: lastTaskbarIcon, appIconIndex: 0 })
  window.once('ready-to-show', () => { if (!popout && (saved?.maximized ?? true)) window.maximize(); window.show() })
  if (!popout) {
    let timer: NodeJS.Timeout | undefined
    const remember = (): void => { if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return; const { x, y, width, height } = window.getNormalBounds(); writeWindowState(stateFile, { x, y, width, height, maximized: window.isMaximized() }) }
    const later = (): void => { clearTimeout(timer); timer = setTimeout(remember, 500) }
    window.on('resize', later); window.on('move', later); window.on('maximize', later); window.on('unmaximize', later)
    window.on('close', () => { clearTimeout(timer); remember() })  // also when it only hides in the tray
  }
  // Without the menu (File, Edit…) its shortcuts go away; in development, F12 / Ctrl+Shift+I opens the devtools and Ctrl+R reloads.
  if (!app.isPackaged) window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const primary = primaryModifier(process.platform, input)
    if (key === 'f12' || (primary && input.shift && key === 'i')) { event.preventDefault(); window.webContents.toggleDevTools() }
    else if (primary && key === 'r') { event.preventDefault(); window.webContents.reload() }
  })
  // Closing the window only hides the app in the tray: agents keep working. Quit is via the tray icon.
  if (!popout) window.on('close', (event) => {
    if (quitting) return
    event.preventDefault(); window.hide()
    if (!toldHidden && Notification.isSupported()) { toldHidden = true; new Notification({ ...hiddenNotice, icon: brandIcons?.app ?? appIcon }).show() }
  })
  // The editor cancels `beforeunload` when there is an unsaved file; without that Electron would just ignore the close (the chat window's X did
  // nothing and "Quit" hung). Here the user chooses: discard and go on, or cancel — and, if a quit is cancelled, nothing has been closed yet.
  window.webContents.on('will-prevent-unload', (event) => {
    if (!window.isVisible()) window.show()  // when quitting via the tray, the window may be hidden
    window.focus()
    const response = dialog.showMessageBoxSync(window, { type: 'warning', title: tm().app.unsavedTitle, message: tm().app.unsavedMessage, detail: tm().app.unsavedDetail, buttons: [quitting ? tm().app.discardAndQuit : tm().app.discardAndClose, tm().app.cancel], defaultId: 1, cancelId: 1, noLink: true })
    if (response === 0) { event.preventDefault(); return }
    quitting = false  // the quit was cancelled: the main window's X goes back to only hiding in the tray
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  // Only the microphone (voice dictation) is allowed; any other permission stays denied.
  window.webContents.session.setPermissionRequestHandler((_webContents, permission, callback, details) => callback(permission === 'media' && (details as { mediaTypes?: string[] }).mediaTypes?.every((type) => type === 'audio') === true))
  window.webContents.session.setPermissionCheckHandler((_webContents, permission) => permission === 'media')
  const query = popout ? popoutQuery(popout.target) : undefined
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(query ? `${process.env.ELECTRON_RENDERER_URL}?${new URLSearchParams(query)}` : process.env.ELECTRON_RENDERER_URL)
  else await window.loadFile(join(__dirname, '../renderer/index.html'), query ? { query } : undefined)
  return window
}

const areaOf = (window: BrowserWindow): Electron.Rectangle => screen.getDisplayMatching(window.getBounds()).workArea

/** Moves the window to one half of the screen (or releases it, if it was already snapped). */
function placeWindow(window: BrowserWindow, placement: WindowPlacement): void {
  if (window.isMaximized()) window.unmaximize()
  window.setBounds(placementBounds(areaOf(window), placement))
}

/** Opens a window with only that part; when snapping to a half, the source window takes the other. */
function openPopout(target: PopoutTarget, placement: WindowPlacement, point?: { x: number; y: number }): void {
  const origin = BrowserWindow.getFocusedWindow() ?? mainWindow
  const originDisplay = origin ? screen.getDisplayMatching(origin.getBounds()) : screen.getPrimaryDisplay()
  const secondary = placement === 'second' ? screen.getAllDisplays().find((display) => display.id !== originDisplay.id) : undefined
  const area = point ? screen.getDisplayNearestPoint(point).workArea : secondary?.workArea ?? originDisplay.workArea
  const other = oppositePlacement(placement)
  if (origin && other) placeWindow(origin, other)
  const base = placement === 'second' ? placementBounds(area, 'fill') : placementBounds(area, placement)
  const bounds = point && placement === 'new' ? { ...base, x: Math.max(area.x, Math.min(point.x - 72, area.x + area.width - base.width)), y: Math.max(area.y, Math.min(point.y - 28, area.y + area.height - base.height)) } : base
  void createWindow({ target, bounds })
}

function returnFile(input: { projectId: string; cardId: string | null; path: string }): void {
  mainWindow?.webContents.send('runs:event-pushed', { runId: '', eventType: 'gearmod/open-file', payload: input })
  mainWindow?.show(); mainWindow?.focus()
}
const fileActions = {
  attachFile(input: { projectId: string; cardId: string | null; path: string }): void {
    mainWindow?.webContents.send('runs:event-pushed', { runId: '', eventType: 'gearmod/attach-file', payload: input }); mainWindow?.show(); mainWindow?.focus()
  },
  commentFile(input: { projectId: string; cardId: string | null; text: string }): void {
    mainWindow?.webContents.send('runs:event-pushed', { runId: '', eventType: 'gearmod/comment-file', payload: input }); mainWindow?.show(); mainWindow?.focus()
  },
  async openFileExternal(path: string, target: 'explorer' | 'default' | 'vscode'): Promise<void> {
    if (target === 'explorer') { shell.showItemInFolder(path); return }
    if (target === 'vscode') { await shell.openExternal(pathToFileURL(path).href.replace(/^file:\/\//, 'vscode://file')); return }
    const error = await shell.openPath(path); if (error) throw new Error(error)
  },
  /** Delete always goes to the system Recycle Bin, never permanent. */
  async trashItem(path: string): Promise<void> { await shell.trashItem(path) }
}

async function chooseDirectory(defaultPath?: string): Promise<string | null> {
  const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options: OpenDialogOptions = { properties: ['openDirectory'], title: tm().app.selectFolder, ...(defaultPath ? { defaultPath } : {}) }
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : result.filePaths[0] ?? null
}

/** Files to attach to a chat message (they become agent context). */
async function chooseFiles(): Promise<string[]> {
  const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options: OpenDialogOptions = { properties: ['openFile', 'multiSelections'], title: tm().app.attachFiles }
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
}

/** Saves a text (usage CSV) where the user chooses; cancelling writes nothing. */
async function saveTextFile(input: { content: string; defaultName: string }): Promise<{ saved: boolean; path: string | null }> {
  const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options = { title: tm().app.saveFile, defaultPath: input.defaultName, filters: [{ name: 'CSV', extensions: ['csv'] }] }
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { saved: false, path: null }
  await writeFile(result.filePath, input.content, 'utf8')
  return { saved: true, path: result.filePath }
}

async function chooseSkillSource(): Promise<string | null> {
  const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options: OpenDialogOptions = { properties: ['openFile', 'openDirectory'], title: tm().app.chooseSkillSource }
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : result.filePaths[0] ?? null
}

let quitting = false, toldHidden = false, tray: Tray | null = null

function showWindow(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) { void createWindow(); return }
  if (window.isMinimized()) window.restore()
  window.show(); window.focus()
}

/** Real quit (tray menu): with an agent working, confirms first, because runs die along with the app. */
async function requestQuit(): Promise<void> {
  const prompt = quitPrompt(orchestrator.pendingCount())
  if (prompt) {
    const window = BrowserWindow.getAllWindows().find((item) => item.isVisible())
    const options = { type: 'warning' as const, title: tm().app.quitTitle, message: prompt.message, detail: prompt.detail, buttons: [prompt.cancel, prompt.confirm], defaultId: 0, cancelId: 0, noLink: true }
    const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
    if (response !== 1) return
  }
  quitting = true
  app.quit()
}

function updateTray(): void {
  if (!tray || tray.isDestroyed()) return
  const running = orchestrator.pendingCount()
  tray.setToolTip(trayTooltip(running))
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tm().app.trayOpen, click: showWindow },
    { label: running ? tm().background.agentsWorking(running) : tm().app.trayIdle, enabled: false },
    { type: 'separator' },
    { label: tm().app.trayQuit, click: () => void requestQuit() }
  ]))
}

const trayIconPath = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'tray' : 'resources/tray', 'tray.png')
let brandIcons: { color: string; app: Electron.NativeImage; tray: Electron.NativeImage } | null = null

/** Paints the mascot of the window, taskbar and tray icons in the app theme's accent color. */
function setBrandColor(color: string): void {
  if (brandIcons?.color === color) return
  brandIcons = { color, app: tintIcon(nativeImage.createFromPath(appIcon), color), tray: tintIcon(nativeImage.createFromPath(trayIconPath), color) }
  // `win.setIcon` does not exist on the Mac: there the Dock icon is the one that follows the theme.
  if (process.platform === 'darwin') app.dock?.setIcon(brandIcons.app)
  else for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.setIcon(brandIcons.app)
  void applyTaskbarIcon(brandIcons.app)
  if (tray && !tray.isDestroyed()) tray.setImage(menuBarSize(brandIcons.tray))
}

/** The Mac menu bar is 22 points tall and shows a 32 px image at 32 points: there the tray icon is drawn at 18 points. */
function menuBarSize(icon: Electron.NativeImage): Electron.NativeImage {
  return process.platform === 'darwin' && !icon.isEmpty() ? icon.resize({ width: 18, height: 18 }) : icon
}

/**
 * Installed app: the taskbar shows the icon of the shortcut with the same AppUserModelID and ignores `win.setIcon`.
 * Setting the AppUserModelID icon property on each window (a tinted .ico on disk) makes the taskbar follow the theme.
 */
async function applyTaskbarIcon(icon: Electron.NativeImage): Promise<void> {
  if (process.platform !== 'win32' || icon.isEmpty()) return
  try {
    const dir = app.getPath('userData')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `brand-icon-${Date.now()}.ico`)  // new name per change: Windows caches the icon by path
    await writeFile(file, pngToIco(icon))
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.setAppDetails({ appId: 'dev.gearmod.desktop', appIconPath: file, appIconIndex: 0 })
    const previous = lastTaskbarIcon
    lastTaskbarIcon = file
    if (previous) setTimeout(() => { void rm(previous, { force: true }) }, 5000)
  } catch (error) { console.error('Could not set the taskbar icon', error) }
}
let lastTaskbarIcon: string | null = null

function createTray(): void {
  const icon = brandIcons?.tray ?? nativeImage.createFromPath(trayIconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : menuBarSize(icon))
  tray.on('click', showWindow)
  onMainLocaleChange(() => updateTray())
  updateTray()
}

// Single instance: opening GearMod again (with it hidden in the tray) brings the window back instead of opening another app on the same database.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', showWindow)

app.whenReady().then(async () => {
  app.setAppUserModelId('dev.gearmod.desktop')  // required for Windows notifications
  await openDatabase()
  setMainLocale(settings.get().idioma)  // only after opening the database: before that the settings cannot be read
  await mcpBridge.listen()
  disposeIpc = registerIpc(ipcMain, { updates, storage, about: () => readAbout(app.getAppPath(), appVersion, { versions: process.versions, system: `${osVersion()} ${osRelease()} (${process.arch})`, buildDate: aboutBuildDate(), dataDir }), database, speckit, pullRequests, gitAccounts, mcp: mcpRegistry, backups, notes, settings, profiles, projects, board, git, chooseDirectory, chooseFiles, agentProbes, conversations, orchestrator, worktrees, quality, executions, agentConfigs, skills, constitution, checklists, voice, usage, collab, gitManager, history, playwright, specTools, toolUpdates, approvals, sddResolver, sddWriter, dbManager, fileWatch, terminals, returnFile, codeIndex, codeRoots: projectCodeRoots, codeIndexSettings, ...fileActions, openExternal: (url) => shell.openExternal(url), setBrandColor, setTitleBarTheme: (light) => { if (process.platform === 'darwin') return; for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.setTitleBarOverlay(titleBarOverlay(process.platform, light, titleBarHeight)) }, openWindow: openPopout, placeWindow: (placement) => { const window = BrowserWindow.getFocusedWindow(); if (window) placeWindow(window, placement) }, openPath: async (path) => { await mkdir(path, { recursive: true }); const error = await shell.openPath(path); if (error) throw new Error(error) }, chooseSkillSource, saveTextFile, appVersion, dataDir, reopen: openDatabase })
  // No File/Edit/View/Window/Help: the top strip belongs to the app. On the Mac only the app, Edit and Window menus (copy/paste need them).
  const menu = appMenuTemplate(process.platform)
  Menu.setApplicationMenu(menu ? Menu.buildFromTemplate(menu) : null)
  if (app.isPackaged) updates.start()  // the development build does not look for releases
  createTray()
  await createWindow()
  autoResume.start()  // checks every 30 s whether it is time to resume something that stopped because of a usage limit
  app.on('activate', showWindow)
}).catch((error: unknown) => {
  console.error('GearMod startup failed', error)
  // Settings may not have been read (database closed): use the saved language if possible, otherwise the system's.
  try { setMainLocale(settings.get().idioma) } catch { setMainLocale(app.getLocale().toLowerCase().startsWith('pt') ? 'pt-BR' : 'en') }
  const detail = error instanceof Error ? error.message : String(error)
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  const corrupt = /^SQLITE_(CORRUPT|NOTADB)/.test(code) || /integrity check failed|malformed|not a database/i.test(detail)
  dialog.showErrorBox(tm().app.startupFailedTitle, error instanceof SchemaTooNewError ? tm().app.startupSchemaTooNew(dataDir) : corrupt ? tm().app.startupCorrupt(dataDir, detail) : tm().app.startupFailed(dataDir, detail))
  app.exit(1)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
// Any exit (tray, Windows shutdown, update) releases the window close. Nothing is shut down here: a window with an unsaved file
// can still cancel the quit (see `will-prevent-unload`).
app.on('before-quit', () => { quitting = true })
// Only after all windows have closed (nobody cancelled) are agents, terminals, tray and database shut down.
app.on('will-quit', () => { updates.stop(); orchestrator.shutdown(); autoResume.stop(); terminals.dispose(); fileWatch.dispose(); codeIndex.dispose(); tray?.destroy(); disposeIpc?.(); void mcpBridge.close(); void dbSessions.closeAll(); database.close() })
