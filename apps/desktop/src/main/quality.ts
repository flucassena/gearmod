import { randomUUID } from 'node:crypto'
import { exec as execShell, execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { RepoTestCommand, Review, TestRun, TestRunRepo } from '@gearmod/contracts'
import type { AppDatabase } from './database'
import { redact } from './redaction'
import type { WorktreeService } from './worktrees'
import { applyEnvPolicy } from './env-policy'
import { tm } from './i18n'
import { detectTestCommand } from './test-command'

const exec = promisify(execFile)
const testCommandKey = (projectId: string): string => `tests.command.${projectId}`
const repoCommandsKey = (projectId: string): string => `tests.repos.${projectId}`
const samePath = (a: string, b: string): boolean => { const norm = (value: string): string => resolve(value).replace(/[\\/]+$/, '').toLowerCase(); return norm(a) === norm(b) }

/**
 * Runs one test command through the system shell (cmd.exe on Windows, sh elsewhere), so `npm`, `npx` and `pnpm` (.cmd on Windows) work
 * and the command can chain steps. S07: it receives only the app's fixed environment list, plus where it is running.
 */
async function runShell(command: string, cwd: string, extra: Record<string, string>): Promise<{ exitCode: number; output: string }> {
  return new Promise((done) => {
    execShell(command, { cwd, timeout: 10 * 60_000, windowsHide: true, maxBuffer: 5 * 1024 * 1024, env: { ...applyEnvPolicy({ envPassthrough: [] }, process.env), ...extra } }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.trim()
      if (!error) { done({ exitCode: 0, output }); return }
      const code = typeof error.code === 'number' ? error.code : 1
      done({ exitCode: code === 0 ? 1 : code, output: `${output}\n${error.killed ? 'Stopped: took longer than 10 minutes.' : ''}`.trim() || error.message })
    })
  })
}
export class QualityService {
  /** `changed`: the card's test state changed (started or finished), so the board and the sidebar reload. */
  constructor(private readonly database: AppDatabase, private readonly worktrees: WorktreeService, private readonly changed: (cardId: string) => void = () => undefined) {}

  /** Test runs left `running` by an app that closed midway never finish: they become failed, so the card does not look busy forever. */
  reconcileInterrupted(): void {
    this.database.db.prepare(`UPDATE test_runs SET status = 'failed', exit_code = COALESCE(exit_code, 1), summary = CASE WHEN summary = '' THEN 'Interrupted: the app closed while the tests were running.' ELSE summary END, ended_at = COALESCE(ended_at, ?) WHERE status = 'running'`).run(new Date().toISOString())
  }

  async runTest(cardId: string, executable: string, args: string[]): Promise<TestRun> {
    const worktree = this.worktrees.get(cardId)
    if (!worktree) throw new Error(tm().quality.createWorktreeBeforeTests)
    const id = randomUUID(), startedAt = new Date().toISOString(), command = [executable, ...args].map(displayArg).join(' ')
    this.database.db.prepare(`INSERT INTO test_runs(id, card_id, command, status, summary, started_at) VALUES (?, ?, ?, 'running', '', ?)`).run(id, cardId, command, startedAt)
    this.changed(cardId)
    let exitCode = 0, status: TestRun['status'] = 'passed', summary = ''
    try {
      // S07: the test command is the user's (it has no agent profile); it receives only the app's fixed list, with no declared passthrough.
      const result = await exec(executable, args, { cwd: worktree.path, timeout: 10 * 60_000, windowsHide: true, maxBuffer: 5 * 1024 * 1024, env: applyEnvPolicy({ envPassthrough: [] }, process.env) })
      summary = `${result.stdout}\n${result.stderr}`.trim().slice(-100_000)
    } catch (error) {
      status = 'failed'; exitCode = typeof error === 'object' && error && 'code' in error && typeof error.code === 'number' ? error.code : 1
      summary = error instanceof Error ? error.message : String(error)
    }
    const endedAt = new Date().toISOString()
    this.database.db.prepare('UPDATE test_runs SET status = ?, exit_code = ?, summary = ?, ended_at = ? WHERE id = ?').run(status, exitCode, redact(summary), endedAt, id)
    this.changed(cardId)
    return { id, cardId, command, status, exitCode, summary: redact(summary), startedAt, endedAt }
  }

  /** Each repository of the project with its automated-test setting (command, short name, or no tests). */
  repoCommands(projectId: string): RepoTestCommand[] {
    const sources = this.sources(projectId), saved = this.repoSettings(projectId)
    // Before the per-repository setting, a single-repository project had one command for the project: it becomes that repository's.
    const legacy = !Object.keys(saved).length && sources.length === 1 ? this.testCommand(projectId) : null
    return sources.map((source) => {
      const setting = saved[source.id] ?? (legacy?.command ? { command: legacy.command, name: legacy.name, applicable: true } : { command: '', name: '', applicable: true })
      return { sourceId: source.id, repo: source.name, path: source.localPath, command: setting.command, name: setting.name, applicable: setting.applicable }
    })
  }

  /** Saves one repository's setting. `applicable: false` means it has no automated tests (it is skipped, and does not hold Done). */
  setRepoCommand(projectId: string, sourceId: string, input: { command: string; name: string; applicable: boolean }): RepoTestCommand[] {
    if (!this.sources(projectId).some((source) => source.id === sourceId)) throw new Error('Unknown repository for this project')
    const command = input.command.trim(), name = input.name.trim()
    if (command.length > 2048 || /[\r\n]/.test(command)) throw new Error('The test command must be a single line of up to 2048 characters')
    if (name.length > 60 || /[\r\n]/.test(name)) throw new Error('The test command name must be a single line of up to 60 characters')
    const saved = this.repoSettings(projectId)
    saved[sourceId] = { command: input.applicable ? command : '', name: input.applicable ? name : '', applicable: input.applicable }
    this.database.db.prepare(`INSERT INTO settings(key, json_value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET json_value = excluded.json_value, updated_at = excluded.updated_at`).run(repoCommandsKey(projectId), JSON.stringify(saved), new Date().toISOString())
    return this.repoCommands(projectId)
  }

  /** Project repository by id or by name (the agent names it), case-insensitive. */
  findRepo(projectId: string, ref: string): { id: string; name: string } | undefined {
    const wanted = ref.trim().toLowerCase()
    return this.sources(projectId).find((source) => source.id === ref.trim() || source.name.toLowerCase() === wanted)
  }

  /**
   * What "Testes automatizados" will run for the card: the configured repositories, marking the ones the card changed.
   * `fallback` is the old single project command, used only while no repository has its own.
   */
  async plan(cardId: string): Promise<{ repos: Array<{ name: string; label: string; command: string; changed: boolean; path: string }>; fallback: string }> {
    const projectId = this.database.db.prepare('SELECT project_id FROM cards WHERE id = ?').pluck().get(cardId) as string | undefined
    if (!projectId) throw new Error(tm().common.cardNotFound)
    const settings = this.repoCommands(projectId), members = await this.worktrees.changedRepos(cardId)
    const configured = settings.filter((item) => item.applicable && item.command)
    const repos = configured.flatMap((item) => {
      const member = members.find((candidate) => samePath(candidate.repoPath, item.path))
      return member ? [{ name: item.repo, label: item.name || item.repo, command: item.command, changed: member.changed, path: member.path }] : []
    })
    return { repos, fallback: configured.length ? '' : this.testCommand(projectId).command }
  }

  /**
   * Runs the automated tests of the card: each changed repository's command, one after the other, inside that repository's folder
   * in the card worktree. Passes when every one passes; repositories the card did not change, or without tests, are skipped.
   */
  async runCard(cardId: string): Promise<TestRun> {
    const worktree = this.worktrees.get(cardId)
    if (!worktree) throw new Error(tm().quality.createWorktreeBeforeTests)
    const plan = await this.plan(cardId)
    const steps: Array<TestRunRepo & { path: string }> = plan.repos.length
      ? plan.repos.map((repo) => ({ name: repo.name, label: repo.label, command: repo.command, path: repo.path, status: repo.changed ? 'running' : 'skipped', exitCode: null, reason: repo.changed ? '' : 'unchanged' }))
      : plan.fallback ? [{ name: '', label: '', command: plan.fallback, path: worktree.path, status: 'running', exitCode: null, reason: '' }] : []
    if (!steps.length) throw new Error(tm().quality.noTestCommand)
    const id = randomUUID(), startedAt = new Date().toISOString(), command = steps.filter((step) => step.status === 'running').map((step) => step.label ? `${step.label}: ${step.command}` : step.command).join(' · ')
    const public_ = (): TestRunRepo[] => steps.map(({ path: _path, ...step }) => step)
    this.database.db.prepare(`INSERT INTO test_runs(id, card_id, command, status, summary, started_at, repos_json) VALUES (?, ?, ?, 'running', '', ?, ?)`).run(id, cardId, command, startedAt, JSON.stringify(public_()))
    this.changed(cardId)
    const outputs: string[] = []
    for (const step of steps) {
      if (step.status !== 'running') continue
      const result = await runShell(step.command, step.path, { GEARMOD_CARD_ID: cardId, GEARMOD_WORKTREE: worktree.path, GEARMOD_REPO: step.name, GEARMOD_REPO_PATH: step.path })
      step.status = result.exitCode === 0 ? 'passed' : 'failed'; step.exitCode = result.exitCode
      outputs.push(`${step.label ? `### ${step.label} — ${step.command}\n` : ''}${result.output}`)
      this.database.db.prepare('UPDATE test_runs SET repos_json = ? WHERE id = ?').run(JSON.stringify(public_()), id)
      this.changed(cardId)
    }
    const failed = steps.find((step) => step.status === 'failed'), ran = steps.some((step) => step.status !== 'skipped')
    const status: TestRun['status'] = failed ? 'failed' : 'passed', exitCode = failed?.exitCode ?? 0
    const summary = redact((ran ? outputs.join('\n\n') : tm().quality.nothingChangedToTest).slice(-100_000)), endedAt = new Date().toISOString()
    this.database.db.prepare('UPDATE test_runs SET status = ?, exit_code = ?, summary = ?, ended_at = ?, repos_json = ? WHERE id = ?').run(status, exitCode, summary, endedAt, JSON.stringify(public_()), id)
    this.changed(cardId)
    return { id, cardId, command, status, exitCode, summary, startedAt, endedAt, repos: public_() }
  }

  private sources(projectId: string): Array<{ id: string; name: string; localPath: string }> {
    return this.database.db.prepare('SELECT id, name, local_path AS localPath FROM project_sources WHERE project_id = ? ORDER BY sort_order').all(projectId) as Array<{ id: string; name: string; localPath: string }>
  }

  private repoSettings(projectId: string): Record<string, { command: string; name: string; applicable: boolean }> {
    const raw = this.database.db.prepare('SELECT json_value FROM settings WHERE key = ?').pluck().get(repoCommandsKey(projectId))
    try {
      const value = typeof raw === 'string' ? JSON.parse(raw) as Record<string, Partial<{ command: unknown; name: unknown; applicable: unknown }>> : {}
      return Object.fromEntries(Object.entries(value ?? {}).map(([key, item]) => [key, { command: typeof item.command === 'string' ? item.command : '', name: typeof item.name === 'string' ? item.name : '', applicable: item.applicable !== false }]))
    } catch { return {} }
  }

  /**
   * Test command saved for the project ('' when none) and its short name ('' when none). Lives in `settings`, one key per project,
   * so the screen and the agent share it. Older values were a plain string (command only).
   */
  testCommand(projectId: string): { command: string; name: string } {
    const raw = this.database.db.prepare('SELECT json_value FROM settings WHERE key = ?').pluck().get(testCommandKey(projectId))
    try {
      const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : ''
      if (typeof value === 'string') return { command: value, name: '' }
      if (value && typeof value === 'object') { const { command, name } = value as { command?: unknown; name?: unknown }; return { command: typeof command === 'string' ? command : '', name: typeof name === 'string' ? name : '' } }
      return { command: '', name: '' }
    } catch { return { command: '', name: '' } }
  }

  /**
   * Saves (or clears, with '') the project's test command. Only saves: running it is still the user's click, with confirmation.
   * `name` is the short label shown in the Changes panel; when left out, the saved name is kept if the command is the same one.
   */
  setTestCommand(projectId: string, command: string, name?: string): { command: string; name: string } {
    const value = command.trim()
    if (value.length > 2048 || /[\r\n]/.test(value)) throw new Error('The test command must be a single line of up to 2048 characters')
    const label = (name ?? (this.testCommand(projectId).command === value ? this.testCommand(projectId).name : '')).trim()
    if (label.length > 60 || /[\r\n]/.test(label)) throw new Error('The test command name must be a single line of up to 60 characters')
    if (!value) { this.database.db.prepare('DELETE FROM settings WHERE key = ?').run(testCommandKey(projectId)); return { command: '', name: '' } }
    this.database.db.prepare(`INSERT INTO settings(key, json_value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET json_value = excluded.json_value, updated_at = excluded.updated_at`).run(testCommandKey(projectId), JSON.stringify({ command: value, name: label }), new Date().toISOString())
    return { command: value, name: label }
  }

  /** Suggested test command for the card's worktree ('' when nothing is recognized). */
  detectCommand(cardId: string): { command: string } {
    const worktree = this.worktrees.get(cardId)
    return { command: worktree ? detectTestCommand(worktree.path) : '' }
  }

  /** Last test and last review of the card: what the Done gate checks. */
  status(cardId: string): { test: TestRun | null; review: Review | null } {
    const test = this.database.db.prepare(`SELECT id, card_id AS cardId, command, status, exit_code AS exitCode, summary, started_at AS startedAt, ended_at AS endedAt
      , repos_json AS reposJson FROM test_runs WHERE card_id = ? ORDER BY started_at DESC LIMIT 1`).get(cardId) as (TestRun & { reposJson?: string }) | undefined
    const review = this.database.db.prepare(`SELECT id, card_id AS cardId, provider, remote_url AS remoteUrl, remote_id AS remoteId,
      state, target_branch AS targetBranch, source_branch AS sourceBranch, updated_at AS updatedAt FROM reviews WHERE card_id = ? ORDER BY updated_at DESC LIMIT 1`).get(cardId) as Review | undefined
    if (!test) return { test: null, review: review ?? null }
    const { reposJson, ...rest } = test
    let repos: TestRunRepo[] = []; try { repos = JSON.parse(reposJson ?? '[]') as TestRunRepo[] } catch { /* older run: no per-repository result */ }
    return { test: { ...rest, repos }, review: review ?? null }
  }

  prepareLocalReview(cardId: string): Review {
    const worktree = this.worktrees.get(cardId)
    if (!worktree) throw new Error(tm().quality.createWorktreeBeforeReview)
    const existing = this.database.db.prepare(`SELECT id, card_id AS cardId, provider, remote_url AS remoteUrl, remote_id AS remoteId,
      state, target_branch AS targetBranch, source_branch AS sourceBranch, updated_at AS updatedAt FROM reviews WHERE card_id = ? ORDER BY updated_at DESC LIMIT 1`).get(cardId) as Review | undefined
    if (existing) return existing
    const review: Review = { id: randomUUID(), cardId, provider: 'local', remoteUrl: null, remoteId: null, state: 'open', targetBranch: worktree.baseRef, sourceBranch: worktree.branch, updatedAt: new Date().toISOString() }
    this.database.db.prepare(`INSERT INTO reviews(id, card_id, provider, state, target_branch, source_branch, updated_at) VALUES (?, ?, 'local', 'open', ?, ?, ?)`).run(review.id, cardId, review.targetBranch, review.sourceBranch, review.updatedAt)
    return review
  }

  approveLocal(reviewId: string): Review {
    const row = this.database.db.prepare(`SELECT id, card_id AS cardId, provider, remote_url AS remoteUrl, remote_id AS remoteId,
      state, target_branch AS targetBranch, source_branch AS sourceBranch, updated_at AS updatedAt FROM reviews WHERE id = ?`).get(reviewId) as Review | undefined
    if (!row || row.provider !== 'local') throw new Error(tm().quality.localReviewNotFound)
    const updatedAt = new Date().toISOString()
    this.database.db.prepare(`UPDATE reviews SET state = 'approved', updated_at = ? WHERE id = ?`).run(updatedAt, reviewId)
    return { ...row, state: 'approved', updatedAt }
  }
}

function displayArg(value: string): string { return /\s/.test(value) ? JSON.stringify(value) : value }
