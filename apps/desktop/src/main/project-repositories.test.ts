import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { GitManager } from './git-manager'
import { BoardRepository, GitService, ProjectRepository } from './projects'
import { WorktreeService } from './worktrees'

const exec = promisify(execFile), roots: string[] = [], opened: AppDatabase[] = []
afterEach(async () => {
  for (const database of opened.splice(0)) database.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

async function repo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await exec('git', ['init', '-b', 'main', dir])
  await exec('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', dir, 'config', 'user.name', 'GearMod Test'])
  await writeFile(join(dir, 'README.md'), '# fixture\n'); await exec('git', ['-C', dir, 'add', 'README.md']); await exec('git', ['-C', dir, 'commit', '-m', 'first'])
}

async function setup(): Promise<{ root: string; workspace: string; database: AppDatabase; projects: ProjectRepository; manager: GitManager }> {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-repos-')); roots.push(root)
  const workspace = join(root, 'workspace')
  await repo(join(workspace, 'back')); await repo(join(workspace, 'front'))
  const database = new AppDatabase(join(root, 'data', 'db.sqlite'), '0.1.0'); await database.open(); opened.push(database)
  return { root, workspace, database, projects: new ProjectRepository(database, new GitService()), manager: new GitManager(database) }
}

describe('repositories of a project', () => {
  it('leaves out the repositories excluded on creation, and the folder scan does not bring them back', async () => {
    const { workspace, projects, manager } = await setup()
    const project = await projects.create({ sourcePaths: [workspace], excludePaths: [join(workspace, 'front')] })
    expect(project.sources.map((source) => source.name)).toEqual(['back'])
    const found = await manager.detect(project.id)
    expect(found.repos.map((item) => item.name)).toEqual(['back'])
  })

  it('keeps at least one repository on creation', async () => {
    const { workspace, projects } = await setup()
    await expect(projects.create({ sourcePaths: [workspace], excludePaths: [join(workspace, 'front'), join(workspace, 'back')] })).rejects.toThrow()
  })

  it('adds repositories later (the excluded one comes back) and removes them without touching the folder', async () => {
    const { workspace, projects, manager } = await setup()
    const project = await projects.create({ sourcePaths: [workspace], excludePaths: [join(workspace, 'front')] })
    const added = await projects.addRepositories(project.id, join(workspace, 'front'))
    expect(added.sources.map((source) => source.name).sort()).toEqual(['back', 'front'])
    await expect(projects.addRepositories(project.id, join(workspace, 'front'))).rejects.toThrow()
    await expect(projects.addRepositories(project.id, join(workspace, '..'))).rejects.toThrow()  // no repository there
    const back = added.sources.find((source) => source.name === 'back')!
    const removed = projects.removeRepository(project.id, back.id)
    expect(removed.sources.map((source) => source.name)).toEqual(['front'])
    expect((await manager.detect(project.id)).repos.map((item) => item.name)).toEqual(['front'])  // stays out
    await expect(access(join(workspace, 'back', 'README.md'))).resolves.toBeUndefined()
    expect(() => projects.removeRepository(project.id, removed.sources[0]!.id)).toThrow()  // the last one stays
  })

  it('refuses to remove a repository that still has a card worktree, and cards that pointed at it fall back to the default', async () => {
    const { workspace, root, database, projects } = await setup()
    const project = await projects.create({ sourcePaths: [workspace] })
    const board = new BoardRepository(database, projects), column = board.get(project.id).columns[0]!
    const [first, second] = [...project.sources].sort((a, b) => a.name.localeCompare(b.name))
    const busy = board.create({ projectId: project.id, columnId: column.id, sourceId: first!.id, title: 'Busy', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    board.setRepos(busy.id, [first!.id])  // without a choice, the worktree would take every repository
    await new WorktreeService(database, join(root, 'data')).prepare(busy.id)
    expect(() => projects.removeRepository(project.id, first!.id)).toThrow(/Busy/)
    const other = board.create({ projectId: project.id, columnId: column.id, sourceId: second!.id, title: 'Other', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    const after = projects.removeRepository(project.id, second!.id)
    expect(after.sources.map((source) => source.id)).toEqual([first!.id])
    expect(board.card(other.id).sourceId).toBeNull()
  })
})
