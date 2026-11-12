import { complexitySummary } from './history'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { defaultAgentColor, geminiEnabled, type CardRunState, type AgentProfile, BoardColumn, Card, Project, ProjectBoard, ProjectSource } from '@gearmod/contracts'
import type { AppDatabase } from './database'
import { failedChecklistItems } from './checklists'
import { DocumentRepository } from './documents'
import { countTasks } from './tasks'
import type Database from 'better-sqlite3'
import { tm } from './i18n'
import { projectCardTypes, setProjectCardTypes } from './card-types'

const execFileAsync = promisify(execFile)
/** `env_passthrough` comes from SQLite as JSON; never breaks the listing because of a corrupted value. */
function parseEnvPassthrough(row: Record<string, unknown>): Record<string, unknown> {
  const { envPassthroughRaw, ...rest } = row
  let envPassthrough: string[] = []
  try { const parsed = JSON.parse(String(envPassthroughRaw ?? '[]')); if (Array.isArray(parsed)) envPassthrough = parsed.filter((item): item is string => typeof item === 'string') } catch { /* empty list */ }
  return { ...rest, envPassthrough }
}
const defaultColumns = [
  ['To do', 'todo'], ['Doing', 'doing'], ['Test', 'test'], ['Done', 'done']
] as const

/** Real path (Git hands over the long name, Windows may have stored the short one), lowercase on Windows. */
const pathKey = (path: string): string => { let value = resolve(path); try { value = realpathSync.native(value) } catch { /* the folder may be gone */ } return process.platform === 'win32' ? value.toLowerCase() : value }
const samePath = (a: string, b: string): boolean => pathKey(a) === pathKey(b)

export class GitService {
  /** Branch currently open exactly in this folder; does not confuse a container folder with child repositories. */
  async currentBranch(localPath: string): Promise<string | null> {
    const path = resolve(localPath)
    try {
      const [{ stdout: root }, { stdout: branch }] = await Promise.all([
        execFileAsync('git', ['-C', path, 'rev-parse', '--show-toplevel']),
        execFileAsync('git', ['-C', path, 'branch', '--show-current'])
      ])
      return resolve(root.trim()).toLowerCase() === path.toLowerCase() ? branch.trim() || null : null
    } catch { return null }
  }

  async inspect(localPath: string): Promise<{ localPath: string; name: string; repositories: Array<{ localPath: string; name: string; currentBranch: string; branches: string[]; defaultBranch?: string }> }> {
    const folder = await stat(localPath).catch(() => undefined)
    if (!folder?.isDirectory()) throw new Error(tm().projects.projectFolderMissing)
    const root = resolve(localPath)
    const direct = await this.repository(root)
    if (direct) return { localPath: root, name: basename(root), repositories: [direct] }
    const children = await readdir(root, { withFileTypes: true })
    const repositories = (await Promise.all(children.filter((item) => item.isDirectory() && item.name !== '.git').map((item) => this.repository(resolve(root, item.name))))).filter((item): item is NonNullable<typeof item> => Boolean(item))
    return { localPath: root, name: basename(root), repositories }
  }

  private async repository(localPath: string): Promise<{ localPath: string; name: string; currentBranch: string; branches: string[]; defaultBranch?: string } | null> {
    try {
      const [{ stdout: rootOutput }, { stdout: branchOutput }] = await Promise.all([
        execFileAsync('git', ['-C', localPath, 'rev-parse', '--show-toplevel']),
        execFileAsync('git', ['-C', localPath, 'branch', '--show-current'])
      ])
      const root = resolve(rootOutput.trim())
      const currentBranch = branchOutput.trim()
      if (!currentBranch) return null
      const branches = await this.branches(root)
      return { localPath: root, name: basename(root), currentBranch, branches, defaultBranch: await this.remoteDefault(root, branches) ?? currentBranch }
    } catch { return null }
  }

  /** The remote's default branch (origin/HEAD, as GitHub/GitLab set it), when the repository knows it and has that branch. */
  async remoteDefault(localPath: string, branches?: string[]): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', localPath, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
      const name = stdout.trim().replace(/^origin\//, '')
      return name && (!branches || branches.includes(name)) ? name : null
    } catch { return null }
  }

  async branches(localPath: string): Promise<string[]> {
    const folder = await stat(localPath).catch(() => undefined)
    if (!folder?.isDirectory()) throw new Error(tm().projects.projectFolderMissing)
    try {
      const { stdout } = await execFileAsync('git', ['-C', localPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
      const branches = stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).map((item) => item.replace(/^origin\//, ''))
      return [...new Set(branches)].sort()
    } catch { throw new Error(tm().projects.folderNotGitRepo) }
  }

  async validate(localPath: string, baseBranch: string): Promise<void> {
    const branches = await this.branches(localPath)
    if (!branches.includes(baseBranch)) throw new Error(tm().projects.baseBranchMissing(baseBranch))
  }
}

export class ProfileRepository {
  constructor(private readonly database: AppDatabase, private readonly homeDir: string) {}

  setExecutable(id: string, path: string): void {
    this.database.db.prepare('UPDATE agent_profiles SET executable_path = ? WHERE id = ?').run(path, id)
  }

  accountKey(id: string): string | null {
    const row = this.database.db.prepare('SELECT account_key AS accountKey FROM agent_profiles WHERE id = ?').get(id) as { accountKey: string | null } | undefined
    if (!row) throw new Error(tm().common.profileNotFound)
    return row.accountKey
  }

  setAccountKey(id: string, key: string): void {
    this.database.db.prepare('UPDATE agent_profiles SET account_key = ?, updated_at = ? WHERE id = ? AND account_key IS NULL').run(key, new Date().toISOString(), id)
  }

  /** Billing-mode hint seen in the run itself (e.g. Claude's `apiKeySource`). Only recorded to suggest in the UI; never writes `billing_mode` on its own. */
  recordBillingHint(id: string, hint: string): void {
    this.database.db.prepare('UPDATE agent_profiles SET api_key_source_hint = ? WHERE id = ?').run(hint, id)
  }

  /**
   * S16 (user decision, Q-07): every new profile requires its own login; the app never reuses an already logged-in session of the
   * CLI in the default directory (`~/.codex`, `~/.claude`). The config folder is always isolated per profile; without completing the
   * login (`profiles:login` + authenticated `profiles:probe`), the profile is unusable ("login pending").
   */
  create(input: { provider: 'codex' | 'claude' | 'gemini'; label: string; scope: string; color?: string }): AgentProfile {
    if (input.provider === 'gemini' && !geminiEnabled) throw new Error(tm().projects.geminiDisabled)
    // Antigravity keeps one Google account per OS user: a second profile would only share (and switch) the same login.
    if (input.provider === 'gemini' && this.database.db.prepare("SELECT 1 FROM agent_profiles WHERE provider = 'gemini' AND removed_at IS NULL").get()) throw new Error(tm().projects.antigravityOnlyOne)
    const id = randomUUID()
    const configDir = join(this.homeDir, '.gearmod', 'profiles', id)
    const now = new Date().toISOString()
    this.database.db.prepare(`INSERT INTO agent_profiles
      (id, provider, label, scope, color, config_dir, executable_path, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`).run(id, input.provider, input.label.trim(), input.scope, input.color ?? defaultAgentColor(input.provider), configDir, now, now)
    return this.get(id)
  }

  update(input: { profileId: string; label: string; scope: string; color?: string; billingMode?: AgentProfile['billingMode']; envPassthrough?: string[] }): AgentProfile {
    const current = this.get(input.profileId)
    this.database.db.prepare('UPDATE agent_profiles SET label = ?, scope = ?, color = ?, billing_mode = ?, env_passthrough = ?, updated_at = ? WHERE id = ?')
      .run(input.label.trim(), input.scope.trim(), input.color ?? current.color, input.billingMode ?? current.billingMode, JSON.stringify(input.envPassthrough ?? current.envPassthrough), new Date().toISOString(), input.profileId)
    return this.get(input.profileId)
  }

  /**
   * Removes the agent. With no history, deletes it for good; with conversations, plans or runs, only deactivates it (`archived`): it leaves the lists and
   * the projects and no longer runs, but keeps appearing as "deactivated" on the cards where it worked. With a run in progress, refuses.
   */
  delete(id: string): { deleted: boolean; archived: boolean } {
    this.get(id)
    const running = this.database.db.prepare(`SELECT COALESCE(k.title, '') AS title FROM runs r LEFT JOIN cards k ON k.id = r.card_id WHERE r.profile_id = ? AND r.status IN ('queued', 'running')`).all(id) as Array<{ title: string }>
    if (running.length) throw new Error(tm().projects.agentRunningNow(running.map((item) => `“${item.title || tm().common.freeChat}”`).join(', ')))
    const references = ['plans', 'chats', 'runs'].some((table) => {
      const column = table === 'plans' ? 'agent_profile_id' : 'profile_id'
      return Boolean(this.database.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(id))
    })
    return this.database.db.transaction(() => {
      this.database.db.prepare('DELETE FROM project_agent_profiles WHERE profile_id = ?').run(id)
      this.database.db.prepare('DELETE FROM card_agent_settings WHERE profile_id = ?').run(id)
      if (references) {
        this.database.db.prepare('UPDATE agent_profiles SET enabled = 0, removed_at = ?, updated_at = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), id)
        return { deleted: true, archived: true }
      }
      return { deleted: this.database.db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id).changes > 0, archived: false }
    })()
  }

  /**
   * Turns an agent off or back on. Off it leaves every list and picker (it stays in the history and in the "Disabled" section of
   * the agents screen); its projects and card settings are kept, so turning it on again restores it as it was.
   */
  setEnabled(id: string, enabled: boolean): AgentProfile {
    const row = this.database.db.prepare('SELECT 1 FROM agent_profiles WHERE id = ? AND removed_at IS NULL').get(id)
    if (!row) throw new Error(tm().common.profileNotFound)
    if (!enabled) {
      const running = this.database.db.prepare(`SELECT COALESCE(k.title, '') AS title FROM runs r LEFT JOIN cards k ON k.id = r.card_id WHERE r.profile_id = ? AND r.status IN ('queued', 'running')`).all(id) as Array<{ title: string }>
      if (running.length) throw new Error(tm().projects.agentRunningDisable(running.map((item) => `“${item.title || tm().common.freeChat}”`).join(', ')))
    }
    this.database.db.prepare('UPDATE agent_profiles SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, new Date().toISOString(), id)
    return enabled ? this.get(id) : this.disabled().find((profile) => profile.id === id)!
  }

  /** Agents turned off by the user (not removed). */
  disabled(): AgentProfile[] {
    return this.database.db.prepare(`SELECT id, provider, label, scope, color, config_dir AS configDir,
      executable_path AS executablePath, billing_mode AS billingMode, api_key_source_hint AS apiKeySourceHint, env_passthrough AS envPassthroughRaw FROM agent_profiles WHERE enabled = 0 AND removed_at IS NULL ORDER BY created_at`).all()
      .map((row) => ({ ...parseEnvPassthrough(row as Record<string, unknown>), enabled: false } as AgentProfile))
  }

  /** Removed or turned-off agents that may still have history; only to show who ran. */
  removed(): AgentProfile[] {
    return this.database.db.prepare(`SELECT id, provider, label, scope, color, config_dir AS configDir,
      executable_path AS executablePath, billing_mode AS billingMode, api_key_source_hint AS apiKeySourceHint, env_passthrough AS envPassthroughRaw FROM agent_profiles WHERE removed_at IS NOT NULL OR enabled = 0 ORDER BY created_at`).all()
      .map((row) => ({ ...parseEnvPassthrough(row as Record<string, unknown>), enabled: false } as AgentProfile))
  }

  list(): AgentProfile[] {
    return this.database.db.prepare(`SELECT id, provider, label, scope, color, config_dir AS configDir,
      executable_path AS executablePath, enabled, billing_mode AS billingMode, api_key_source_hint AS apiKeySourceHint, env_passthrough AS envPassthroughRaw FROM agent_profiles WHERE enabled = 1 AND removed_at IS NULL ORDER BY created_at`).all()
      .map((row) => ({ ...parseEnvPassthrough(row as Record<string, unknown>), enabled: Boolean((row as { enabled: number }).enabled) } as AgentProfile))
      .filter((profile) => geminiEnabled || profile.provider !== 'gemini')
  }

  get(id: string): AgentProfile {
    const profile = this.list().find((item) => item.id === id)
    if (!profile) throw new Error(tm().common.profileNotFound)
    return profile
  }
}

/**
 * Run state of the card, derived from the last run: in progress, paused (stopped by the user or interrupted),
 * finished (run completed and not yet seen) or planning.
 */
/** Whether the card's automated tests (the Changes panel command) are running right now: its last test run is still `running`. */
export function cardTestsRunning(db: Database.Database, cardId: string): boolean {
  return db.prepare('SELECT status FROM test_runs WHERE card_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').pluck().get(cardId) === 'running'
}

export function cardRunState(db: Database.Database, cardId: string): CardRunState {
  const row = db.prepare(`SELECT r.id, r.status, r.exit_reason AS exitReason, r.started_at AS startedAt, r.ended_at AS endedAt, r.profile_id AS profileId, ch.purpose, k.viewed_at AS viewedAt, k.finalized_at AS finalizedAt
    FROM runs r JOIN chats ch ON ch.id = r.chat_id JOIN cards k ON k.id = r.card_id WHERE r.card_id = ? ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1`).get(cardId) as
    { id: string; status: string; exitReason: string | null; startedAt: string; endedAt: string | null; profileId: string; purpose: string; viewedAt: string | null; finalizedAt: string | null } | undefined
  const none = { state: 'idle' as const, runId: null, profileId: null, purpose: null }
  if (!row) return none
  const purpose = row.purpose === 'test' ? 'test' as const : row.purpose === 'planning' ? 'planning' as const : 'execution' as const
  const base = { runId: row.id, profileId: row.profileId, purpose }
  const active = row.status === 'queued' || row.status === 'running'
  if (row.purpose === 'planning') return active ? { state: 'planning', ...base } : none
  if (active) return { state: 'running', ...base }
  // Finalized by the user after this run ended: nothing left to continue or to look at.
  if (row.finalizedAt && row.finalizedAt >= (row.endedAt ?? row.startedAt)) return none
  if (row.status === 'completed') return row.endedAt && (!row.viewedAt || row.endedAt > row.viewedAt) ? { state: 'finished', ...base } : none
  // Failed (e.g. the agent has no login/token): not a pause, there is nothing useful to continue; the card asks to pick the agent again.
  if (row.status === 'failed') return { state: 'failed', ...base, error: row.exitReason }
  return { state: 'paused', ...base }
}

/** Chats whose agent is asking permission right now (kept in memory by the orchestrator, set at startup). */
let liveWaitingChats: () => string[] = () => []
export function setLiveWaitingChats(source: () => string[]): void { liveWaitingChats = source }

/** What waits for the user on the card: questions for them, changes and approvals to decide, and agents asking permission right now. */
export function cardWaiting(db: Database.Database, cardId: string): number {
  const count = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n
  const live = liveWaitingChats()
  return count("SELECT COUNT(*) AS n FROM card_questions WHERE card_id = ? AND status = 'user'", cardId)
    + count("SELECT COUNT(*) AS n FROM card_changes WHERE card_id = ? AND status = 'pending'", cardId)
    // A commit approval only counts while its commit request is still pending (a newer request replaces the older one).
    + count(`SELECT COUNT(*) AS n FROM approval_records a WHERE a.card_id = ? AND a.status = 'requested' AND (a.expires_at IS NULL OR a.expires_at > ?)
      AND (a.kind <> 'git-commit' OR EXISTS (SELECT 1 FROM git_commit_requests g WHERE g.approval_id = a.id AND g.status = 'pending'))`, cardId, new Date().toISOString())
    // Agents without the question tool (Antigravity/Gemini) ask with a gearmod-perguntas block in the text: waiting while that message is the chat's last one.
    + count("SELECT COUNT(*) AS n FROM chats c WHERE c.card_id = ? AND (SELECT m.role || m.body FROM chat_messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) LIKE 'assistant%```gearmod-perguntas%'", cardId)
    + (live.length ? count(`SELECT COUNT(*) AS n FROM chats WHERE card_id = ? AND id IN (${live.map(() => '?').join(',')})`, cardId, ...live) : 0)
}

export class ProjectRepository {
  constructor(private readonly database: AppDatabase, private readonly git: Pick<GitService, 'inspect' | 'validate'>) {}

  list(): Project[] {
    const rows = this.database.db.prepare(`SELECT id, name, icon, local_path AS localPath, base_branch AS baseBranch,
      remote_provider AS remoteProvider, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY sort_order IS NULL, sort_order, updated_at DESC`).all() as Omit<Project, 'allowedProfileIds' | 'sources' | 'activity' | 'cardTypes' | 'customCardTypes'>[]
    const allowed = this.database.db.prepare('SELECT profile_id AS profileId FROM project_agent_profiles WHERE project_id = ? AND allowed = 1')
    const sources = this.database.db.prepare(`SELECT id, project_id AS projectId, name, local_path AS localPath,
      is_git_repository AS isGitRepository, current_branch AS currentBranch, NULLIF(base_branch, '') AS baseBranch, sort_order AS sortOrder FROM project_sources WHERE project_id = ? ORDER BY sort_order`)
    // Sidebar: chats with an agent working (any step, including free chat and Constitution) and cards whose last run
    // (implementation or test) finished after the last time the user opened the card; "finished" follows `cardRunState`, the same rule as the hover list.
    // Automated tests running count too, one per card (they run without a chat).
    const running = this.database.db.prepare(`SELECT (SELECT COUNT(DISTINCT r.chat_id) FROM runs r JOIN chats c ON c.id = r.chat_id WHERE c.project_id = ? AND r.status IN ('queued', 'running'))
      + (SELECT COUNT(*) FROM cards k WHERE k.project_id = ? AND k.archived_at IS NULL AND (SELECT t.status FROM test_runs t WHERE t.card_id = k.id ORDER BY t.started_at DESC, t.rowid DESC LIMIT 1) = 'running') AS n`)
    const cards = this.database.db.prepare('SELECT id, title FROM cards WHERE project_id = ? AND archived_at IS NULL ORDER BY updated_at DESC')
    const order = { waiting: 0, failed: 1, finished: 2, running: 3 } as const
    // Card by card, what is there for the user (the project's hover menu); a card shows once, with what matters most.
    const alerts = (projectId: string): Array<{ cardId: string; title: string; kind: keyof typeof order }> => (cards.all(projectId) as Array<{ id: string; title: string }>).flatMap((card) => {
      const state = cardRunState(this.database.db, card.id).state
      const kind = cardWaiting(this.database.db, card.id) > 0 ? 'waiting' as const : state === 'failed' ? 'failed' as const : state === 'finished' ? 'finished' as const : state === 'running' || state === 'planning' || cardTestsRunning(this.database.db, card.id) ? 'running' as const : null
      return kind ? [{ cardId: card.id, title: card.title, kind }] : []
    }).sort((a, b) => order[a.kind] - order[b.kind])
    return rows.map((row) => { const types = projectCardTypes(this.database.db, row.id), everything = alerts(row.id), list = everything.slice(0, 20); return { ...row,
      cardTypes: types.types, customCardTypes: types.custom,
      activity: { running: (running.get(row.id, row.id) as { n: number }).n, finished: everything.filter((item) => item.kind === 'finished').length, waiting: list.filter((item) => item.kind === 'waiting').length, alerts: list },
      allowedProfileIds: (allowed.all(row.id) as { profileId: string }[]).map((item) => item.profileId),
      sources: (sources.all(row.id) as Array<Omit<ProjectSource, 'isGitRepository'> & { isGitRepository: number }>).map((item) => ({ ...item, isGitRepository: Boolean(item.isGitRepository) }))
    } })
  }

  /** The project's own list of card types; `null` goes back to following the default list. */
  setCardTypes(projectId: string, types: Project['cardTypes'] | null): Project {
    this.get(projectId)
    setProjectCardTypes(this.database.db, projectId, types)
    return this.get(projectId)
  }

  get(id: string): Project {
    const project = this.list().find((item) => item.id === id)
    if (!project) throw new Error(tm().common.projectNotFound)
    return project
  }

  async create(input: { name?: string; sourcePaths?: string[]; excludePaths?: string[]; baseBranches?: Record<string, string>; profileIds?: string[]; localPath?: string; baseBranch?: string; icon?: string | null }): Promise<Project> {
    const paths = input.sourcePaths ?? (input.localPath ? [input.localPath] : [])
    if (!paths.length) throw new Error(tm().projects.addAtLeastOneFolder)
    const inspections = await Promise.all(paths.map((path) => this.git.inspect(path)))
    const first = inspections[0]!
    type DiscoveredSource = { localPath: string; name: string; currentBranch: string | null; branches: string[]; defaultBranch?: string; isGitRepository: boolean }
    const discovered: DiscoveredSource[] = inspections.flatMap<DiscoveredSource>((inspection) => inspection.repositories.length ? inspection.repositories.map((repository) => ({ ...repository, isGitRepository: true })) : [{ localPath: inspection.localPath, name: inspection.name, currentBranch: null, branches: [], isGitRepository: false }])
    // Repositories the user took out in the dialog: they are not registered and, being remembered, the project folder scan does not bring them back.
    const excludePaths = input.excludePaths ?? []
    const unique = [...new Map(discovered.map((source) => [source.localPath.toLocaleLowerCase(), source])).values()].filter((source) => !excludePaths.some((path) => samePath(path, source.localPath)))
    if (!unique.length) throw new Error(tm().projects.addAtLeastOneFolder)
    const name = input.name?.trim() || first.name
    const baseBranch = input.baseBranch || unique.find((source) => source.isGitRepository)?.currentBranch || ''
    // Base branch of each repository: the one chosen in the dialog (when it exists there), else the remote's default branch, else the current one.
    const chosenBase = (source: DiscoveredSource): string | null => {
      const picked = Object.entries(input.baseBranches ?? {}).find(([path]) => samePath(path, source.localPath))?.[1]
      return (picked && source.branches.includes(picked) ? picked : null) ?? source.defaultBranch ?? source.currentBranch
    }
    const selectedProfiles = input.profileIds ?? []
    const now = new Date().toISOString(), id = randomUUID()
    const create = this.database.db.transaction(() => {
      this.database.db.prepare(`INSERT INTO projects(id, name, local_path, base_branch, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, name, first.localPath, baseBranch, now, now)
      if (input.icon) this.database.db.prepare('UPDATE projects SET icon = ? WHERE id = ?').run(input.icon, id)
      // A new project goes to the top of the sidebar.
      this.database.db.prepare('UPDATE projects SET sort_order = (SELECT COALESCE(MIN(sort_order), 0) - 1 FROM projects WHERE id <> ?) WHERE id = ?').run(id, id)
      const insertSource = this.database.db.prepare(`INSERT INTO project_sources(id, project_id, name, local_path, is_git_repository, current_branch, base_branch, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      unique.forEach((source, index) => insertSource.run(randomUUID(), id, source.name, source.localPath, source.isGitRepository ? 1 : 0, source.currentBranch, source.isGitRepository ? chosenBase(source) : null, index))
      for (const path of excludePaths) if (discovered.some((source) => samePath(source.localPath, path))) this.database.db.prepare('INSERT OR IGNORE INTO project_excluded_repos(project_id, local_path) VALUES (?, ?)').run(id, path)
      const insertColumn = this.database.db.prepare(`INSERT INTO board_columns(id, project_id, label, sort_order, semantic_state, is_default)
        VALUES (?, ?, ?, ?, ?, 1)`)
      defaultColumns.forEach(([label, state], index) => insertColumn.run(randomUUID(), id, label, index, state))
      const allow = this.database.db.prepare('INSERT INTO project_agent_profiles(project_id, profile_id, allowed) VALUES (?, ?, 1)')
      selectedProfiles.forEach((profileId) => allow.run(id, profileId))
    })
    create()
    return this.get(id)
  }

  /**
   * Adds the repositories found in a folder (the folder itself or its direct children) to an existing project. Repositories the project already has are
   * skipped; one the user had taken out comes back (the exclusion is lifted).
   */
  async addRepositories(projectId: string, localPath: string): Promise<Project> {
    const project = this.get(projectId)
    const inspection = await this.git.inspect(localPath)
    if (!inspection.repositories.length) throw new Error(tm().projects.noRepositoriesInFolder)
    const fresh = inspection.repositories.filter((repository) => !project.sources.some((source) => samePath(source.localPath, repository.localPath)))
    if (!fresh.length) throw new Error(tm().projects.repositoriesAlreadyInProject)
    this.database.db.transaction(() => {
      let order = (this.database.db.prepare('SELECT COALESCE(MAX(sort_order), -1) FROM project_sources WHERE project_id = ?').pluck().get(projectId) as number) + 1
      const insert = this.database.db.prepare(`INSERT INTO project_sources(id, project_id, name, local_path, is_git_repository, current_branch, base_branch, sort_order) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`)
      const lift = this.database.db.prepare('DELETE FROM project_excluded_repos WHERE project_id = ? AND local_path = ?')
      const excluded = this.database.db.prepare('SELECT local_path FROM project_excluded_repos WHERE project_id = ?').pluck().all(projectId) as string[]
      for (const repository of fresh) {
        insert.run(randomUUID(), projectId, repository.name, repository.localPath, repository.currentBranch, repository.defaultBranch, order++)
        for (const path of excluded) if (samePath(path, repository.localPath)) lift.run(projectId, path)
      }
      this.database.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), projectId)
    })()
    return this.get(projectId)
  }

  /**
   * Takes a repository out of the project. The folder on disk is never touched. It is remembered as excluded, because the Git tab looks for repositories
   * inside the project folder and would otherwise bring it back. Refused for the last repository and while a card still has a worktree in it.
   */
  removeRepository(projectId: string, sourceId: string): Project {
    const project = this.get(projectId)
    const source = project.sources.find((item) => item.id === sourceId)
    if (!source) throw new Error(tm().projects.sourceNotInProject)
    if (project.sources.length <= 1) throw new Error(tm().projects.cannotRemoveLastRepository)
    const using = (this.database.db.prepare(`SELECT c.title AS title, m.repo_path AS repoPath FROM worktree_members m JOIN worktrees w ON w.id = m.worktree_id JOIN cards c ON c.id = w.card_id
      WHERE c.project_id = ? AND w.cleanup_state != 'removed'`).all(projectId) as Array<{ title: string; repoPath: string }>).find((row) => samePath(row.repoPath, source.localPath))
    if (using) throw new Error(tm().projects.repositoryInUse(source.name, using.title || tm().common.untitled))
    this.database.db.transaction(() => {
      this.database.db.prepare('INSERT OR IGNORE INTO project_excluded_repos(project_id, local_path) VALUES (?, ?)').run(projectId, source.localPath)
      // Cards that pointed at it go back to the project's default repository (null), and it leaves the repositories chosen on a card.
      this.database.db.prepare('UPDATE cards SET source_id = NULL WHERE project_id = ? AND source_id = ?').run(projectId, sourceId)
      const withRepos = this.database.db.prepare('SELECT id, repo_ids AS repoIds FROM cards WHERE project_id = ? AND repo_ids IS NOT NULL').all(projectId) as Array<{ id: string; repoIds: string }>
      const save = this.database.db.prepare('UPDATE cards SET repo_ids = ? WHERE id = ?')
      for (const card of withRepos) {
        let ids: unknown
        try { ids = JSON.parse(card.repoIds) } catch { continue }
        if (Array.isArray(ids) && ids.includes(sourceId)) save.run(JSON.stringify(ids.filter((item) => item !== sourceId)), card.id)
      }
      this.database.db.prepare('DELETE FROM project_sources WHERE id = ?').run(sourceId)
      this.database.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), projectId)
    })()
    return this.get(projectId)
  }

  /** `icon`: `undefined` keeps the current one; `null` removes it. */
  async update(input: { projectId: string; name: string; icon?: string | null }): Promise<Project> {
    const result = input.icon === undefined
      ? this.database.db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(input.name, new Date().toISOString(), input.projectId)
      : this.database.db.prepare('UPDATE projects SET name = ?, icon = ?, updated_at = ? WHERE id = ?').run(input.name, input.icon, new Date().toISOString(), input.projectId)
    if (!result.changes) throw new Error(tm().common.projectNotFound)
    return this.get(input.projectId)
  }

  /** Base branch of one repository: where new card worktrees start from (always its latest version). */
  async setSourceBase(projectId: string, sourceId: string, branch: string): Promise<Project> {
    const source = this.get(projectId).sources.find((item) => item.id === sourceId && item.isGitRepository)
    if (!source) throw new Error(tm().projects.gitRepoNotInProject)
    await this.git.validate(source.localPath, branch)
    this.database.db.prepare('UPDATE project_sources SET base_branch = ? WHERE id = ?').run(branch, sourceId)
    this.database.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), projectId)
    return this.get(projectId)
  }

  async setBaseBranch(projectId: string, sourceId: string, branch: string): Promise<Project> {
    const source = this.get(projectId).sources.find((item) => item.id === sourceId && item.isGitRepository)
    if (!source) throw new Error(tm().projects.gitRepoNotInProject)
    await this.git.validate(source.localPath, branch)
    this.database.db.prepare('UPDATE projects SET base_branch = ?, updated_at = ? WHERE id = ?').run(branch, new Date().toISOString(), projectId)
    // The SDD repository's base branch is also its base in the Git tab.
    this.database.db.prepare('UPDATE project_sources SET base_branch = ? WHERE id = ?').run(branch, sourceId)
    return this.get(projectId)
  }

  /** New sidebar order (the ids in the order they appear). Ids that are not sent stay after, in the order they already had. */
  reorder(projectIds: string[]): Project[] {
    const set = this.database.db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?')
    this.database.db.transaction(() => {
      const rest = this.list().map((project) => project.id).filter((id) => !projectIds.includes(id))
      ;[...projectIds, ...rest].forEach((id, index) => set.run(index, id))
    })()
    return this.list()
  }

  /** Removes the project from GearMod (cards, chats, documents and history). The folders and repositories on disk are not touched. */
  delete(projectId: string): boolean {
    this.get(projectId)
    const busy = this.database.db.prepare(`SELECT 1 FROM runs r JOIN chats c ON c.id = r.chat_id WHERE c.project_id = ? AND r.status IN ('queued', 'running') LIMIT 1`).get(projectId)
    if (busy) throw new Error(tm().projects.agentWorkingInProject)
    // `runs.chat_id` and `test_runs.run_id` do not delete in cascade: the run history of the project's chats goes first, before the rest.
    const runs = `SELECT r.id FROM runs r JOIN chats c ON c.id = r.chat_id WHERE c.project_id = ?`
    return this.database.db.transaction(() => {
      this.database.db.prepare(`DELETE FROM test_runs WHERE run_id IN (${runs})`).run(projectId)
      this.database.db.prepare(`DELETE FROM runs WHERE id IN (${runs})`).run(projectId)
      return this.database.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId).changes > 0
    })()
  }

  setProfiles(projectId: string, profileIds: string[]): Project {
    this.get(projectId)
    const known = new Set((this.database.db.prepare('SELECT id FROM agent_profiles WHERE enabled = 1').all() as { id: string }[]).map((item) => item.id))
    if (profileIds.some((id) => !known.has(id))) throw new Error(tm().projects.unknownOrDisabledProfile)
    const update = this.database.db.transaction(() => {
      this.database.db.prepare('DELETE FROM project_agent_profiles WHERE project_id = ?').run(projectId)
      const insert = this.database.db.prepare('INSERT INTO project_agent_profiles(project_id, profile_id, allowed) VALUES (?, ?, 1)')
      profileIds.forEach((id) => insert.run(projectId, id))
      this.database.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), projectId)
    })
    update()
    return this.get(projectId)
  }
}

/** Within each column the cards are ordered by priority (urgent first) and, at the same priority, by manual order. */
const priorityRank = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`

export class BoardRepository {
  private onDone?: (cardId: string) => void
  setOnDone(callback: (cardId: string) => void): void { this.onDone = callback }
  readonly documents: DocumentRepository

  constructor(private readonly database: AppDatabase, private readonly projects: ProjectRepository) { this.documents = new DocumentRepository(database) }

  get(projectId: string): ProjectBoard {
    const columns = (this.database.db.prepare(`SELECT id, project_id AS projectId, label, sort_order AS sortOrder,
      semantic_state AS semanticState, is_default AS isDefault FROM board_columns WHERE project_id = ? AND semantic_state <> 'mr' ORDER BY sort_order`).all(projectId) as Array<Omit<BoardColumn, 'isDefault'> & { isDefault: number }>)
      .map((item) => ({ ...item, isDefault: Boolean(item.isDefault) }))
    const rows = this.database.db.prepare(`SELECT id FROM cards WHERE project_id = ? ORDER BY ${priorityRank}, order_key`).all(projectId) as { id: string }[]
    return { project: this.projects.get(projectId), columns, cards: rows.map((row) => this.card(row.id)) }
  }

  card(cardId: string): Card {
    const row = this.database.db.prepare(`SELECT id, project_id AS projectId, column_id AS columnId, source_id AS sourceId, type, title, description,
      priority, order_key AS orderKey, created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt
      , workflow FROM cards WHERE id = ?`).get(cardId) as Omit<Card, 'acceptanceCriteria' | 'tasks' | 'run' | 'hasPlan' | 'planningOpen' | 'workspace' | 'pending' | 'execProfileId' | 'execModel' | 'sddMethod'> | undefined
    if (!row) throw new Error(tm().common.cardNotFound)
    const criteria = (this.database.db.prepare(`SELECT id, card_id AS cardId, body, checked, sort_order AS sortOrder
      FROM card_acceptance_criteria WHERE card_id = ? ORDER BY sort_order`).all(cardId) as Array<{ id: string; cardId: string; body: string; checked: number; sortOrder: number }>)
      .map((item) => ({ ...item, checked: Boolean(item.checked) }))
    const tasks = countTasks(this.documents.read(cardId, 'tasks')), run = cardRunState(this.database.db, cardId), hasPlan = Boolean(this.database.db.prepare('SELECT plan_ready_at FROM cards WHERE id = ?').pluck().get(cardId)) || (row.workflow === 'light' && Boolean(row.description.trim())) // short flow has no plan: describing what to do is enough
    // Open planning: planning has started (card without a title or with a planning chat) and nothing has come out of it yet.
    const hasPlanningChat = Boolean(this.database.db.prepare("SELECT 1 FROM chats WHERE card_id = ? AND purpose = 'planning' LIMIT 1").get(cardId))
    const planningOpen = run.state === 'idle' && !hasPlan && tasks.total === 0 && !row.description.trim() && !this.documents.read(cardId, 'especificacao').trim() && (!row.title.trim() || hasPlanningChat)
    // Branch and worktree the card works in (the most recent active one), to show on the card.
    const workspace = (this.database.db.prepare("SELECT branch, base_ref AS baseRef, path FROM worktrees WHERE card_id = COALESCE((SELECT worktree_card_id FROM cards WHERE id = ?), ?) AND cleanup_state = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(cardId, cardId) as { branch: string; baseRef: string; path: string } | undefined) ?? null
    // All the agents that worked on the card (planning, implementation and test), in the order they joined.
    const agentIds = this.database.db.prepare('SELECT profile_id FROM chats WHERE card_id = ? GROUP BY profile_id ORDER BY MIN(created_at)').pluck().all(cardId) as string[]
    // When the card uses another card's worktree, the screen shows whose it is (and offers to unlink).
    const sharedFrom = (this.database.db.prepare('SELECT o.title FROM cards c JOIN cards o ON o.id = c.worktree_card_id WHERE c.id = ?').pluck().get(cardId) as string | undefined) ?? null
    return { ...row, acceptanceCriteria: criteria, tasks, run, hasPlan, planningOpen, workspace: workspace ? { ...workspace, sharedFrom } : null, pending: this.pendingCounts(cardId), testsRunning: cardTestsRunning(this.database.db, cardId), waiting: cardWaiting(this.database.db, cardId), ...this.execSettings(cardId), agentIds, complexity: complexitySummary(this.database.db, cardId), repoIds: this.repoIds(cardId), workflow: row.workflow ?? null, sddMethod: this.sddMethod(cardId, row.workflow) }
  }

  /** SDD method chosen along with the flow (last `workflow.selected`); only applies in the `sdd` flow. */
  private sddMethod(cardId: string, workflow: Card['workflow']): Card['sddMethod'] {
    if (workflow !== 'sdd') return null
    const json = this.database.db.prepare("SELECT json FROM card_events WHERE card_id = ? AND type = 'workflow.selected' ORDER BY created_at DESC, rowid DESC LIMIT 1").pluck().get(cardId) as string | undefined
    try { const method = json ? (JSON.parse(json) as { payload?: { method?: unknown } }).payload?.method : null; return method === 'native' || method === 'speckit' ? method : null } catch { return null }
  }

  /** Card types in effect for the project (its own or the default list). */
  cardTypes(projectId: string): Project['cardTypes'] { return projectCardTypes(this.database.db, projectId).types }

  /** Repositories the card works in (null = all of the project's). */
  repoIds(cardId: string): string[] | null {
    const raw = this.database.db.prepare('SELECT repo_ids FROM cards WHERE id = ?').pluck().get(cardId) as string | null | undefined
    return raw ? JSON.parse(raw) as string[] : null
  }

  /** Chooses the card's repositories; only accepts Git repositories of the project itself. An empty or null list goes back to all. */
  setRepos(cardId: string, sourceIds: string[] | null): Card {
    const card = this.card(cardId)
    const valid = new Set(this.database.db.prepare('SELECT id FROM project_sources WHERE project_id = ? AND is_git_repository = 1').pluck().all(card.projectId) as string[])
    const unknown = (sourceIds ?? []).filter((id) => !valid.has(id))
    if (unknown.length) throw new Error(tm().projects.repoNotInProjectOrNotGit)
    const value = sourceIds?.length ? JSON.stringify([...new Set(sourceIds)]) : null
    this.database.db.prepare('UPDATE cards SET repo_ids = ?, updated_at = ? WHERE id = ?').run(value, new Date().toISOString(), cardId)
    return this.card(cardId)
  }

  private pendingCounts(cardId: string): { changes: number; questions: number; commits: number; toSend: number; testFailures: number; decisions: number } {
    const count = (sql: string): number => (this.database.db.prepare(sql).get(cardId) as { value: number }).value
    return { changes: count("SELECT COUNT(*) AS value FROM card_changes WHERE card_id = ? AND status = 'pending'"), questions: count("SELECT COUNT(*) AS value FROM card_questions WHERE card_id = ? AND status = 'user'"), commits: count("SELECT COUNT(*) AS value FROM git_commit_requests WHERE card_id = ? AND status = 'pending'"), toSend: count("SELECT COUNT(*) AS value FROM card_changes WHERE card_id = ? AND status IN ('accepted', 'applied') AND sent_at IS NULL"), testFailures: this.testFailures(cardId), decisions: count("SELECT COUNT(*) AS value FROM card_decisions WHERE card_id = ? AND status = 'proposed'") }
  }

  /**
   * Failures in the tester's checklist still waiting for the developer: only while the last implementation/test run is a finished
   * test run. Once the developer runs again (sent by the user or not), the badge goes away until the next test pass.
   */
  private testFailures(cardId: string): number {
    const last = this.database.db.prepare(`SELECT ch.purpose, r.status FROM runs r JOIN chats ch ON ch.id = r.chat_id WHERE r.card_id = ? AND ch.purpose <> 'planning' ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1`).get(cardId) as { purpose: string; status: string } | undefined
    if (last?.purpose !== 'test' || last.status === 'queued' || last.status === 'running') return 0
    const checklist = this.database.db.prepare("SELECT content_md FROM card_checklists WHERE card_id = ? AND purpose = 'test'").pluck().get(cardId) as string | undefined
    return failedChecklistItems(checklist ?? '').length
  }

  private execSettings(cardId: string): { execProfileId: string | null; execModel: string | null } {
    const row = this.database.db.prepare("SELECT profile_id AS profileId, model FROM card_agent_settings WHERE card_id = ? AND purpose = 'execution'").get(cardId) as { profileId: string; model: string | null } | undefined
    return { execProfileId: row?.profileId ?? null, execModel: row?.model ?? null }
  }

  create(input: { projectId: string; columnId: string; sourceId?: string | null; type: string; title: string; description: string; priority: string; acceptanceCriteria: { body: string; checked: boolean }[] }): Card {
    this.assertColumn(input.projectId, input.columnId)
    const sourceId = input.sourceId ?? (this.database.db.prepare('SELECT id FROM project_sources WHERE project_id = ? AND is_git_repository = 1 ORDER BY sort_order LIMIT 1').get(input.projectId) as { id: string } | undefined)?.id ?? null
    if (sourceId && !this.database.db.prepare('SELECT 1 FROM project_sources WHERE id = ? AND project_id = ?').get(sourceId, input.projectId)) throw new Error(tm().projects.sourceNotInProject)
    const id = randomUUID(), now = new Date().toISOString()
    const order = (this.database.db.prepare('SELECT COALESCE(MAX(order_key), 0) + 1024 AS value FROM cards WHERE column_id = ?').get(input.columnId) as { value: number }).value
    const create = this.database.db.transaction(() => {
      this.database.db.prepare(`INSERT INTO cards(id, project_id, column_id, source_id, type, title, description, priority, order_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.projectId, input.columnId, sourceId, input.type, input.title, input.description, input.priority, order, now, now)
      this.replaceCriteria(id, input.acceptanceCriteria)
    })
    create()
    if (input.description.trim()) this.documents.write(id, 'resumo', input.description, 'user')
    if (input.acceptanceCriteria.length) this.documents.write(id, 'tasks', input.acceptanceCriteria.map((item, index) => `- [${item.checked ? 'x' : ' '}] T${String(index + 1).padStart(3, '0')} ${item.body}`).join('\n'), 'user')
    return this.card(id)
  }

  baseBranch(cardId: string): string | null {
    return (this.database.db.prepare('SELECT base_branch FROM cards WHERE id = ?').pluck().get(cardId) as string | null | undefined) ?? null
  }

  setBaseBranch(cardId: string, branch: string | null): void {
    this.database.db.prepare('UPDATE cards SET base_branch = ? WHERE id = ?').run(branch, cardId)
  }

  /** Spec Kit: the "Plan ready" badge follows the real files (the card feature's spec, plan and tasks), never the end of a reply. */
  setSpecKitReady(cardId: string, ready: boolean): void {
    if (ready) this.database.db.prepare('UPDATE cards SET plan_ready_at = COALESCE(plan_ready_at, ?) WHERE id = ?').run(new Date().toISOString(), cardId)
    else this.database.db.prepare('UPDATE cards SET plan_ready_at = NULL WHERE id = ? AND plan_ready_at IS NOT NULL').run(cardId)
  }

  /** The planner only declares the plan complete with Specification, Plan and Tasks written; returns what is missing. */
  markPlanReady(cardId: string): string[] {
    // Short flow: no Specification, Plan and Tasks; describing what to do is enough.
    if (this.card(cardId).workflow === 'light') {
      if (!this.documents.read(cardId, 'resumo').trim()) return ['descricao']
      this.database.db.prepare('UPDATE cards SET plan_ready_at = COALESCE(plan_ready_at, ?) WHERE id = ?').run(new Date().toISOString(), cardId)
      return []
    }
    const missing = (['especificacao', 'plano', 'tasks'] as const).filter((kind) => !this.documents.read(cardId, kind).trim())
    if (!missing.length && countTasks(this.documents.read(cardId, 'tasks')).total === 0) missing.push('tasks')
    if (!missing.length) this.database.db.prepare("UPDATE cards SET plan_ready_at = COALESCE(plan_ready_at, ?) WHERE id = ?").run(new Date().toISOString(), cardId)
    return missing
  }

  update(input: { cardId: string; sourceId?: string | null; type: string; title: string; description: string; priority: string; acceptanceCriteria: { body: string; checked: boolean }[] }): Card {
    const current = this.card(input.cardId)
    const sourceId = input.sourceId === undefined ? current.sourceId : input.sourceId
    if (sourceId && !this.database.db.prepare('SELECT 1 FROM project_sources WHERE id = ? AND project_id = ?').get(sourceId, current.projectId)) throw new Error(tm().projects.sourceNotInProject)
    const update = this.database.db.transaction(() => {
      this.database.db.prepare('UPDATE cards SET source_id = ?, type = ?, title = ?, description = ?, priority = ?, updated_at = ? WHERE id = ?')
        .run(sourceId, input.type, input.title, input.description, input.priority, new Date().toISOString(), input.cardId)
      this.database.db.prepare('DELETE FROM card_acceptance_criteria WHERE card_id = ?').run(input.cardId)
      this.replaceCriteria(input.cardId, input.acceptanceCriteria)
    })
    update()
    if (input.description !== current.description) this.documents.write(input.cardId, 'resumo', input.description, 'user')
    return this.card(input.cardId)
  }

  /** `skipGate` (only by the user, after confirming) skips the Done test and review and records that in the column history. */
  move(cardId: string, columnId: string, beforeCardId: string | null, actor: 'user' | 'agent' = 'user', skipGate = false): Card {
    const current = this.card(cardId)
    this.assertColumn(current.projectId, columnId)
    const destination = this.database.db.prepare('SELECT semantic_state AS state FROM board_columns WHERE id = ?').get(columnId) as { state: string }
    const skipped = destination.state === 'done' && current.columnId !== columnId ? this.assertDoneGate(cardId, actor === 'user' && skipGate) : false
    let orderKey: number, priority = current.priority
    if (beforeCardId) {
      const before = this.card(beforeCardId)
      if (before.columnId !== columnId) throw new Error(tm().projects.referenceCardOtherColumn)
      priority = before.priority
      const prior = this.database.db.prepare('SELECT MAX(order_key) AS value FROM cards WHERE column_id = ? AND priority = ? AND order_key < ? AND id <> ?').get(columnId, priority, before.orderKey, cardId) as { value: number | null }
      orderKey = prior.value === null ? before.orderKey - 1024 : (prior.value + before.orderKey) / 2
    } else {
      orderKey = (this.database.db.prepare('SELECT COALESCE(MAX(order_key), 0) + 1024 AS value FROM cards WHERE column_id = ? AND id <> ?').get(columnId, cardId) as { value: number }).value
    }
    const now = new Date().toISOString()
    const move = this.database.db.transaction(() => {
      this.database.db.prepare('UPDATE cards SET column_id = ?, order_key = ?, priority = ?, updated_at = ? WHERE id = ?').run(columnId, orderKey, priority, now, cardId)
      if (current.columnId !== columnId) this.database.db.prepare(`INSERT INTO column_history(id, card_id, from_column_id, to_column_id, changed_at, actor, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), cardId, current.columnId, columnId, now, actor, actor === 'agent' ? 'agent-request' : skipped ? 'kanban-move-skipped-checks' : 'kanban-move')
    })
    move()
    if (destination.state === 'done' && current.columnId !== columnId) this.onDone?.(cardId)
    return this.card(cardId)
  }

  /** Finalizes the card: the last run stops showing as paused, failed or finished and the open approvals are closed. */
  finalize(cardId: string): Card {
    this.card(cardId)
    const now = new Date().toISOString()
    this.database.db.transaction(() => {
      this.database.db.prepare('UPDATE cards SET finalized_at = ?, updated_at = ? WHERE id = ?').run(now, now, cardId)
      this.database.db.prepare("UPDATE approval_records SET status = 'expired' WHERE card_id = ? AND status = 'requested'").run(cardId)
    })()
    return this.card(cardId)
  }

  archive(cardId: string, restore = false): Card {
    this.card(cardId)
    this.database.db.prepare('UPDATE cards SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(restore ? null : new Date().toISOString(), new Date().toISOString(), cardId)
    return this.card(cardId)
  }

  markViewed(cardId: string): Card {
    this.card(cardId)
    this.database.db.prepare('UPDATE cards SET viewed_at = ? WHERE id = ?').run(new Date().toISOString(), cardId)
    return this.card(cardId)
  }

  delete(cardId: string): boolean {
    this.card(cardId)
    return this.database.db.prepare('DELETE FROM cards WHERE id = ?').run(cardId).changes > 0
  }

  private assertColumn(projectId: string, columnId: string): void {
    const row = this.database.db.prepare('SELECT 1 FROM board_columns WHERE id = ? AND project_id = ?').get(columnId, projectId)
    if (!row) throw new Error(tm().projects.columnNotInProject)
  }

  private replaceCriteria(cardId: string, criteria: { body: string; checked: boolean }[]): void {
    const insert = this.database.db.prepare(`INSERT INTO card_acceptance_criteria(id, card_id, body, checked, sort_order) VALUES (?, ?, ?, ?, ?)`)
    criteria.forEach((item, index) => insert.run(randomUUID(), cardId, item.body, item.checked ? 1 : 0, index))
  }

  /** Checks the Done gate; returns true when tests/review were pending and the user chose to skip. */
  private assertDoneGate(cardId: string, skip = false): boolean {
    const pending = this.pendingChecks(cardId)
    if (pending && !skip) throw new Error(pending)
    // Delivery across several repositories is not atomic: a repository that failed prevents declaring the card delivered.
    const failed = this.database.db.prepare(`SELECT m.repo_path FROM worktree_members m JOIN worktrees w ON w.id = m.worktree_id
      WHERE w.card_id = ? AND m.status = 'failed' AND w.id = (SELECT id FROM worktrees x WHERE x.card_id = w.card_id ORDER BY x.created_at DESC LIMIT 1)`).pluck().all(cardId) as string[]
    if (failed.length) throw new Error(tm().projects.doneNeedsAllRepos(failed.map((path) => basename(path)).join(', ')))
    return Boolean(pending)
  }

  private pendingChecks(cardId: string): string | null {
    const test = this.database.db.prepare('SELECT status FROM test_runs WHERE card_id = ? ORDER BY started_at DESC LIMIT 1').get(cardId) as { status: string } | undefined
    if (!test) return tm().projects.moveToDoneRunTests
    if (test.status === 'running') return tm().projects.testsStillRunning
    if (test.status !== 'passed') return tm().projects.lastTestFailed
    const review = this.database.db.prepare('SELECT state FROM reviews WHERE card_id = ? ORDER BY updated_at DESC LIMIT 1').get(cardId) as { state: string } | undefined
    if (!review || !['approved', 'merged'].includes(review.state)) return tm().projects.testsPassedReviewNeeded
    return null
  }
}
