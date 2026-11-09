import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultWorkflowConfig } from '@gearmod/contracts'
import type { AgentAdapter } from './adapters'
import { ConversationRepository } from './conversations'
import { AppDatabase } from './database'
import { GitManager, type CliRunner } from './git-manager'
import { HarnessService, outOfScope, repeatedFailure } from './harness'
import { CardHistoryService } from './history'
import { AgentOrchestrator } from './orchestrator'
import { PlaywrightCliService, type CommandRunner } from './playwright-cli'
import { BoardRepository, GitService, ProfileRepository, ProjectRepository } from './projects'
import { seedProfiles } from './test-helpers'
import { WorktreeService } from './worktrees'

const exec = promisify(execFile), roots: string[] = [], closers: Array<() => void> = []
afterEach(async () => { closers.splice(0).forEach((close) => close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))) })

async function repo(path: string): Promise<void> {
  await exec('git', ['init', '-b', 'main', path]); await exec('git', ['-C', path, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', path, 'config', 'user.name', 'GearMod Test'])
  await writeFile(join(path, 'README.md'), '# fixture'); await exec('git', ['-C', path, 'add', 'README.md']); await exec('git', ['-C', path, 'commit', '-m', 'fixture'])
}

/** Workspace with docs, frontend and backend (scenarios E and H). */
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-coord-')); roots.push(root)
  const ws = join(root, 'ws'), data = join(root, 'data'); await mkdir(ws)
  for (const name of ['backend', 'docs', 'frontend']) await repo(join(ws, name))
  const database = new AppDatabase(join(data, 'db.sqlite'), '0.1.0'); await database.open(); closers.push(() => database.close())
  const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
  const projects = new ProjectRepository(database, new GitService()), project = await projects.create({ localPath: ws, profileIds: profiles.list().map((profile) => profile.id) })
  const board = new BoardRepository(database, projects), column = board.get(project.id).columns[2]!
  const card = board.create({ projectId: project.id, columnId: column.id, title: 'Push', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
  const sources = Object.fromEntries(board.get(project.id).project.sources.map((source) => [source.name, source]))
  return { root, ws, data, database, profiles, projects, board, project, card, sources, worktrees: new WorktreeService(database, data) }
}

describe('Coordinated worktrees', () => {
  it("creates a worktree only in the card's repositories and adds a new repository to the same worktree", async () => {
    const { board, card, sources, worktrees } = await workspace()
    board.setRepos(card.id, [sources.frontend!.id, sources.backend!.id])
    const first = await worktrees.prepare(card.id)
    expect(worktrees.repositories(card.id).map((repo) => [repo.repoPath.split(/[\\/]/).pop(), repo.status]).sort()).toEqual([['backend', 'active'], ['frontend', 'active']])
    board.setRepos(card.id, [sources.frontend!.id, sources.backend!.id, sources.docs!.id])
    const again = await worktrees.prepare(card.id)
    expect(again.id).toBe(first.id)
    expect(worktrees.repositories(card.id)).toHaveLength(3)
    expect(() => board.setRepos(card.id, ['00000000-0000-4000-8000-000000000009'])).toThrow(/não pertence/)
    expect(board.setRepos(card.id, null).repoIds).toBeNull()
  })

  it('a failure in one repository does not take down the others, blocks Done and is redone on the next preparation', async () => {
    const { board, card, sources, worktrees, database } = await workspace()
    // Card with the three repositories chosen (without a choice, only the first gets a worktree right away).
    board.setRepos(card.id, [sources.frontend!.id, sources.backend!.id, sources.docs!.id])
    database.db.prepare("UPDATE project_sources SET current_branch = 'nao-existe', base_branch = 'nao-existe' WHERE id = ?").run(sources.backend!.id)
    const worktree = await worktrees.prepare(card.id)
    const repos = worktrees.repositories(card.id), backend = repos.find((repo) => repo.repoPath.endsWith('backend'))!
    expect(backend.status).toBe('failed'); expect(backend.error).toContain('backend')
    expect(repos.filter((repo) => repo.status === 'active')).toHaveLength(2)
    const done = board.get(card.projectId).columns.find((column) => column.semanticState === 'done')!
    database.db.prepare("INSERT INTO test_runs(id, card_id, command, status, summary, started_at) VALUES ('t1', ?, 'npm test', 'passed', '', ?)").run(card.id, new Date().toISOString())
    database.db.prepare("INSERT INTO reviews(id, card_id, provider, state, target_branch, source_branch, updated_at) VALUES ('r1', ?, 'local', 'approved', 'main', 'x', ?)").run(card.id, new Date().toISOString())
    expect(() => board.move(card.id, done.id, null)).toThrow(/falhou: backend/)
    database.db.prepare("UPDATE project_sources SET current_branch = 'main', base_branch = 'main' WHERE id = ?").run(sources.backend!.id)
    expect((await worktrees.prepare(card.id)).id).toBe(worktree.id)
    expect(worktrees.repositories(card.id).every((repo) => repo.status === 'active')).toBe(true)
    expect(board.move(card.id, done.id, null).columnId).toBe(done.id)
  })

  it('opens one PR per repository with commits and says what was missing in the others', async () => {
    const { root, board, card, sources, worktrees, database } = await workspace()
    board.setRepos(card.id, [sources.frontend!.id, sources.backend!.id])
    await worktrees.prepare(card.id)
    const remote = join(root, 'remote-front.git'); await exec('git', ['init', '--bare', remote])
    const front = worktrees.repositories(card.id).find((repo) => repo.repoPath.endsWith('frontend'))!
    await exec('git', ['-C', front.repoPath, 'remote', 'add', 'origin', remote])
    await writeFile(join(front.path, 'push.ts'), 'export {}'); await exec('git', ['-C', front.path, 'add', '.']); await exec('git', ['-C', front.path, 'commit', '-m', 'Push'])
    const calls: Array<{ command: string; args: string[] }> = []
    const cli: CliRunner = { run: async (command, args) => { calls.push({ command, args }); return 'https://github.com/acme/frontend/pull/7\n' } }
    const git = new GitManager(database, undefined, cli)
    const { results } = await git.createPullRequests(card.id, { draft: true })
    expect(results.find((item) => item.repo === 'frontend')).toEqual({ repo: 'frontend', url: 'https://github.com/acme/frontend/pull/7', error: null })
    expect(results.find((item) => item.repo === 'backend')?.error).toMatch(/sem commits/)
    expect(calls[0]!.command).toBe('gh'); expect(calls[0]!.args).toContain('--draft')
    // The branch is born with the card type's prefix; the push takes the worktree's branch to the remote.
    expect((await exec('git', ['--git-dir', remote, 'branch', '--list'])).stdout).toContain(worktrees.get(card.id)!.branch)
    const view = await git.card(card.id)
    expect(view.repos.find((repo) => repo.name === 'frontend')?.prUrl).toBe('https://github.com/acme/frontend/pull/7')
    expect(view.delivery.complete).toBe(true)
    expect(git.prUrlOf(card.id, 'https://github.com/acme/frontend/pull/7')).toContain('/pull/7')
    expect(() => git.prUrlOf(card.id, 'https://evil.example/x')).toThrow(/desconhecido/)
    await writeFile(join(front.path, 'solto.ts'), 'x')
    expect((await git.card(card.id)).delivery.pending[0]).toMatch(/frontend: 1 alteração/)
  })
})

describe('Harness', () => {
  it("flags files outside the Plan's areas and ignores lock/build", () => {
    const plan = 'Áreas afetadas: `src/push/` e `src/app.ts`. Testes em tests/push.test.ts'
    expect(outOfScope(plan, ['src/push/fcm.ts', 'src/app.ts', 'src/billing/x.ts', 'package-lock.json', 'tests/push.test.ts'])).toEqual(['src/billing/x.ts'])
    expect(outOfScope('Plano sem caminhos', ['qualquer.ts'])).toEqual([])
    expect(outOfScope('Mexe em `api/routes/`', ['backend/api/routes/a.ts', 'frontend/src/b.ts'], ['backend', 'frontend'])).toEqual(['frontend/src/b.ts'])
  })

  it('ignores what the test tools leave behind (Playwright logs, reports, evidence screenshots)', () => {
    const plan = 'Áreas afetadas: `web/src/contrato/`'
    expect(outOfScope(plan, ['web/src/contrato/a.ts', 'web/.playwright-cli/console-2026-11-02.log', 'web/playwright-report/index.html', 'web/test-results/x/trace.zip', 'docs/cards/asf/playwright/us1.png', 'api/serializers/x.py'])).toEqual(['api/serializers/x.py'])
  })

  it('does not flag the paths the project asked to ignore (card documents and evidence folder)', () => {
    const plan = 'Áreas afetadas: `contrato/api/`'
    const changed = ['contrato/api/a.py', 'sdd/cards-nosdd/asf-4668/discovery.md', 'sdd/cards-nosdd/asf-4668/playwright/x.png', 'sdd/outra/x.md', 'web/src/b.ts']
    expect(outOfScope(plan, changed, ['contrato', 'sdd', 'web'], ['cards-nosdd/'])).toEqual(['sdd/outra/x.md', 'web/src/b.ts'])
    expect(outOfScope(plan, changed, ['contrato', 'sdd', 'web'], ['sdd/cards-nosdd', ' ', 'web'])).toEqual(['sdd/outra/x.md'])
  })

  it('stops on budget and on repeated failures only in automatic resumes', async () => {
    const { database, board, card, project, data, worktrees, profiles } = await workspace()
    const history = new CardHistoryService(database, data), harness = new HarnessService(database, history, worktrees)
    history.setConfig(project.id, { ...defaultWorkflowConfig, harness: { timeoutMinutes: 30, maxTokens: 5000, maxCostUsd: null, includeEquivalentCost: false, maxAttempts: 2, scopeCheck: true, scopeIgnore: [] } })
    const conversations = new ConversationRepository(database), chat = conversations.createChat({ projectId: project.id, cardId: card.id, purpose: 'execution', profileId: profiles.list()[0]!.id })
    for (const reason of ['Claude exited (1): rede caiu 12', 'Claude exited (1): rede caiu 13']) {
      const run = conversations.createRun({ cardId: card.id, chatId: chat.id, profileId: profiles.list()[0]!.id }); conversations.updateRun(run.id, 'failed', reason)
    }
    expect(repeatedFailure(database, chat.id, 2)).toContain('rede caiu')
    expect(harness.before({ cardId: card.id, chatId: chat.id, automatic: false })).toBeNull()
    expect(harness.before({ cardId: card.id, chatId: chat.id, automatic: true })).toMatch(/falharam com o mesmo erro/)
    database.db.prepare('UPDATE runs SET input_tokens = 4000, output_tokens = 1500 WHERE card_id = ?').run(card.id)
    expect(harness.before({ cardId: card.id, chatId: chat.id, automatic: false })).toMatch(/acima do limite/)
    expect(harness.timeoutMs(card.id)).toBe(30 * 60_000)
    expect(board.card(card.id).id).toBe(card.id)
  })

  it('S10: detects a commit that did not come from agentCommit, and flags nothing when it did', async () => {
    const { board, card, sources, worktrees, database, data, profiles } = await workspace()
    board.setRepos(card.id, [sources.frontend!.id])
    const history = new CardHistoryService(database, data), harness = new HarnessService(database, history, worktrees)
    await worktrees.prepare(card.id)
    const repo = worktrees.repositories(card.id)[0]!
    await harness.snapshotRepos(card.id)
    await writeFile(join(repo.path, 'escondido.ts'), 'x')
    await exec('git', ['-C', repo.path, 'add', 'escondido.ts'])
    await exec('git', ['-C', repo.path, 'commit', '-m', 'commit direto, sem passar pelo pedido'])
    const tampered = await harness.after({ cardId: card.id, runId: 'r1', chatId: 'c1', purpose: 'execution', status: 'completed' })
    expect(tampered.some((notice) => notice.includes('não veio do pedido de commit'))).toBe(true)

    await worktrees.prepare(card.id)
    await harness.snapshotRepos(card.id)
    await writeFile(join(repo.path, 'aprovado.ts'), 'x')
    await exec('git', ['-C', repo.path, 'add', 'aprovado.ts'])
    await exec('git', ['-C', repo.path, 'commit', '-m', 'commit pelo fluxo de aprovação'])
    const hash = (await exec('git', ['-C', repo.path, 'rev-parse', 'HEAD'])).stdout.trim()
    database.db.prepare("INSERT INTO git_commit_agents(repo_path, hash, profile_id) VALUES (?, ?, ?)").run(repo.path, hash, profiles.list()[0]!.id)
    const clean = await harness.after({ cardId: card.id, runId: 'r2', chatId: 'c1', purpose: 'execution', status: 'completed' })
    expect(clean.some((notice) => notice.includes('não veio do pedido de commit'))).toBe(false)
  })

  it('S10: also detects a branch switch in the worktree during execution', async () => {
    const { board, card, sources, worktrees, database, data } = await workspace()
    board.setRepos(card.id, [sources.frontend!.id])
    const history = new CardHistoryService(database, data), harness = new HarnessService(database, history, worktrees)
    await worktrees.prepare(card.id)
    const repo = worktrees.repositories(card.id)[0]!
    await harness.snapshotRepos(card.id)
    await exec('git', ['-C', repo.path, 'checkout', '-b', 'outra-branch'])
    const result = await harness.after({ cardId: card.id, runId: 'r3', chatId: 'c1', purpose: 'execution', status: 'completed' })
    expect(result.some((notice) => notice.includes('mudou de'))).toBe(true)
  })

  it('maxCostUsd sums only billed cost by default; includeEquivalentCost also sums the equivalent', async () => {
    const { database, data, worktrees, board, card, project, profiles } = await workspace()
    const history = new CardHistoryService(database, data), harness = new HarnessService(database, history, worktrees)
    const chat = new ConversationRepository(database).createChat({ projectId: project.id, cardId: card.id, purpose: 'execution', profileId: profiles.list()[0]!.id })
    const insert = database.db.prepare(`INSERT INTO usage_ledger(id, at, run_id, seq, source, provider, profile_id, card_id, cost_kind, cost_usd)
      VALUES (?, ?, NULL, 0, 'run', 'claude', ?, ?, ?, ?)`)
    history.setConfig(project.id, { ...defaultWorkflowConfig, harness: { timeoutMinutes: null, maxTokens: null, maxCostUsd: 1, includeEquivalentCost: false, maxAttempts: 3, scopeCheck: true, scopeIgnore: [] } })
    insert.run('u1', new Date().toISOString(), profiles.list()[0]!.id, card.id, 'api_equivalent', 5)
    expect(harness.before({ cardId: card.id, chatId: chat.id, automatic: false })).toBeNull()
    insert.run('u2', new Date().toISOString(), profiles.list()[0]!.id, card.id, 'billed', 2)
    expect(harness.before({ cardId: card.id, chatId: chat.id, automatic: false })).toMatch(/custo faturado,/)
    history.setConfig(project.id, { ...defaultWorkflowConfig, harness: { timeoutMinutes: null, maxTokens: null, maxCostUsd: 1, includeEquivalentCost: true, maxAttempts: 3, scopeCheck: true, scopeIgnore: [] } })
    expect(harness.before({ cardId: card.id, chatId: chat.id, automatic: false })).toMatch(/custo faturado e equivalente/)
    expect(board.card(card.id).id).toBe(card.id)
  })

  it('the orchestrator marks a run that timed out as a failure, not as stopped by the user', async () => {
    const { database, card, profiles } = await workspace()
    const conversations = new ConversationRepository(database), chat = conversations.createChat({ projectId: card.projectId, cardId: card.id, purpose: 'planning', profileId: profiles.list()[0]!.id })
    const slow: AgentAdapter = { run: (options) => new Promise((resolve) => options.signal?.addEventListener('abort', () => resolve({ sessionId: 's', turnId: null, text: '', status: 'interrupted', error: 'Interrompido pelo usuário' }))) } as AgentAdapter
    const orchestrator = new AgentOrchestrator(conversations, { codex: slow, claude: slow, gemini: slow }, () => undefined, { prepare: async () => { throw new Error('Nenhum repositório Git foi encontrado') } } as unknown as WorktreeService, 1)
    orchestrator.setHarness({ before: () => null, timeoutMs: () => 50, after: async () => [] })
    const runOf = (id: string) => database.db.prepare('SELECT status, exit_reason AS exitReason FROM runs WHERE id = ?').get(id) as { status: string; exitReason: string | null }
    const run = orchestrator.start({ chatId: chat.id, prompt: 'planeje', planning: true })
    for (let i = 0; i < 100 && runOf(run.id).status !== 'failed'; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(runOf(run.id)).toMatchObject({ status: 'failed', exitReason: expect.stringContaining('Tempo limite') })
    orchestrator.setHarness({ before: () => 'Orçamento estourado', timeoutMs: () => null, after: async () => [] })
    expect(() => orchestrator.start({ chatId: chat.id, prompt: 'de novo', planning: true })).toThrow('Orçamento estourado')
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
})

describe('Playwright CLI', () => {
  it('installs in an app folder, with several versions, per-project choice and a verified portable Node', async () => {
    const { database, project, card, data } = await workspace()
    const history = new CardHistoryService(database, data), tools = join(data, 'tools')
    const zip = Buffer.from('zip-do-node'), sha256 = createHash('sha256').update(zip).digest('hex')
    const calls: Array<{ line: string; extra?: { env?: Record<string, string>; path?: string } | undefined }> = []
    let systemNode = false
    const runner: CommandRunner = { run: async (command, args, cwd, _timeout, extra) => {
      calls.push({ line: [command, ...args].join(' '), extra })
      if (command === 'node') { if (!systemNode) throw new Error('not found'); return 'v22.1.0' }
      if (command === 'tar') { mkdirSync(join(tools, 'node', 'node-v1.0.0-win-x64'), { recursive: true }); writeFileSync(join(tools, 'node', 'node-v1.0.0-win-x64', 'node.exe'), ''); return '' }
      if (args[0] === 'view') return '0.1.9\n'
      if (args[0] === 'install' && args.some((arg) => arg.startsWith('@playwright/cli@'))) { mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true }); writeFileSync(join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright-cli.cmd' : 'playwright-cli'), ''); return 'ok' }
      return 'ok'
    } }
    const fetchImpl = (async () => new Response(zip)) as unknown as typeof fetch
    const service = new PlaywrightCliService(database, history, runner, tools, { fetchImpl, node: { version: '1.0.0', url: 'http://example.invalid/node.zip', sha256 } })
    expect((await service.status(project.id)).versions).toEqual([])
    expect(service.forCard(card.id)).toBeNull()

    const first = await service.install({ projectId: project.id, version: '0.1.5', browser: true, skills: [] })
    expect(first.error).toBeNull()
    expect(first.versions.map((item) => item.version)).toEqual(['0.1.5']); expect(first.selected).toBe('0.1.5'); expect(first.enabled).toBe(true)
    expect(first.node.managed).toBe('1.0.0')
    const wrapper = readFileSync(first.versions[0]!.path, 'utf8')
    expect(wrapper).toContain(join(tools, 'node', 'node-v1.0.0-win-x64')); expect(wrapper).toContain(`PLAYWRIGHT_BROWSERS_PATH=${join(tools, 'playwright-browsers')}`)
    expect(first.versions[0]!.path.startsWith(tools)).toBe(true)
    const npm = calls.find((call) => call.line.includes('@playwright/cli@0.1.5'))!
    expect(npm.extra?.path).toBe(join(tools, 'node', 'node-v1.0.0-win-x64')); expect(npm.line).not.toMatch(/ -g\b|--global| -D\b/)
    expect(calls.find((call) => call.line.endsWith('install-browser'))?.extra?.env?.PLAYWRIGHT_BROWSERS_PATH).toBe(join(tools, 'playwright-browsers'))

    const second = await service.install({ projectId: project.id, version: 'latest', browser: false, skills: [] })
    expect(second.versions.map((item) => item.version)).toEqual(['0.1.9', '0.1.5']); expect(second.selected).toBe('0.1.9')
    expect(service.forCard(card.id)).toMatchObject({ comando: second.versions[0]!.path, sessao: `ab-${card.id.slice(0, 8)}` })
    expect((await service.select({ projectId: project.id, version: '0.1.5' })).selected).toBe('0.1.5')
    expect(service.forCard(card.id)?.comando).toBe(second.versions[1]!.path)
    await expect(service.select({ projectId: project.id, version: '9.9.9' })).rejects.toThrow(/9\.9\.9/)
    expect((await service.remove({ projectId: project.id, version: '0.1.5' })).selected).toBe('0.1.9')
    expect(existsSync(join(tools, 'playwright-cli', '0.1.5'))).toBe(false)
    expect((await service.install({ projectId: project.id, version: '../x', browser: false, skills: [] })).error).toMatch(/versão|version/i)

    systemNode = true
    const other = new PlaywrightCliService(database, history, runner, join(data, 'tools-b'), { fetchImpl, node: { version: '1.0.0', url: 'http://example.invalid/node.zip', sha256: 'f'.repeat(64) } })
    const withSystem = await other.install({ projectId: project.id, version: '0.1.5', browser: false, skills: [] })
    expect(withSystem.error).toBeNull(); expect(withSystem.node.managed).toBeNull()
    expect(readFileSync(withSystem.versions[0]!.path, 'utf8')).not.toContain('node-v1.0.0')
  })

  it('rejects the downloaded Node when the SHA-256 does not match', async () => {
    const { database, project, data } = await workspace()
    const history = new CardHistoryService(database, data), tools = join(data, 'tools-sha')
    const runner: CommandRunner = { run: async (command) => { if (command === 'node') throw new Error('not found'); return 'ok' } }
    const fetchImpl = (async () => new Response(Buffer.from('outro conteudo'))) as unknown as typeof fetch
    const service = new PlaywrightCliService(database, history, runner, tools, { fetchImpl, node: { version: '1.0.0', url: 'http://example.invalid/node.zip', sha256: 'a'.repeat(64) } })
    const result = await service.install({ projectId: project.id, version: '0.1.5', browser: false, skills: [] })
    expect(result.error).toMatch(/SHA-256/); expect(result.versions).toEqual([])
  })
})
