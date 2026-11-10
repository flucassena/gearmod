import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { BoardRepository, GitService, ProjectRepository } from './projects'
import { QualityService } from './quality'
import type { WorktreeService } from './worktrees'

const roots: string[] = [], opened: AppDatabase[] = []
afterEach(async () => {
  for (const database of opened.splice(0)) database.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

describe('automated tests running on a card', () => {
  it('shows on the card and counts as running in the sidebar until they finish; leftovers of a closed app become failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-tests-running-')); roots.push(root)
    const folder = join(root, 'folder'); await mkdir(folder)
    const database = new AppDatabase(join(root, 'data', 'db.sqlite'), '0.1.0'); await database.open(); opened.push(database)
    const projects = new ProjectRepository(database, new GitService())
    const project = await projects.create({ sourcePaths: [folder] })
    const board = new BoardRepository(database, projects)
    const card = board.create({ projectId: project.id, columnId: board.get(project.id).columns[0]!.id, sourceId: null, title: 'SKU', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    expect(board.card(card.id).testsRunning).toBe(false)
    expect(projects.list()[0]!.activity.running).toBe(0)

    database.db.prepare("INSERT INTO test_runs(id, card_id, command, status, summary, started_at) VALUES ('t1', ?, 'pnpm test', 'running', '', ?)").run(card.id, new Date().toISOString())
    expect(board.card(card.id).testsRunning).toBe(true)
    expect(projects.list()[0]!.activity).toMatchObject({ running: 1, alerts: [{ cardId: card.id, kind: 'running' }] })

    new QualityService(database, {} as WorktreeService).reconcileInterrupted()
    expect(board.card(card.id).testsRunning).toBe(false)
    expect(projects.list()[0]!.activity.running).toBe(0)
    expect(database.db.prepare("SELECT status FROM test_runs WHERE id = 't1'").pluck().get()).toBe('failed')
  })

  it('runs each changed repository command in its own folder of the card worktree, skipping unchanged and no-test repositories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-tests-repos-')); roots.push(root)
    const [api, web, docs] = ['api', 'web', 'docs'].map((name) => join(root, 'src', name))
    for (const folder of [api!, web!, docs!]) await mkdir(folder, { recursive: true })
    const database = new AppDatabase(join(root, 'data', 'db.sqlite'), '0.1.0'); await database.open(); opened.push(database)
    const projects = new ProjectRepository(database, new GitService())
    const project = await projects.create({ sourcePaths: [api!, web!, docs!] })
    const board = new BoardRepository(database, projects)
    const card = board.create({ projectId: project.id, columnId: board.get(project.id).columns[0]!.id, sourceId: null, title: 'Repos', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    const wt = join(root, 'wt'), member = (name: string): string => join(wt, `1-${name}`)
    for (const name of ['api', 'web', 'docs']) await mkdir(member(name), { recursive: true })
    const changed = new Set(['api', 'docs'])
    const worktrees = { get: () => ({ path: wt }), changedRepos: async () => [api!, web!, docs!].map((repoPath) => { const name = repoPath.split(/[\\/]/).at(-1)!; return { repoPath, path: member(name), changed: changed.has(name) } }) } as unknown as WorktreeService
    const quality = new QualityService(database, worktrees)
    await expect(quality.runCard(card.id)).rejects.toThrow()

    const ids = Object.fromEntries(quality.repoCommands(project.id).map((repo) => [repo.repo, repo.sourceId]))
    // The command proves where it ran: it writes a file in the current folder, then fails or passes.
    quality.setRepoCommand(project.id, ids.api!, { command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', process.env.GEARMOD_REPO)" && node -e "process.exit(3)"', name: 'API tests', applicable: true })
    quality.setRepoCommand(project.id, ids.web!, { command: 'node -e "process.exit(0)"', name: 'Web', applicable: true })
    quality.setRepoCommand(project.id, ids.docs!, { command: '', name: '', applicable: false })
    const plan = await quality.plan(card.id)
    expect(plan.repos.map((repo) => [repo.label, repo.changed])).toEqual([['API tests', true], ['Web', false]])

    const run = await quality.runCard(card.id)
    expect(run.status).toBe('failed'); expect(run.exitCode).toBe(3)
    expect(run.repos).toEqual([expect.objectContaining({ label: 'API tests', status: 'failed', exitCode: 3 }), expect.objectContaining({ label: 'Web', status: 'skipped' })])
    expect(readFileSync(join(member('api'), 'ran.txt'), 'utf8')).toBe('api')
    expect(quality.status(card.id).test?.repos).toEqual(run.repos)

    // Only the passing repository changed: the run passes; nothing with tests changed: it passes without running anything.
    changed.clear(); changed.add('web')
    expect((await quality.runCard(card.id)).status).toBe('passed')
    changed.clear(); changed.add('docs')
    const nothing = await quality.runCard(card.id)
    expect(nothing.status).toBe('passed'); expect(nothing.repos?.every((repo) => repo.status === 'skipped')).toBe(true)
  })
})
