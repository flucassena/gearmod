import { machineInfo, recommendedConcurrency } from './capacity'
import { homedir } from 'node:os'
import { systemDocumentKinds, ipcContracts, type AppSettings, type AgentConfig, type AgentPurpose, type GitPolicy, type CardDocumentKind, type IpcChannel, type IpcOutput } from '@gearmod/contracts'
import type { PopoutTarget, WindowPlacement } from './windows'
import type { TerminalService } from './terminals'
import type { BackupService } from './backup'
import type { AppDatabase } from './database'
import type { NoteRepository } from './repository'
import type { SettingsRepository } from './settings'
import { setMainLocale } from './i18n'
import type { BoardRepository, GitService, ProfileRepository, ProjectRepository } from './projects'
import type { AgentProbeService } from './agents'
import type { ConversationRepository } from './conversations'
import type { AgentOrchestrator } from './orchestrator'
import type { WorktreeService } from './worktrees'
import type { QualityService } from './quality'
import type { ExecutionService } from './executions'
import type { AgentConfigRepository } from './agent-config'
import type { SkillService } from './skills'
import type { ConstitutionRepository } from './constitution'
import type { ChecklistRepository } from './checklists'
import type { VoiceService } from './voice'
import type { UsageService } from './usage'
import type { CollaborationService } from './collaboration'
import type { GitManager } from './git-manager'
import type { PullRequestService } from './pull-requests'
import type { GitAccounts } from './git-accounts'
import { fileVersions } from './file-versions'
import { grepProject } from './workspace-grep'
import { suggestCommitMessage, suggestCommitMessageCodex } from './adapters'
import { nativeGit } from './worktrees'
import { allowedPath, createProjectItem, listProjectDirectory, readProjectFile, resolveProjectReferences, renameProjectItem, saveMarkdownImage, searchProjectFiles, trashablePath, writeProjectFile } from './file-viewer'
import type { CardHistoryService } from './history'
import type { PlaywrightCliService } from './playwright-cli'
import type { FileWatchService } from './file-watch'
import type { SpecToolsService } from './spec-tools'
import type { ToolUpdateService } from './tool-updates'
import type { ApprovalService } from './approvals'
import { mcpPresets, type McpRegistry } from './mcp-registry'
import { specKitMoveKind, specKitPermissionText, specKitProvider, specKitSpecifyRequest, type SpecKitRuntime } from './speckit'
import { SpecKitImplementBlocked } from './spec-tools'
import type { SddResolver } from './sdd/sdd-resolver'
import type { SddWriter } from './sdd/sdd-writer'
import type { DbService } from './db/service'
import type { DbConnectionInput } from './db/connections'
import type { TableChanges, TableQuery } from './db/sql-builder'
import { GitFileReader } from './sdd/git-file-reader'
import { editorCodeQueries, type EditorCodeIndex } from './code-index/editor'
import { candidate, constitutionMigrationPlan } from './sdd/constitution-migration-plan'
import { cardTypeUsage, defaultCardTypes, setDefaultCardTypes } from './card-types'
import type { CardTypeDef, SpecKitState, DecisionKind, DimensionScores, Effort, PermissionMode, SddConfig, WorkflowConfig, WorkflowKind } from '@gearmod/contracts'

const workflowState = (history: CardHistoryService, projectId: string) => ({ config: history.config(projectId), detected: history.detect(projectId), defaultArtifactsDir: history.defaultArtifactsRoot(projectId) })
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { tm } from './i18n'
import type { UpdateService } from './updater'
import type { StorageService } from './storage'

/** Attachment types the chat may open in the system's app: documents, spreadsheets, text, images. */
const openableAttachment = /^\.(pdf|docx?|dotx?|xlsx?|xlsm|csv|tsv|pptx?|odt|ods|odp|rtf|txt|md|json|jsonl|log|xml|ya?ml|png|jpe?g|gif|webp|bmp|svg|ico)$/i
const imageMime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, input: unknown) => unknown): void
  removeHandler(channel: string): void
}

interface Services {
  database: AppDatabase
  backups: BackupService
  notes: NoteRepository
  settings: SettingsRepository
  profiles: ProfileRepository
  projects: ProjectRepository
  board: BoardRepository
  git: GitService
  chooseDirectory(defaultPath?: string): Promise<string | null>
  chooseFiles(): Promise<string[]>
  agentProbes: AgentProbeService
  conversations: ConversationRepository
  orchestrator: AgentOrchestrator
  worktrees: WorktreeService
  quality: QualityService
  executions: ExecutionService
  agentConfigs: AgentConfigRepository
  skills: SkillService
  constitution: ConstitutionRepository
  checklists: ChecklistRepository
  voice: VoiceService
  usage: UsageService
  collab: CollaborationService
  gitManager: GitManager
  pullRequests: PullRequestService
  gitAccounts: GitAccounts
  history: CardHistoryService
  playwright: PlaywrightCliService
  fileWatch: FileWatchService
  specTools: SpecToolsService
  speckit: SpecKitRuntime
  mcp: McpRegistry
  toolUpdates: ToolUpdateService
  approvals: ApprovalService
  sddResolver: Pick<SddResolver, 'locate' | 'constitution'>
  sddWriter: Pick<SddWriter, 'write'>
  dbManager?: DbService
  /** Code index for the editor (go to symbol, outline, definition, usages) and the folders it covers. */
  codeIndex?: EditorCodeIndex
  codeRoots?(context: { projectId: string; cardId: string | null }): string[]
  codeIndexSettings?: { enabled(projectId: string): boolean; setEnabled(projectId: string, enabled: boolean): void }
  openPath(path: string): Promise<void>
  terminals: TerminalService
  openWindow(target: PopoutTarget, placement: WindowPlacement, point?: { x: number; y: number }): void
  placeWindow(placement: WindowPlacement): void
  returnFile?(input: { projectId: string; cardId: string | null; path: string }): void
  attachFile?(input: { projectId: string; cardId: string | null; path: string }): void
  commentFile?(input: { projectId: string; cardId: string | null; text: string }): void
  openFileExternal?(path: string, target: 'explorer' | 'default' | 'vscode'): Promise<void>
  trashItem?(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  /** Color of the Windows window buttons (minimize, maximize, close): dark on the light theme, light on the dark one. */
  setTitleBarTheme?(light: boolean): void
  /** Color of the mascot in the window, taskbar and tray icons: the accent of the app theme. */
  setBrandColor?(color: string): void
  chooseSkillSource(): Promise<string | null>
  saveTextFile(input: { content: string; defaultName: string }): Promise<{ saved: boolean; path: string | null }>
  appVersion: string
  updates: UpdateService
  storage: StorageService
  about(): Promise<import('@gearmod/contracts').AppAbout>
  dataDir: string
  reopen(): Promise<void>
}

type Handler = (input: never) => unknown | Promise<unknown>

/**
 * Only the app's own renderer (packaged local file or the dev server) may call the channels. Events without `senderFrame` do not come from
 * Electron (tests); with the key present and empty (destroyed frame) or from another origin, it refuses.
 */

/** System message that records the flow choice in the chat: readable text plus the data for the collapsed card. */
function workflowChoiceRecord(data: { cardId: string; projectId: string | null; version: number | null; recommended: { workflow: string; method: string | null }; chosen: { workflow: string; method: string | null } }): string {
  return `${tm().ipc.workflowApprovedNotice}
<!--gearmod:workflow-choice ${JSON.stringify(data)}-->`
}

export function isTrustedSender(event: unknown, devUrl: string | undefined = process.env.ELECTRON_RENDERER_URL): boolean {
  if (!event || typeof event !== 'object' || !('senderFrame' in event)) return true
  const url = (event as { senderFrame?: { url?: string } | null }).senderFrame?.url
  if (typeof url !== 'string') return false
  if (url.startsWith('file://')) return true
  if (!devUrl) return false
  try { return new URL(url).origin === new URL(devUrl).origin } catch { return false }
}

/** Network (UNC) and device paths trigger SMB authentication and leak a hash; the preview only reads local disk. */
export const isLocalAbsolutePath = (path: string): boolean => isAbsolute(path) && !/^[\\/]{2}/.test(path)

export function registerIpc(ipcMain: IpcMainLike, services: Services): () => void {
  const db = (): DbService => { if (!services.dbManager) throw new Error(tm().ipc.dbUnavailable); return services.dbManager }
  const workspaceRoots = ({ projectId, cardId }: { projectId: string; cardId: string | null }): string[] => {
    const project = services.projects.get(projectId)
    if (cardId && services.board.card(cardId).projectId !== projectId) throw new Error(tm().common.cardNotInProject)
    const worktree = cardId ? services.worktrees.get(cardId) : null
    if (worktree && existsSync(worktree.path)) return [...new Set([worktree.path, ...services.worktrees.repositories(cardId!).filter((repo) => repo.status === 'active').map((repo) => repo.path)])]
    return [...new Set([project.localPath, ...project.sources.map((source) => source.localPath)])]
  }
  // workspaceRoots checks that the card belongs to the project before the index opens any folder
  const code = editorCodeQueries(services.codeIndex, (context) => { const roots = workspaceRoots(context); return services.codeRoots?.(context) ?? roots }, services.codeIndexSettings)
  const applyingConstitution = new Set<string>()
  /** Spec Kit state of a card for the chat: chosen permission, pending cards and the REAL artifacts of the card's feature. */
  const specKitState = (cardId: string): SpecKitState => {
    services.speckit.sync(cardId)
    const speckit = services.speckit, card = services.board.card(cardId), availability = speckit.availability(card.projectId), active = speckit.active(cardId)
    const chatProvider = active ? services.conversations.listChats(card.projectId, cardId).find((chat) => chat.purpose === 'planning')?.provider ?? null : null, provider = chatProvider ? specKitProvider(chatProvider) : null
    let artifacts: SpecKitState['artifacts'] = null
    if (active && availability.enabled) { try { artifacts = speckit.artifacts(cardId) } catch { artifacts = null } }
    return { active, enabled: availability.enabled, reason: availability.reason, permission: active ? speckit.permission(cardId) : null, permissionRequestId: active ? speckit.permissionRequest(cardId)?.id ?? null : null, moveRequestId: speckit.moveRequest(cardId)?.id ?? null, startRequestId: speckit.startRequest(cardId)?.id ?? null, provider, texts: provider ? { manual: specKitPermissionText(provider, 'manual'), free: specKitPermissionText(provider, 'free') } : null, artifacts }
  }
  const applyConstitution = async (id: string) => {
    if (applyingConstitution.has(id)) throw new Error(tm().ipc.approvalAlreadyApplying)
    applyingConstitution.add(id)
    try {
      const approval = services.approvals.get(id), payload = approval.payload
      if (approval.kind !== 'constitution-apply' || approval.status !== 'approved' || approval.consumedAt || new Date(approval.expiresAt).getTime() <= Date.now() || !approval.cardId || !approval.projectId) throw new Error(tm().ipc.approvalNotAvailable)
      if (services.board.card(approval.cardId).projectId !== approval.projectId || typeof payload.sourceId !== 'string' || typeof payload.path !== 'string' || typeof payload.content !== 'string' || !(payload.expectBlobSha === null || typeof payload.expectBlobSha === 'string')) throw new Error(tm().ipc.invalidApprovalData)
      const [location, view] = await Promise.all([services.sddResolver.locate({ projectId: approval.projectId, cardId: approval.cardId }), services.sddResolver.constitution({ projectId: approval.projectId, cardId: approval.cardId })])
      if (location.sourceId !== payload.sourceId || view.path !== payload.path) throw new Error(tm().ipc.constitutionLocationChanged)
      await services.sddWriter.write(approval.cardId, payload.sourceId, payload.path, payload.content, { blobSha: payload.expectBlobSha })
      return services.approvals.consume(id, approval.opHash)
    } finally { applyingConstitution.delete(id) }
  }
  const handlers: Record<IpcChannel, Handler> = {
    'db:feature-enabled': () => process.env.GEARMOD_DATABASE_EXPERIMENTAL !== '0',
    'db:connections:list': (input: { projectId: string }) => db().list(input.projectId),
    'db:connections:save': (input: DbConnectionInput) => db().save(input),
    'db:connections:test': async (input: DbConnectionInput) => ({ ok: true as const, ...await db().testConnection(input) }),
    'db:connections:delete': async (input: { connectionId: string }) => { await db().delete(input.connectionId); return {} },
    'db:connect': async (input: { connectionId: string }) => { await db().connect(input.connectionId); return {} },
    'db:session-password': async (input: { connectionId: string; password: string }) => { await db().sessionPassword(input.connectionId, input.password); return {} },
    'db:state': (input: { connectionId: string }) => db().state(input.connectionId),
    'db:disconnect': async (input: { connectionId: string }) => { await db().disconnect(input.connectionId); return {} },
    'db:cancel': async (input: { connectionId: string; requestId: string }) => { await db().cancel(input.connectionId, input.requestId); return {} },
    'db:databases': (input: { connectionId: string }) => db().databases(input.connectionId),
    'db:schemas': (input: { connectionId: string; all?: boolean }) => db().schemas(input.connectionId, input.all),
    'db:tables': (input: { connectionId: string; schemaOid: number }) => db().tables(input.connectionId, input.schemaOid),
    'db:describe': (input: { connectionId: string; oid: number }) => db().describe(input.connectionId, input.oid),
    'db:page': (input: TableQuery & { connectionId: string; requestId: string }) => db().page(input.connectionId, input),
    'db:apply': (input: TableChanges & { connectionId: string; requestId: string; oid: number; dryRun?: boolean }) => db().apply(input.connectionId, input),
    'db:count': (input: TableQuery & { connectionId: string; requestId: string }) => db().count(input.connectionId, input),
    'db:query:run': (input: { connectionId: string; requestId: string; sql: string; limit: number; confirmDestructive?: string }) => db().query(input.connectionId, input),
    'db:history:list': (input: { connectionId: string }) => db().history(input.connectionId),
    'db:history:clear': async (input: { connectionId: string }) => { await db().clearHistory(input.connectionId); return {} },
    'mcp:presets': () => mcpPresets,
    'mcp:list': (input: { projectId?: string }) => services.mcp.list(input.projectId),
    'mcp:save': (input: Parameters<McpRegistry['save']>[0]) => services.mcp.save(input),
    'mcp:detect': (input: { projectId: string }) => services.mcp.detect(input.projectId),
    'mcp:import': (input: Parameters<McpRegistry['importJson']>[0]) => services.mcp.importJson(input),
    'mcp:delete': async (input: { id: string }) => { await services.mcp.remove(input.id); return { deleted: true as const } },
    'mcp:set-project-enabled': (input: { projectId: string; id: string; enabled: boolean }) => { services.mcp.setProjectEnabled(input.projectId, input.id, input.enabled); return { ok: true as const } },
    'speckit:availability': (input: { projectId: string }) => services.speckit.availability(input.projectId),
    'speckit:state': (input: { cardId: string }) => specKitState(input.cardId),
    'speckit:choose': (input: { cardId: string; permission: 'manual' | 'free' }) => {
      const first = !services.speckit.permission(input.cardId)
      services.speckit.choose(input.cardId, input.permission)
      // First choice: the specify step starts on its own, visible in the chat and with the card's understanding and decisions as input.
      if (first) {
        const card = services.board.card(input.cardId), chat = services.conversations.listChats(card.projectId, input.cardId).find((item) => item.purpose === 'planning')
        let hasSpec = false; try { hasSpec = Boolean(services.speckit.artifacts(input.cardId).spec) } catch { /* no worktree yet */ }
        const specProvider = chat ? specKitProvider(chat.provider) : null
        if (chat && specProvider && !chat.busy && !hasSpec) {
          const decisions = services.history.decisions(input.cardId).filter((item) => item.status !== 'superseded')
          services.orchestrator.start({ chatId: chat.id, planning: true, notice: '▶ Usando a skill speckit-specify', prompt: specKitSpecifyRequest(specProvider, card, services.history.discovery(input.cardId), decisions) })
        }
      }
      return specKitState(input.cardId)
    },
    'speckit:request-move': (input: { cardId: string }) => { services.speckit.requestMove(input.cardId); return specKitState(input.cardId) },
    'approvals:list': (input: { cardId?: string }) => services.approvals.list(input.cardId),
    'approvals:decide': async (input: { id: string; approve: boolean; note?: string; choice?: { workflow: 'light' | 'spec' | 'sdd'; method?: 'native' | 'speckit' } }) => {
      const pending = services.approvals.get(input.id)
      // Workflow proposal: the user may pick another flow than the agent's (the proposal stays in the audit; the choice goes in the note).
      const choice = pending.kind === 'workflow-choice' ? input.choice : undefined
      if (choice && choice.workflow === 'sdd' && !choice.method) throw new Error(tm().ipc.chooseSddMethodBeforeApproving)
      if (input.approve && pending.kind === 'constitution-apply' && pending.cardId && pending.projectId) {
        const view = await services.sddResolver.constitution({ projectId: pending.projectId, cardId: pending.cardId })
        if (view.blobSha !== pending.payload.expectBlobSha) throw new Error(tm().ipc.constitutionChanged)
      }
      if (input.approve && !choice && pending.kind === 'workflow-choice' && pending.payload.workflow === 'sdd' && pending.payload.method !== 'native' && pending.payload.method !== 'speckit') throw new Error(tm().ipc.chooseSddMethodBeforeApproving)
      const approval = services.approvals.decide(input.id, input.approve, input.note ?? (choice ? `chosen: ${choice.workflow}${choice.method ? ` (${choice.method})` : ''}` : undefined))
      if (approval.status === 'approved' && approval.kind === 'workflow-choice' && approval.cardId) {
        const workflow = choice?.workflow ?? approval.payload.workflow
        if (workflow === 'light' || workflow === 'spec' || workflow === 'sdd') {
          const method = choice ? choice.method : approval.payload.method === 'native' || approval.payload.method === 'speckit' ? approval.payload.method : undefined
          if (workflow === 'sdd' && !method) throw new Error(tm().ipc.chooseSddMethodBeforeApproving)
          services.history.selectWorkflow(approval.cardId, workflow, { actor: 'user' }, choice && (choice.workflow !== approval.payload.workflow || (choice.method ?? null) !== (approval.payload.method ?? null)) ? '' : typeof approval.payload.reason === 'string' ? approval.payload.reason : '', 'user', method)
          // Older proposals still open for this card are settled by this choice.
          services.approvals.expireOpen('workflow-choice', approval.cardId)
          // The agent stopped waiting for this decision: it continues on its own in the chat that asked (when that chat is idle).
          const chatId = approval.runId ? services.database.db.prepare('SELECT chat_id FROM runs WHERE id = ?').pluck().get(approval.runId) as string | undefined : undefined
          const idle = chatId && !services.database.db.prepare(`SELECT 1 FROM runs WHERE chat_id = ? AND status IN ('queued', 'running') LIMIT 1`).get(chatId)
          // The chat keeps the choice where it was made: the screen shows it as a collapsed flow card (recommended and chosen).
          const record = workflowChoiceRecord({ cardId: approval.cardId, projectId: approval.projectId, version: services.history.latest(approval.cardId)?.version ?? null, recommended: { workflow: String(approval.payload.workflow ?? ''), method: typeof approval.payload.method === 'string' ? approval.payload.method : null }, chosen: { workflow, method: method ?? null } })
          if (chatId && idle) {
            const label = workflow === 'sdd' ? `SDD (${method === 'speckit' ? 'GitHub Spec Kit' : 'GearMod'})` : workflow === 'spec' ? 'Spec' : 'curto'
            try { services.orchestrator.start({ chatId, prompt: tm().ipc.workflowApprovedPrompt(label), planning: true, notice: record, automatic: true }) } catch { /* the user can still continue by writing in the chat */ }
          } else if (chatId) services.conversations.addMessage({ chatId, role: 'system', body: record, status: 'complete' })
        }
      }
      // S05: approving an agent move request applies the move now, still subject to the Done gate (skipGate stays false).
      if (approval.status === 'approved' && approval.kind === 'agent-move' && approval.cardId && typeof approval.payload.columnId === 'string') {
        services.board.move(approval.cardId, approval.payload.columnId, null, 'agent')
      }
      // Spec Kit: the implementation request in planning only touches the card after the user's approval. Deny = cancel.
      if (approval.status === 'approved' && approval.kind === specKitMoveKind && approval.cardId && typeof approval.payload.columnId === 'string') {
        services.board.move(approval.cardId, approval.payload.columnId, null, 'user')
        if (approval.note === 'move-and-implement') services.speckit.requestStart(approval.cardId)
      }
      if (approval.status === 'approved' && approval.kind === 'constitution-apply') return applyConstitution(approval.id)
      return approval
    },
    'approvals:apply-constitution': (input: { id: string }) => applyConstitution(input.id),
    'usage:export': (input: { from?: string; to?: string }) => ({ csv: services.usage.exportCsv(input) }),
    'usage:purge-request': (input: { from?: string; to?: string }) => services.usage.requestPurge(services.approvals, input),
    'usage:purge': (input: { from?: string; to?: string; approvalId: string }) => services.usage.purge(services.approvals, input, input.approvalId),
    'usage:save-csv': (input: { content: string; defaultName: string }) => services.saveTextFile(input),
    'terminal:info': (input: { id: string }) => services.terminals.info(input.id),
    'terminal:resize': (input: { id: string; cols: number; rows: number }) => { services.terminals.resize(input.id, input.cols, input.rows); return {} },
    'workspace:external': async (input: { projectId: string; cardId: string | null; path: string; target: 'explorer' | 'default' | 'vscode' }) => { const path = await allowedPath(workspaceRoots(input), input.path); if (!services.openFileExternal) throw new Error(tm().ipc.externalOpenUnavailable); await services.openFileExternal(path, input.target); return {} },
    'workspace:comment': async (input: { projectId: string; cardId: string | null; text: string }) => { if (!services.commentFile) throw new Error(tm().ipc.chatUnavailable); services.commentFile(input); return {} },
    'workspace:attach': async (input: { projectId: string; cardId: string | null; path: string }) => { const path = await allowedPath(workspaceRoots(input), input.path); if (!statSync(path).isFile()) throw new Error(tm().ipc.chooseFileToAttach); if (!services.attachFile) throw new Error(tm().ipc.chatUnavailable); services.attachFile({ ...input, path }); return {} },
    'workspace:terminal': async (input: { projectId: string; cardId: string | null; path: string }) => { const path = await allowedPath(workspaceRoots(input), input.path), cwd = statSync(path).isDirectory() ? path : dirname(path), id = services.terminals.open(cwd); return { id, cwd, shell: services.terminals.info(id).shell } },
    'workspace:image': async (input: { projectId: string; cardId: string | null; path: string }) => { const path = await allowedPath(workspaceRoots(input), input.path), mime = imageMime[extname(path).toLowerCase()]; if (!mime || statSync(path).size > 20_000_000) throw new Error(tm().ipc.imagePreviewLimit); return `data:${mime};base64,${readFileSync(path).toString('base64')}` },
    'workspace:roots': async (input: { projectId: string; cardId: string | null }) => {
      const worktree = input.cardId ? services.worktrees.get(input.cardId) : null, cards = services.board.get(input.projectId).cards, paths = workspaceRoots(input)
      return Promise.all(paths.map(async (path) => {
        const branch = worktree?.branch ?? await services.git.currentBranch(path)
        const card = input.cardId ? cards.find((item) => item.id === input.cardId) : branch ? cards.find((item) => !item.archivedAt && item.workspace?.branch === branch) : undefined
        const primary = !paths.some((parent) => parent !== path && relative(parent, path) !== '' && !relative(parent, path).startsWith('..') && !isAbsolute(relative(parent, path)))
        return { path, name: basename(path), branch, worktree: Boolean(worktree), primary, cardId: card?.id ?? null, cardTitle: card?.title || null }
      }))
    },
    'workspace:list': (input: { projectId: string; cardId: string | null; path: string }) => listProjectDirectory(workspaceRoots(input), input.path),
    'workspace:watch': async (input: { projectId: string; cardId: string | null; watchId: string; paths: string[] }) => { const roots = workspaceRoots(input), allowed = await Promise.all(input.paths.map((path) => allowedPath(roots, path).catch(() => null))); services.fileWatch.watch(input.watchId, allowed.filter((path): path is string => path !== null)); return {} },
    'workspace:create': (input: { projectId: string; cardId: string | null; parent: string; name: string; kind: 'file' | 'folder' }) => createProjectItem(workspaceRoots(input), input.parent, input.name, input.kind),
    'workspace:rename': (input: { projectId: string; cardId: string | null; path: string; name: string }) => renameProjectItem(workspaceRoots(input), input.path, input.name),
    'workspace:trash': async (input: { projectId: string; cardId: string | null; path: string }) => { const path = await trashablePath(workspaceRoots(input), input.path); if (!services.trashItem) throw new Error(tm().ipc.trashUnavailable); await services.trashItem(path); return {} },
    'workspace:grep': (input: { projectId: string; cardId: string | null; query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean; include?: string | undefined }) => grepProject(workspaceRoots(input), input),
    'workspace:save-image': (input: { projectId: string; cardId: string | null; markdownPath: string; data: string; mime: string }) => saveMarkdownImage(workspaceRoots(input), input.markdownPath, input.data, input.mime),
    'workspace:resolve-references': (input: { projectId: string; cardId: string | null; markdownPath?: string; targets: string[] }) => resolveProjectReferences(workspaceRoots(input), input.targets, input.markdownPath),
    'workspace:search': (input: { projectId: string; cardId: string | null; query: string; fuzzy?: boolean | undefined }) => searchProjectFiles(workspaceRoots(input), input.query, input.fuzzy),
    'workspace:read': (input: { projectId: string; cardId: string | null; path: string }) => readProjectFile(workspaceRoots(input), input.path, true),
    'workspace:versions': (input: { projectId: string; cardId: string | null; path: string }) => fileVersions(workspaceRoots(input), input.path, { git: nativeGit, baseFor: (top) => input.cardId ? services.worktrees.baseFor(input.cardId, top) : Promise.resolve(null) }),
    'workspace:write': (input: { projectId: string; cardId: string | null; path: string; content: string; expected: string }) => writeProjectFile(workspaceRoots(input), input.path, input.content, input.expected),
    'windows:return-file': (input: { projectId: string; cardId: string | null; path: string }) => { workspaceRoots(input); services.returnFile?.(input); return {} },
    'app:about': () => services.about(),
    'storage:list': () => services.storage.list(),
    'storage:remove': (input: { id: string }) => services.storage.remove(input.id),
    'updates:state': () => services.updates.get(),
    'updates:check': () => services.updates.check(),
    'updates:install': () => services.updates.install(),
    'app:info': () => ({ appVersion: services.appVersion, schemaVersion: services.database.schemaVersion(), dataDir: services.dataDir }),
    'notes:list': () => services.notes.list(),
    'notes:create': (input: { body: string }) => services.notes.create(input.body),
    'notes:delete': (input: { id: string }) => ({ deleted: services.notes.delete(input.id) }),
    'backups:list': () => services.backups.list(),
    'backups:create': () => services.backups.create(services.database.db, 'manual'),
    'backups:restore': async (input: { backupId: string }) => {
      // Closing the database under a running agent would corrupt its run and its MCP: wait for them to finish.
      if ((services.database.db.prepare(`SELECT COUNT(*) FROM runs WHERE status IN ('queued', 'running')`).pluck().get() as number) > 0) throw new Error(tm().ipc.restoreAgentsRunning)
      services.database.close()
      await services.backups.restore(input.backupId, services.database.path)
      await services.reopen()
      return { restored: true as const }
    },
    'settings:get': () => services.settings.get(),
    'settings:update': (input: Partial<AppSettings>) => { const updated = services.settings.update(input); setMainLocale(updated.idioma); services.orchestrator.refill(); return updated },
    'profiles:list': () => services.profiles.list(),
    'profiles:create': (input: { provider: 'codex' | 'claude' | 'gemini'; label: string; scope: string; color?: string }) => services.profiles.create(input),
    'profiles:update': (input: { profileId: string; label: string; scope: string; color?: string; billingMode?: 'subscription' | 'api' | 'credits' | 'unknown' }) => services.profiles.update(input),
    'profiles:delete': (input: { profileId: string }) => services.profiles.delete(input.profileId),
    'profiles:removed': () => services.profiles.removed(),
    'profiles:disabled': () => services.profiles.disabled(),
    'profiles:set-enabled': (input: { profileId: string; enabled: boolean }) => services.profiles.setEnabled(input.profileId, input.enabled),
    'profiles:probe': (input: { profileId: string }) => services.agentProbes.probe(input.profileId),
    'profiles:probe-all': () => services.agentProbes.probeAll(),
    'profiles:detect-provider': (input: { provider: 'codex' | 'claude' }) => services.agentProbes.detectProvider(input.provider),
    'profiles:update-provider': (input: { provider: 'codex' | 'claude' }) => services.agentProbes.updateProvider(input.provider),
    'profiles:update-terminal': (input: { provider: 'codex' | 'claude' | 'gemini' }) => ({ id: services.terminals.run(services.agentProbes.updatePlan(input.provider)) }),
    'tools:status': (input: { projectId: string }) => services.specTools.status(input.projectId),
    'tools:probe-spec-kit': (input: { version: string }) => services.specTools.probe(input.version),
    'tools:inspect-folder': (input: { path: string }) => services.specTools.inspectFolder(input.path),
    'tools:run-terminal': (input: Parameters<SpecToolsService['terminalPlan']>[0]) => ({ id: services.terminals.run(services.specTools.terminalPlan(input)) }),
    'tools:cached': () => services.toolUpdates.cached(),
    'tools:latest': (input: { force: boolean }) => services.toolUpdates.latest(input.force),
    'profiles:install-terminal': (input: { provider: 'codex' | 'claude' | 'gemini' }) => ({ id: services.terminals.run(services.agentProbes.installPlan(input.provider)) }),
    'profiles:install-provider': (input: { provider: 'codex' | 'claude' }) => services.agentProbes.installProvider(input.provider),
    'profiles:install': (input: { profileId: string }) => services.agentProbes.install(input.profileId),
    'profiles:login': (input: { profileId: string }) => services.agentProbes.login(input.profileId),
    // Login inside the app: the CLI runs in a terminal the screen shows (reuses `terminal:info/write/resize/kill`).
    'profiles:login-terminal': (input: { profileId: string }) => ({ id: services.terminals.run(services.agentProbes.loginPlan(input.profileId)) }),
    'projects:list': () => services.projects.list(),
    'projects:create': async (input: { name?: string; sourcePaths: string[]; excludePaths?: string[]; baseBranches?: Record<string, string>; profileIds: string[] }) => {
      const probes = await Promise.all(input.profileIds.map((profileId) => services.agentProbes.probe(profileId)))
      if (probes.some((probe) => !probe.installed || !probe.authenticated)) throw new Error(tm().ipc.agentsMustBeConnected)
      return services.projects.create(input)
    },
    'projects:add-repositories': (input: { projectId: string; localPath: string }) => services.projects.addRepositories(input.projectId, input.localPath),
    'projects:remove-repository': (input: { projectId: string; sourceId: string }) => services.projects.removeRepository(input.projectId, input.sourceId),
    'projects:reorder': (input: { projectIds: string[] }) => services.projects.reorder(input.projectIds),
    'projects:delete': (input: { projectId: string }) => ({ deleted: services.projects.delete(input.projectId) }),
    'projects:update': (input: { projectId: string; name: string; icon?: string | null }) => services.projects.update(input),
    'projects:set-source-base': (input: { projectId: string; sourceId: string; branch: string }) => services.projects.setSourceBase(input.projectId, input.sourceId, input.branch),
    'projects:set-base-branch': (input: { projectId: string; sourceId: string; branch: string }) => services.projects.setBaseBranch(input.projectId, input.sourceId, input.branch),
    'cards:set-base-branch': async (input: { cardId: string; branch: string }) => {
      const info = await services.executions.branches(input.cardId)
      if (info.locked) throw new Error(tm().ipc.worktreeAlreadyCreated)
      if (!info.branches.includes(input.branch)) throw new Error(tm().ipc.baseBranchNotFound)
      services.board.setBaseBranch(input.cardId, input.branch)
      return { branch: input.branch }
    },
    'projects:inspect': (input: { localPath: string }) => services.git.inspect(input.localPath),
    'projects:branches': (input: { localPath: string }) => services.git.branches(input.localPath),
    'projects:choose-directory': (input?: { projectId: string }) => services.chooseDirectory(input ? services.projects.get(input.projectId).localPath : undefined),
    'projects:set-profiles': async (input: { projectId: string; profileIds: string[] }) => {
      if (!input.profileIds.length) return services.projects.setProfiles(input.projectId, [])
      const probes = await Promise.all(input.profileIds.map((profileId) => services.agentProbes.probe(profileId)))
      if (probes.some((probe) => !probe.installed || !probe.authenticated)) throw new Error(tm().ipc.agentsMustBeConnected)
      return services.projects.setProfiles(input.projectId, input.profileIds)
    },
    'projects:set-card-types': (input: { projectId: string; types: CardTypeDef[] | null }) => services.projects.setCardTypes(input.projectId, input.types),
    'card-types:get-default': () => defaultCardTypes(services.database.db),
    'card-types:set-default': (input: { types: CardTypeDef[] }) => setDefaultCardTypes(services.database.db, input.types),
    'card-types:usage': (input: { projectId?: string }) => cardTypeUsage(services.database.db, input.projectId),
    'board:get': (input: { projectId: string }) => services.board.get(input.projectId),
    'cards:create': async (input: { projectId: string; columnId: string; sourceId?: string | null; type: string; title: string; description: string; priority: string; acceptanceCriteria: { body: string; checked: boolean }[]; baseBranch?: string; worktree?: { kind: 'card'; cardId: string } | { kind: 'external'; path: string } }) => {
      const { baseBranch, worktree, ...fields } = input
      const card = services.board.create(fields)
      // What the user chose when creating the card.
      try {
        if (baseBranch) services.board.setBaseBranch(card.id, baseBranch)
        if (worktree?.kind === 'card') services.worktrees.link(card.id, worktree.cardId)
        if (worktree?.kind === 'external') await services.worktrees.adopt(card.id, worktree.path)
      } catch (error) { services.board.delete(card.id); throw error }  // no half-made card is left behind when the chosen worktree cannot be used
      return services.board.card(card.id)
    },
    'cards:update': (input: { cardId: string; sourceId?: string | null; type: string; title: string; description: string; priority: string; acceptanceCriteria: { body: string; checked: boolean }[] }) => services.board.update(input),
    'cards:move': (input: { cardId: string; columnId: string; beforeCardId: string | null; skipGate?: boolean }) => services.board.move(input.cardId, input.columnId, input.beforeCardId, 'user', input.skipGate),
    'cards:archive': (input: { cardId: string }) => services.board.archive(input.cardId),
    // Finalize: commit requests still pending are denied (the user is done with the card), then the leftover states are cleared.
    'cards:finalize': async (input: { cardId: string }) => {
      const pending = services.database.db.prepare("SELECT id FROM git_commit_requests WHERE card_id = ? AND status = 'pending'").pluck().all(input.cardId) as string[]
      for (const id of pending) await services.gitManager.decide(id, 'deny')
      return services.board.finalize(input.cardId)
    },
    'cards:restore': (input: { cardId: string }) => services.board.archive(input.cardId, true),
    'cards:get': (input: { cardId: string }) => services.board.card(input.cardId),
    'cards:documents': (input: { cardId: string }) => services.board.documents.get(input.cardId),
    'collab:list': (input: { cardId: string }) => services.collab.list(input.cardId),
    'collab:send-change': (input: { changeId: string }) => services.collab.sendChange(input.changeId),
    'collab:send-test-failures': (input: { cardId: string }) => services.collab.sendTestFailures(input.cardId),
    'collab:decide-change': (input: { changeId: string; decision: 'accept' | 'reject' | 'suggest'; note?: string }) => services.collab.decideChange(input.changeId, input.decision, input.note),
    'collab:answer-question': (input: { questionId: string; answer: string }) => services.collab.answerByUser(input.questionId, input.answer),
    'cards:write-document': (input: { cardId: string; kind: CardDocumentKind; contentMd: string }) => (systemDocumentKinds as readonly string[]).includes(input.kind) ? (() => { throw new Error(tm().ipc.documentGeneratedBySystem) })() : services.board.documents.write(input.cardId, input.kind, input.contentMd, 'user'),
    'cards:document-versions': (input: { cardId: string; kind: CardDocumentKind }) => services.board.documents.versions(input.cardId, input.kind),
    // Spec Kit: the feature's tasks.md is the source; checking in the card writes to it (otherwise the mirror would erase the mark).
    'cards:toggle-task': (input: { cardId: string; line: number; checked: boolean }) => services.speckit.setTask(input.cardId, input.line, input.checked) ? services.board.documents.get(input.cardId).tasks : services.board.documents.setTask(input.cardId, input.line, input.checked, 'user'),
    'cards:start': (input: { cardId: string; config: AgentConfig; purpose?: 'execution' | 'test'; baseBranch?: string; replaceAgent?: boolean }) => { const run = services.executions.start(input.cardId, input.config, input.purpose, input.baseBranch, input.replaceAgent); services.speckit.settleStart(input.cardId); return run },
    'cards:branches': (input: { cardId: string }) => services.executions.branches(input.cardId),
    'agents:options': (input: { profileId: string }) => services.agentConfigs.options(input.profileId),
    'cards:agent-config': (input: { cardId: string }) => services.agentConfigs.get(input.cardId),
    'cards:set-agent-config': (input: { cardId: string; purpose: AgentPurpose; config: AgentConfig }) => { const saved = services.agentConfigs.set(input.cardId, input.purpose, input.config); services.orchestrator.changeMode(input.cardId, input.purpose, input.config); return saved },
    'cards:resume': (input: { cardId: string; purpose?: 'execution' | 'test' }) => services.executions.resume(input.cardId, input.purpose),
    'chats:reset': (input: { chatId: string }) => { services.conversations.resetChat(input.chatId); return { reset: true as const } },
    'chats:delete': (input: { chatId: string }) => { services.conversations.deleteChat(input.chatId); return { deleted: true as const } },
    'cards:mark-viewed': (input: { cardId: string }) => services.board.markViewed(input.cardId),
    // The repository file is the Constitution's source: the tab shows its text (suggestions stay in the database) and editing goes through a card, with approval.
    'constitution:get': async (input: { projectId: string }) => {
      const state = services.constitution.state(input.projectId)
      const view = await services.sddResolver.constitution({ projectId: input.projectId }).catch(() => null)
      let contentMd = view?.content ?? ''
      // The base branch may not have the file (or reading via Git may fail): if the Constitution is in the SDD repository folder, show the one on disk.
      if (!contentMd.trim()) {
        try {
          const config = services.history.config(input.projectId).sdd, location = await services.sddResolver.locate({ projectId: input.projectId })
          contentMd = readFileSync(join(location.repo, config.root, config.constitution[config.method]), 'utf8')
        } catch { /* no file in the folder: stays empty */ }
      }
      return { ...state, constitution: { ...state.constitution, contentMd } }
    },
    'constitution:save': (): never => { throw new Error(tm().ipc.constitutionSaveViaCard) },
    'constitution:import': (input: { projectId: string }) => services.constitution.importSpecKit(input.projectId),
    'constitution:set-proposal': (input: { proposalId: string; status: 'applied' | 'dismissed' }) => services.constitution.state(services.constitution.setProposal(input.proposalId, input.status)),
    // G10: file-first SDD channels (resolver/writer), alongside the old `constitution:*` (SQLite, legacy until G14).
    'sdd:config-get': (input: { projectId: string }) => services.history.config(input.projectId).sdd,
    'sdd:config-set': (input: { projectId: string; config: SddConfig }) => { const current = services.history.config(input.projectId); return services.history.setConfig(input.projectId, { ...current, sdd: input.config }).sdd },
    'sdd:locate': (input: { projectId: string; cardId: string | null }) => services.sddResolver.locate({ projectId: input.projectId, cardId: input.cardId ?? undefined }),
    'sdd:detect-constitutions': async (input: { projectId: string }) => {
      const config = services.history.config(input.projectId).sdd
      const location = await services.sddResolver.locate({ projectId: input.projectId })
      const reader = new GitFileReader(location.repo)
      const path = (file: string): string => [config.root, file].filter(Boolean).join('/').replace(/\\/g, '/')
      const [native, speckit] = await Promise.all([reader.show(location.ref, path(config.constitution.native)), reader.show(location.ref, path(config.constitution.speckit))])
      const db = services.constitution.get(input.projectId).contentMd
      return constitutionMigrationPlan({ db: candidate(db || null), native: candidate(native), speckit: candidate(speckit) }, config.method)
    },
    'constitution:read': (input: { projectId: string; cardId: string | null }) => services.sddResolver.constitution({ projectId: input.projectId, cardId: input.cardId ?? undefined }),
    'constitution:card-details': async (input: { projectId: string; cardId: string }) => {
      if (services.board.card(input.cardId).projectId !== input.projectId) throw new Error(tm().common.cardNotInProject)
      const [view, location] = await Promise.all([services.sddResolver.constitution(input), services.sddResolver.locate(input)])
      const projectLocation = await services.sddResolver.locate({ projectId: input.projectId })
      const baseRef = services.board.baseBranch(input.cardId) || projectLocation.ref
      const baseContent = await new GitFileReader(location.repo).show(baseRef, view.path)
      const ref = location.worktreeBranch || baseRef
      const history = (await nativeGit.run(['-C', location.repo, 'log', '-20', '--format=%h %ad %s', '--date=short', ref, '--', view.path])).stdout
      return { location, view, baseRef, baseContent, history }
    },
    'constitution:write': async (input: { projectId: string; cardId: string; content: string; expectBlobSha: string | null }) => {
      if (services.board.card(input.cardId).projectId !== input.projectId) throw new Error(tm().common.cardNotInProject)
      const location = await services.sddResolver.locate({ projectId: input.projectId, cardId: input.cardId })
      const current = await services.sddResolver.constitution({ projectId: input.projectId, cardId: input.cardId })
      await services.sddWriter.write(input.cardId, location.sourceId, current.path, input.content, { blobSha: input.expectBlobSha })
      return services.sddResolver.constitution({ projectId: input.projectId, cardId: input.cardId })
    },
    'skills:list': (input: { scope: 'global' | 'project'; projectId?: string }) => services.skills.list(input.scope, input.projectId),
    'skills:choose-source': () => services.chooseSkillSource(),
    'skills:choose-folder': () => services.chooseDirectory(),
    'skills:delete': (input: { scope: 'global' | 'project'; projectId?: string; name: string; provider?: 'claude' | 'codex' }) => services.skills.delete(input),
    'skills:import-folder': (input: { scope: 'global' | 'project'; projectId?: string; folderPath: string; provider: 'claude' | 'codex' }) => services.skills.importFolder(input),
    'skills:import': (input: { scope: 'global' | 'project'; projectId?: string; sourcePath: string; name: string; provider: 'claude' | 'codex' }) => services.skills.import(input),
    'skills:convert': (input: { scope: 'global' | 'project'; projectId?: string; name: string; from: 'claude' | 'codex' | 'gemini'; to: 'claude' | 'codex' | 'gemini'; reviewProfileId?: string; model?: string | null }) => services.skills.convert(input),
    'chats:set-skill': async (input: { chatId: string; skill: { name: string; path: string } | null }) => {
      if (input.skill) await services.skills.assertKnown(input.skill, services.conversations.projectOf(input.chatId))
      return services.conversations.setSkill(input.chatId, input.skill)
    },
    'voice:status': () => services.voice.status(services.settings.get().voz),
    'voice:install': () => services.voice.install(services.settings.get().voz),
    'voice:set-key': (input: { key: string }) => services.voice.setGroqKey(input.key, services.settings.get().voz),
    'voice:transcribe': async (input: { wav: Uint8Array; prompt?: string }) => { const settings = services.settings.get(); return { text: await services.voice.transcribe({ wav: input.wav, model: settings.voz, language: settings.idioma === 'en' ? 'en' : 'pt', prompt: input.prompt }) } },
    'usage:list': () => services.usage.list(),
    'usage:history': (input: { granularity: 'day' | 'week' | 'month'; tz: string; groupBy: 'provider' | 'profile' | 'model' | 'project' | 'card' | 'purpose'; from?: string; to?: string }) => services.usage.history(input),
    'code-index:symbols': (input: { projectId: string; cardId: string | null; query: string; limit?: number }) => code.symbols(input),
    'code-index:outline': (input: { projectId: string; cardId: string | null; path: string }) => code.outline(input),
    'code-index:definition': (input: { projectId: string; cardId: string | null; name: string; path?: string }) => code.definition(input),
    'code-index:references': (input: { projectId: string; cardId: string | null; name: string; path?: string }) => code.references(input),
    'code-index:status': (input: { projectId: string; cardId: string | null }) => code.status(input),
    'code-index:set-enabled': (input: { projectId: string; enabled: boolean }) => code.setEnabled(input),
    'code-index:reindex': (input: { projectId: string; root?: string }) => code.reindex(input),
    'files:read': (input: { chatId: string; path: string }) => {
      const context = services.conversations.context(input.chatId), worktree = context.cardId ? services.worktrees.get(context.cardId) : null
      // Card with a worktree: its folder and each of its repositories' (where the agent works), even if the state is out of date.
      // No worktree (planning and free chat, which run read-only): the project folder.
      const roots = worktree && existsSync(worktree.path) ? [...services.worktrees.repositories(context.cardId!).filter((item) => item.status === 'active').map((item) => item.path), worktree.path] : [context.projectPath]
      return readProjectFile(roots, input.path)
    },
    'app:open-link': async (input: { url: string }) => {
      // Only web and email links; no file:, javascript: or local paths.
      if (!/^(https?:\/\/|mailto:)/i.test(input.url) || input.url.length > 2048) throw new Error(tm().ipc.linkNotAllowed)
      await services.openExternal(input.url); return { opened: true as const }
    },
    'app:set-titlebar-theme': (input: { light: boolean }) => { services.setTitleBarTheme?.(input.light); return { ok: true as const } },
    'app:set-brand-color': (input: { color: string }) => { services.setBrandColor?.(input.color); return { ok: true as const } },
    'files:preview': (input: { path: string }) => {
      const mime = imageMime[extname(input.path).toLowerCase()]
      try { return mime && isLocalAbsolutePath(input.path) && statSync(input.path).size < 8_000_000 ? `data:${mime};base64,${readFileSync(input.path).toString('base64')}` : null } catch { return null }
    },
    // Opens an attachment from the chat in the system's default app. Only documents and images that exist: never executables or scripts, which the system would run.
    'files:open': async (input: { path: string }) => {
      if (!isLocalAbsolutePath(input.path) || !openableAttachment.test(extname(input.path))) throw new Error(tm().ipc.fileNotAllowed)
      try { if (!statSync(input.path).isFile()) throw new Error() } catch { throw new Error(tm().ipc.fileNotFound) }
      await services.openPath(input.path); return { opened: true as const }
    },
    // A file pasted from the clipboard (screenshot, copied image) has no path: it goes to the app's attachments folder and the agent reads it from there.
    'files:save-pasted': (input: { name: string; base64: string }) => {
      const dir = join(services.backups.attachmentsDir, 'pasted'); mkdirSync(dir, { recursive: true })
      const safe = basename(input.name).replace(/[^\w. -]/g, '_').slice(-80) || 'arquivo', path = join(dir, `${randomUUID().slice(0, 8)}-${safe}`)
      writeFileSync(path, Buffer.from(input.base64, 'base64')); return path
    },
    'usage:refresh': () => services.usage.refresh(true),
    'cards:usage': (input: { cardId: string }) => services.conversations.cardUsage(input.cardId),
    'cards:checklist': (input: { cardId: string }) => services.checklists.get(input.cardId),
    'cards:checklist-toggle': (input: { cardId: string; line: number; text: string; checked: boolean }) => { const next = services.checklists.toggle(input.cardId, input.line, input.text, input.checked); services.history.sync(input.cardId); return next },
    'cards:delete': async (input: { cardId: string; deleteArtifacts?: boolean }) => {
      const card = services.board.card(input.cardId)
      // D8: the card's worktree and branch do not stay behind. With uncommitted changes the deletion is refused (nothing is silently lost);
      // a branch with commits that are not on another branch stays in Git (`branch -d`).
      const ownsWorktree = services.database.db.prepare(`SELECT 1 FROM worktrees WHERE card_id = ? AND cleanup_state != 'removed'`).get(input.cardId)
      const shared = services.database.db.prepare('SELECT 1 FROM cards WHERE worktree_card_id = ? AND id <> ? LIMIT 1').get(input.cardId, input.cardId)
      if (ownsWorktree && !shared) {
        const info = await services.gitManager.worktreeInfo(card.projectId, input.cardId).catch(() => null)
        // A worktree the user made (adopted) is only let go, so its uncommitted changes are not at risk.
        if (info?.repos.some((repo) => repo.exists && repo.files > 0) && !services.worktrees.isExternal(input.cardId)) throw new Error(tm().ipc.deleteCardUncommitted)
        if (info) await services.gitManager.deleteWorktree(card.projectId, input.cardId, true)
      }
      if (input.deleteArtifacts) {
        const path = resolve(services.history.artifactsDir(input.cardId))
        const others = services.database.db.prepare('SELECT id FROM cards WHERE substr(id, 1, 8) = ? AND id <> ?').pluck().all(input.cardId.slice(0, 8), input.cardId) as string[]
        const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
        if (others.some((id) => samePath(resolve(services.history.artifactsDir(id)), path))) throw new Error(tm().ipc.artifactsSharedCannotDelete)
        if (existsSync(path)) {
          if (!services.trashItem) throw new Error(tm().ipc.artifactsTrashFailed)
          await services.trashItem(path)
        }
      }
      return { deleted: services.board.delete(input.cardId) }
    },
    'cards:set-repos': (input: { cardId: string; sourceIds: string[] | null }) => services.board.setRepos(input.cardId, input.sourceIds),
    'git:create-prs': (input: { cardId: string; draft: boolean; title?: string; body?: string; sourceId?: string }) => services.gitManager.createPullRequests(input.cardId, input),
    'git-accounts:state': (input: { projectId: string }) => services.gitAccounts.state(input.projectId),
    'git-accounts:set': (input: { projectId: string; sourceId?: string; provider: 'github' | 'gitlab'; host: string; token: string }) => services.gitAccounts.set(input),
    'git-accounts:remove': (input: { projectId: string; sourceId?: string; host: string }) => services.gitAccounts.remove(input),
    'prs:list': (input: { sourceId: string }) => services.pullRequests.list(input.sourceId),
    'prs:default-base': (input: { sourceId: string }) => services.pullRequests.defaultBase(input.sourceId),
    'prs:view': (input: { sourceId: string; number: number }) => services.pullRequests.view(input.sourceId, input.number),
    'prs:comment': async (input: { sourceId: string; number: number; body: string }) => { await services.pullRequests.comment(input.sourceId, input.number, input.body); return {} },
    'prs:review': async (input: { sourceId: string; number: number; action: 'approve' | 'request-changes' | 'comment'; body: string }) => { await services.pullRequests.review(input.sourceId, input.number, input.action, input.body); return {} },
    'prs:create': (input: { sourceId: string; head: string; base: string; title: string; body: string; draft: boolean }) => services.pullRequests.create(input.sourceId, input),
    'prs:open': async (input: { sourceId: string; url: string }) => { await services.openExternal(await services.pullRequests.assertUrl(input.sourceId, input.url)); return { opened: true as const } },
    'git:open-pr': async (input: { cardId: string; url: string }) => { await services.openExternal(services.gitManager.prUrlOf(input.cardId, input.url)); return { opened: true as const } },
    'playwright:sources': (input: { projectId: string }) => services.playwright.nodeSources(input.projectId),
    'playwright:versions': () => services.playwright.availableVersions(),
    'playwright:status': (input: { projectId: string }) => services.playwright.status(input.projectId),
    'playwright:install-browser': (input: { projectId: string }) => services.playwright.installBrowser(input),
    'playwright:install': (input: { projectId: string; version: string; browser: boolean; skills: Array<'claude' | 'agents'>; sourceId?: string }) => services.playwright.install(input),
    'playwright:select': (input: { projectId: string; version: string }) => services.playwright.select(input),
    'playwright:remove': (input: { projectId: string; version: string }) => services.playwright.remove(input),
    'history:get': (input: { cardId: string }) => services.history.history(input.cardId),
    'history:contest': (input: { cardId: string; scores: DimensionScores; reason: string }) => { services.history.contest(input.cardId, input.scores, input.reason); return services.history.history(input.cardId) },
    'history:select-workflow': (input: { cardId: string; workflow: WorkflowKind; method?: 'native' | 'speckit'; reason?: string }) => {
      if (input.workflow === 'sdd' && !input.method) throw new Error(tm().ipc.chooseSddMethod)
      services.history.selectWorkflow(input.cardId, input.workflow, { actor: 'user' }, input.reason ?? '', 'user', input.method)
      return services.history.history(input.cardId)
    },
    'history:add-decision': (input: { cardId: string; kind: DecisionKind; statement: string; rationale?: string }) => { services.history.decide(input.cardId, { ...input, actor: 'user' }); return services.history.history(input.cardId) },
    'history:set-decision': (input: { decisionId: string; status: 'approved' | 'superseded' }) => services.history.history(services.history.setDecision(input.decisionId, input.status)),
    'history:rebuild': (input: { cardId: string }) => services.history.rebuild(input.cardId),
    'history:open-folder': async (input: { cardId: string }) => { const path = services.history.artifactsDir(input.cardId); await services.openPath(path); return { path } },
    'git:file-read': async (input: { sourceId: string; cardId: string | null; path: string }) => ({ content: await services.gitManager.readFileText(input.sourceId, input.cardId, input.path) }),
    'git:file-path': async (input: { sourceId: string; cardId: string | null; path: string }) => services.gitManager.filePath(input.sourceId, input.cardId, input.path),
    'git:file-write': async (input: { sourceId: string; cardId: string | null; path: string; content: string }) => { await services.gitManager.writeFileText(input.sourceId, input.cardId, input.path, input.content); return {} },
    'terminal:open': (input: { projectId: string | null; cardId: string | null }) => {
      // Inside the card worktree (where the agent works); with no worktree, in the project folder; outside a project, in the user's folder.
      const worktree = input.cardId ? services.worktrees.get(input.cardId) : null, cwd = worktree && existsSync(worktree.path) ? worktree.path : input.projectId ? services.projects.get(input.projectId).localPath : homedir()
      const id = services.terminals.open(cwd); return { id, cwd, shell: services.terminals.info(id).shell }
    },
    'terminal:write': (input: { id: string; data: string }) => { services.terminals.write(input.id, input.data); return {} },
    'terminal:kill': (input: { id: string }) => { services.terminals.kill(input.id); return {} },
    'windows:open': (input: PopoutTarget & { placement: WindowPlacement; x?: number; y?: number }) => { services.openWindow({ kind: input.kind, projectId: input.projectId, cardId: input.cardId, chatId: input.chatId, terminalId: input.terminalId, purpose: input.purpose, path: input.path, paths: input.paths }, input.placement, input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : undefined); return {} },
    'windows:place': (input: { placement: WindowPlacement }) => { services.placeWindow(input.placement); return {} },
    'metrics:card': (input: { cardId: string }) => services.conversations.runMetrics(input.cardId),
    'workflow:get': (input: { projectId: string }) => workflowState(services.history, input.projectId),
    'workflow:open-path': async (input: { projectId: string; which: 'artifacts' | 'sdd' }) => {
      // Only opens folders the project itself configured (or the default artifacts one), never a path coming from the screen.
      const state = workflowState(services.history, input.projectId), path = input.which === 'sdd' ? state.config.sddPath : state.config.artifactsDir ?? state.defaultArtifactsDir
      if (!path) throw new Error(tm().ipc.folderNotDefined)
      await services.openPath(path); return { path }
    },
    'workflow:set': (input: { projectId: string; config: WorkflowConfig }) => { services.history.setConfig(input.projectId, input.config); return workflowState(services.history, input.projectId) }
    , 'chats:background': (input: { chatId: string }) => services.conversations.backgroundTasks(input.chatId)
    , 'chats:list': (input: { projectId: string; cardId?: string | null }) => services.conversations.listChats(input.projectId, input.cardId)
    , 'chats:create': async (input: { projectId: string; cardId: string | null; purpose: AgentPurpose; profileId: string; skill?: { name: string; path: string } | null }) => { if (input.skill) await services.skills.assertKnown(input.skill, input.projectId); return services.conversations.createChat(input) }
    , 'messages:list': (input: { chatId: string }) => services.conversations.listMessages(input.chatId)
    , 'runs:live': (input: { chatId: string }) => services.conversations.liveRun(input.chatId)
    , 'agents:start': (input: { chatId: string; prompt: string; planning: boolean; attachments?: string[]; choice?: { model?: string | null; effort?: Effort | null; mode?: PermissionMode } }) => {
      try { return services.orchestrator.start(input) } catch (error) {
        // Asked for implementation in Spec Kit planning: the block applies, and the app offers to move the card (user approval).
        if (error instanceof SpecKitImplementBlocked) { const cardId = services.conversations.context(input.chatId).cardId; if (cardId && services.speckit.active(cardId)) services.speckit.requestMove(cardId); throw new Error(error.message) }
        throw error
      }
    }
    , 'files:choose': () => services.chooseFiles()
    , 'agents:permissions': (input: { chatId: string }) => services.orchestrator.permissions.list(input.chatId)
    , 'agents:permission-decide': (input: { runId: string; requestId: string; allow: boolean }) => ({ decided: services.orchestrator.permissions.decide(input.runId, input.requestId, input.allow) })
    , 'agents:cancel': (input: { runId: string }) => ({ cancelled: services.orchestrator.cancel(input.runId) })
    , 'agents:run-now': (input: { runId: string }) => ({ started: services.orchestrator.runNow(input.runId) })
    , 'agents:capacity': () => ({ ...services.orchestrator.capacity(), recommended: recommendedConcurrency(), ...machineInfo() })
    , 'plans:list': (input: { cardId: string }) => services.conversations.listPlans(input.cardId)
    , 'plans:approve': (input: { planId: string }) => services.conversations.approvePlan(input.planId)
    , 'worktrees:get': (input: { cardId: string }) => services.worktrees.get(input.cardId)
    , 'worktrees:prepare': (input: { cardId: string }) => services.worktrees.prepare(input.cardId)
    , 'worktrees:snapshot': (input: { cardId: string }) => services.worktrees.snapshot(input.cardId)
    , 'worktrees:candidates': (input: { cardId: string }) => services.worktrees.candidates(input.cardId)
    , 'worktrees:options': (input: { projectId: string }) => services.worktrees.startOptions(input.projectId)
    // Only a folder that Git lists as a worktree of the project's repositories: never a path that just came from the screen.
    , 'git:external-worktree-open': async (input: { projectId: string; path: string; target: 'folder' | 'vscode' }) => {
      const found = await services.worktrees.findExternal(input.projectId, input.path)
      if (!found || !services.openFileExternal) throw new Error(tm().worktrees.externalGone)
      await services.openFileExternal(found.path, input.target === 'vscode' ? 'vscode' : 'default'); return { opened: true as const }
    }
    , 'worktrees:adopt': async (input: { cardId: string; path: string }) => { await services.worktrees.adopt(input.cardId, input.path); return {} }
    , 'worktrees:link': (input: { cardId: string; fromCardId: string | null }) => { services.worktrees.link(input.cardId, input.fromCardId); return {} }
    , 'tests:run': (input: { cardId: string; executable: string; args: string[] }) => services.quality.runTest(input.cardId, input.executable, input.args)
    , 'tests:run-card': (input: { cardId: string }) => services.quality.runCard(input.cardId)
    , 'tests:plan': async (input: { cardId: string }) => { const plan = await services.quality.plan(input.cardId); return { repos: plan.repos.map(({ path: _path, ...repo }) => repo), fallback: plan.fallback } }
    , 'tests:repo-commands': (input: { projectId: string }) => services.quality.repoCommands(input.projectId)
    , 'tests:set-repo-command': (input: { projectId: string; sourceId: string; command: string; name: string; applicable: boolean }) => services.quality.setRepoCommand(input.projectId, input.sourceId, input)
    , 'tests:detect-command': (input: { cardId: string }) => services.quality.detectCommand(input.cardId)
    , 'tests:command': (input: { projectId: string }) => services.quality.testCommand(input.projectId)
    , 'tests:set-command': (input: { projectId: string; command: string; name?: string }) => services.quality.setTestCommand(input.projectId, input.command, input.name)
    , 'quality:status': (input: { cardId: string }) => services.quality.status(input.cardId)
    , 'reviews:prepare-local': (input: { cardId: string }) => services.quality.prepareLocalReview(input.cardId)
    , 'git:repos': (input: { projectId: string }) => services.gitManager.repos(input.projectId)
    , 'git:worktree-info': (input: { projectId?: string | undefined; cardId: string; sourceId?: string | undefined }) => services.gitManager.worktreeInfo(input.projectId ?? services.gitManager.projectOfCard(input.cardId), input.cardId, input.sourceId)
    , 'git:external-worktree-info': (input: { sourceId: string; path: string }) => services.gitManager.externalWorktreeInfo(input.sourceId, input.path)
    , 'git:external-worktree-delete': (input: { sourceId: string; path: string; deleteBranch: boolean }) => services.gitManager.deleteExternalWorktree(input.sourceId, input.path, input.deleteBranch)
    , 'git:worktree-delete': (input: { projectId?: string | undefined; cardId: string; sourceId?: string | undefined; deleteBranch: boolean; force?: boolean | undefined }) => services.gitManager.deleteWorktree(input.projectId ?? services.gitManager.projectOfCard(input.cardId), input.cardId, input.deleteBranch, input.sourceId, input.force === true)
    , 'git:upstream': (input: { sourceId: string; cardId: string | null }) => services.gitManager.upstream(input.sourceId, input.cardId)
    , 'git:set-upstream': (input: { sourceId: string; cardId: string | null; remote: string; branch: string }) => services.gitManager.setUpstream(input)
    , 'git:detect': (input: { projectId: string }) => services.gitManager.detect(input.projectId)
    , 'git:setup-targets': (input: { projectId: string }) => services.gitManager.setupTargets(input.projectId)
    , 'git:setup': (input: { projectId: string; sourceId: string; mode: 'init' | 'origin'; url?: string }) => services.gitManager.setup(input)
    , 'git:graph': (input: { projectId: string; sourceId: string; cardId?: string | null; limit?: number }) => services.gitManager.graph(input.projectId, input.sourceId, input.limit, input.cardId)
    , 'git:commit-detail': (input: { sourceId: string; hash: string }) => services.gitManager.commitDetail(input.sourceId, input.hash)
    , 'git:changes': (input: { sourceId: string; cardId: string | null }) => services.gitManager.changes(input.sourceId, input.cardId)
    , 'git:commit-diff': (input: { sourceId: string; hash: string; path: string }) => services.gitManager.commitDiff(input.sourceId, input.hash, input.path)
    , 'git:diff': (input: { sourceId: string; cardId: string | null; path: string; staged: boolean }) => services.gitManager.diff(input.sourceId, input.cardId, input.path, input.staged)
    , 'git:stage': (input: { sourceId: string; cardId: string | null; paths: string[]; stage: boolean }) => services.gitManager.stage(input.sourceId, input.cardId, input.paths, input.stage)
    , 'git:discard-unstaged': (input: { sourceId: string; cardId: string | null; paths: string[] }) => services.gitManager.discardUnstaged(input.sourceId, input.cardId, input.paths)
    , 'git:stash-file': (input: { sourceId: string; cardId: string | null; path: string }) => services.gitManager.stashFile(input.sourceId, input.cardId, input.path)
    , 'git:ignore-file': (input: { sourceId: string; cardId: string | null; path: string; kind: 'file' | 'directory' | 'extension' }) => services.gitManager.ignoreFile(input.sourceId, input.cardId, input.path, input.kind)
    , 'git:suggest-message': async (input: { sourceId: string; cardId: string | null; paths?: string[] }) => {
      // A simple model of the first agent available: the card's own agents first, then any Claude (Haiku), then any Codex (its cheapest model).
      // A profile that fails (expired account, missing CLI) does not block the next one.
      const usable = services.profiles.list().filter((item) => item.provider === 'claude' || item.provider === 'codex')
      if (!usable.length) throw new Error(tm().adapters.commitSuggestNoClaude)
      const cardAgents = input.cardId ? services.agentConfigs.get(input.cardId) : null
      const preferred = [cardAgents?.execution, cardAgents?.planning, cardAgents?.test].map((config) => config?.profileId)
      const byProvider = [...usable.filter((item) => item.provider === 'claude'), ...usable.filter((item) => item.provider === 'codex')]
      const ordered = [...new Set([...preferred, ...byProvider.map((item) => item.id)])].map((id) => usable.find((item) => item.id === id)).filter((item): item is typeof usable[number] => Boolean(item))
      const context = await services.gitManager.suggestionContext(input.sourceId, input.cardId, input.paths ?? [])
      let failure: unknown
      for (const profile of ordered) { try { return { message: await (profile.provider === 'codex' ? suggestCommitMessageCodex : suggestCommitMessage)(profile, context) } } catch (error) { failure = error } }
      throw failure
    }
    , 'git:commit': (input: { sourceId: string; cardId: string | null; message: string; description?: string; amend?: boolean; paths?: string[] }) => services.gitManager.commit(input)
    , 'git:rename-commit': (input: { sourceId: string; cardId: string | null; hash: string; message: string }) => services.gitManager.renameCommit(input)
    , 'git:sync': (input: { sourceId: string; cardId: string | null; action: 'fetch' | 'pull' | 'push' | 'stash' | 'pop'; pull?: 'ff' | 'ff-only' | 'rebase'; force?: boolean; branch?: string }) => services.gitManager.sync(input.sourceId, input.cardId, input.action, input.pull, input.force, input.branch)
    , 'git:branch-action': (input: { sourceId: string; cardId?: string | null; action: 'checkout' | 'pull' | 'pull-rebase' | 'push' | 'rebase-onto' | 'merge' | 'create' | 'rename' | 'delete' | 'delete-remote'; name: string; newName?: string; force?: boolean }) => services.gitManager.branchAction(input.sourceId, input)
    , 'git:checkout-remote': (input: { sourceId: string; cardId: string | null; name: string }) => services.gitManager.checkoutRemote(input.sourceId, input.cardId, input.name)
    , 'git:commit-action': (input: { sourceId: string; cardId?: string | null; action: 'checkout' | 'cherry-pick' | 'revert' | 'rebase' | 'reset-soft' | 'reset-mixed' | 'reset-hard' | 'branch' | 'tag'; hash: string; name?: string }) => services.gitManager.commitAction(input.sourceId, input)
    , 'git:stash-action': (input: { sourceId: string; cardId?: string | null; action: 'apply' | 'pop' | 'drop'; ref: string }) => services.gitManager.stashAction(input.sourceId, input)
    , 'git:undo-state': (input: { sourceId: string; cardId?: string | null | undefined }) => services.gitManager.undoState(input.sourceId, input.cardId ?? null)
    , 'git:undo': (input: { sourceId: string; cardId?: string | null | undefined }) => services.gitManager.undoLast(input.sourceId, input.cardId ?? null)
    , 'git:redo': (input: { sourceId: string; cardId?: string | null | undefined }) => services.gitManager.redoLast(input.sourceId, input.cardId ?? null)
    , 'git:stash-detail': (input: { sourceId: string; cardId: string | null; ref: string; commit: string }) => services.gitManager.stashDetail(input.sourceId, input.cardId, input.ref, input.commit)
    , 'git:stash-rename': (input: { sourceId: string; cardId: string | null; ref: string; commit: string; message: string }) => services.gitManager.renameStash(input.sourceId, input.cardId, input.ref, input.commit, input.message)
    , 'git:conflicts': (input: { sourceId: string; cardId?: string | null | undefined }) => services.gitManager.conflicts(input.sourceId, input.cardId)
    , 'git:conflicts-all': (input: { projectId: string }) => services.gitManager.conflictsAll(input.projectId)
    , 'git:file-versions': (input: { sourceId: string; cardId: string | null; path: string; mode: 'unstaged' | 'staged' | 'commit'; hash?: string | undefined }) => services.gitManager.fileVersions(input.sourceId, input.cardId, input.path, input.mode, input.hash)
    , 'git:conflict-ai': async (input: { sourceId: string; cardId?: string | null | undefined; path: string; profileId: string; model?: string | null | undefined; effort?: Effort | null | undefined }) => {
      // Hidden run: a chat of its own (type "conflict", named after the file, listed in Chats) working inside the conflicted folder. The screen reloads the file when it ends.
      const target = await services.gitManager.conflictAiTarget(input.sourceId, input.path, input.cardId)
      const chat = services.conversations.createChat({ projectId: target.projectId, cardId: null, purpose: 'conflict', profileId: input.profileId })
      services.conversations.setTitleIfEmpty(chat.id, `${tm().git.conflictChatTitle}: ${input.path.split('/').pop() ?? input.path}`)
      const prompt = [`Resolve the Git conflict in the file \`${input.path}\` (repository ${target.repo}, ${target.operation ?? 'merge'} in progress). Your working folder is that repository.`,
        'Rules:', '- Open the file and replace every conflict block (<<<<<<<, =======, >>>>>>>) with the correct final code, keeping the intent of BOTH sides. When they truly contradict, prefer the side that is the "incoming" change being applied and say so.',
        '- Edit ONLY this file. Do not run git commands (no add, rebase --continue, commit, checkout), do not touch other files.', '- The file must end with no conflict markers left and must stay syntactically valid.',
        '- When done, answer in 2-4 short lines: what you kept from each side and anything the user should double-check.'].join('\n')
      const run = services.orchestrator.start({ chatId: chat.id, prompt, planning: false, choice: { model: input.model ?? null, effort: input.effort ?? null, mode: 'accept_edits' }, cwd: target.dir })
      return { chatId: chat.id, runId: run.id }
    }
    , 'git:conflict-file': (input: { sourceId: string; cardId?: string | null | undefined; path: string }) => services.gitManager.conflictFile(input.sourceId, input.path, input.cardId)
    , 'git:conflict-save': (input: { sourceId: string; cardId?: string | null | undefined; path: string; content: string }) => services.gitManager.saveConflict(input.sourceId, input.path, input.content, input.cardId)
    , 'git:conflict-resolve': (input: { sourceId: string; cardId?: string | null | undefined; path: string; side: 'ours' | 'theirs' | 'marked' }) => services.gitManager.resolveConflict(input.sourceId, input.path, input.side, input.cardId)
    , 'git:conflict-finish': (input: { sourceId: string; cardId?: string | null | undefined; action: 'continue' | 'abort' }) => services.gitManager.finishConflicts(input.sourceId, input.action, input.cardId)
    , 'git:card': (input: { cardId: string }) => services.gitManager.card(input.cardId)
    , 'git:base-options': (input: { sourceId: string }) => services.gitManager.baseOptions(input.sourceId)
    , 'git:set-base': (input: { cardId: string; sourceId: string; baseRef: string }) => services.gitManager.setBase(input.cardId, input.sourceId, input.baseRef)
    , 'git:policy-get': (input: { projectId: string }) => services.gitManager.policy(input.projectId)
    , 'git:policy-set': (input: { projectId: string; policy: GitPolicy }) => services.gitManager.setPolicy(input.projectId, input.policy)
    , 'git:requests': (input: { cardId: string }) => services.gitManager.requests(input.cardId)
    , 'git:request-decide': (input: { requestId: string; decision: 'allow' | 'deny'; message?: string }) => services.gitManager.decide(input.requestId, input.decision, input.message)
    , 'reviews:approve-local': (input: { reviewId: string }) => services.quality.approveLocal(input.reviewId)
  }
  const channels = Object.keys(ipcContracts) as IpcChannel[]
  for (const channel of channels) {
    ipcMain.handle(channel, async (event, rawInput) => {
      if (!isTrustedSender(event)) throw new Error(tm().ipc.untrustedSender)
      const contract = ipcContracts[channel]
      const input = contract.input.parse(rawInput)
      const output = await handlers[channel](input as never)
      return contract.output.parse(output) as IpcOutput<typeof channel>
    })
  }
  return () => channels.forEach((channel) => ipcMain.removeHandler(channel))
}
