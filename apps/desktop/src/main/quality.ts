import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Review, TestRun } from '@gearmod/contracts'
import type { AppDatabase } from './database'
import { redact } from './redaction'
import type { WorktreeService } from './worktrees'
import { applyEnvPolicy } from './env-policy'
import { tm } from './i18n'
import { detectTestCommand } from './test-command'

const exec = promisify(execFile)
const testCommandKey = (projectId: string): string => `tests.command.${projectId}`
export class QualityService {
  constructor(private readonly database: AppDatabase, private readonly worktrees: WorktreeService) {}

  async runTest(cardId: string, executable: string, args: string[]): Promise<TestRun> {
    const worktree = this.worktrees.get(cardId)
    if (!worktree) throw new Error(tm().quality.createWorktreeBeforeTests)
    const id = randomUUID(), startedAt = new Date().toISOString(), command = [executable, ...args].map(displayArg).join(' ')
    this.database.db.prepare(`INSERT INTO test_runs(id, card_id, command, status, summary, started_at) VALUES (?, ?, ?, 'running', '', ?)`).run(id, cardId, command, startedAt)
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
    return { id, cardId, command, status, exitCode, summary: redact(summary), startedAt, endedAt }
  }

  /** Test command saved for the project ('' when none). Lives in `settings`, one key per project, so the screen and the agent share it. */
  testCommand(projectId: string): { command: string } {
    const raw = this.database.db.prepare('SELECT json_value FROM settings WHERE key = ?').pluck().get(testCommandKey(projectId))
    try { const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : ''; return { command: typeof value === 'string' ? value : '' } } catch { return { command: '' } }
  }

  /** Saves (or clears, with '') the project's test command. Only saves: running it is still the user's click, with confirmation. */
  setTestCommand(projectId: string, command: string): { command: string } {
    const value = command.trim()
    if (value.length > 2048 || /[\r\n]/.test(value)) throw new Error('The test command must be a single line of up to 2048 characters')
    if (!value) this.database.db.prepare('DELETE FROM settings WHERE key = ?').run(testCommandKey(projectId))
    else this.database.db.prepare(`INSERT INTO settings(key, json_value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET json_value = excluded.json_value, updated_at = excluded.updated_at`).run(testCommandKey(projectId), JSON.stringify(value), new Date().toISOString())
    return { command: value }
  }

  /** Suggested test command for the card's worktree ('' when nothing is recognized). */
  detectCommand(cardId: string): { command: string } {
    const worktree = this.worktrees.get(cardId)
    return { command: worktree ? detectTestCommand(worktree.path) : '' }
  }

  /** Last test and last review of the card: what the Done gate checks. */
  status(cardId: string): { test: TestRun | null; review: Review | null } {
    const test = this.database.db.prepare(`SELECT id, card_id AS cardId, command, status, exit_code AS exitCode, summary, started_at AS startedAt, ended_at AS endedAt
      FROM test_runs WHERE card_id = ? ORDER BY started_at DESC LIMIT 1`).get(cardId) as TestRun | undefined
    const review = this.database.db.prepare(`SELECT id, card_id AS cardId, provider, remote_url AS remoteUrl, remote_id AS remoteId,
      state, target_branch AS targetBranch, source_branch AS sourceBranch, updated_at AS updatedAt FROM reviews WHERE card_id = ? ORDER BY updated_at DESC LIMIT 1`).get(cardId) as Review | undefined
    return { test: test ?? null, review: review ?? null }
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
