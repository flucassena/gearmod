import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultGitPolicy, errorCodeOf } from '@gearmod/contracts'
import { ConversationRepository } from './conversations'
import { AppDatabase } from './database'
import { assignLanes, friendlyError, GitManager, resolveRule } from './git-manager'
import { CommitConventionStore } from './commit-conventions'
import { BoardRepository, GitService, ProfileRepository, ProjectRepository } from './projects'
import { seedProfiles } from './test-helpers'
import { WorktreeService } from './worktrees'

const exec = promisify(execFile), roots: string[] = [], opened: AppDatabase[] = []
afterEach(async () => { opened.splice(0).forEach((item) => item.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))) })

const git = (dir: string, ...args: string[]): Promise<{ stdout: string }> => exec('git', ['-C', dir, ...args])

async function setup(): Promise<{ root: string; repo: string; database: AppDatabase; manager: GitManager; projectId: string; sourceId: string; cardId: string; wt: string; branch: string; chatId: string; profileId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-gitm-')); roots.push(root)
  const repo = join(root, 'repo'), data = join(root, 'data')
  await exec('git', ['init', '-b', 'main', repo])
  await git(repo, 'config', 'user.email', 'test@example.invalid'); await git(repo, 'config', 'user.name', 'GearMod Test'); await git(repo, 'config', 'core.autocrlf', 'false')
  await writeFile(join(repo, 'README.md'), '# fixture\n'); await git(repo, 'add', 'README.md'); await git(repo, 'commit', '-m', 'primeiro')
  const database = new AppDatabase(join(data, 'db.sqlite'), '0.1.0'); await database.open(); opened.push(database)
  const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
  const projects = new ProjectRepository(database, new GitService()), project = await projects.create({ localPath: repo })
  const board = new BoardRepository(database, projects), column = board.get(project.id).columns[0]!
  const card = board.create({ projectId: project.id, columnId: column.id, title: 'Tela de teste', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
  const worktree = await new WorktreeService(database, data).prepare(card.id)
  const member = database.db.prepare('SELECT path FROM worktree_members WHERE worktree_id = ?').get(worktree.id) as { path: string }
  const source = database.db.prepare('SELECT id FROM project_sources WHERE project_id = ?').get(project.id) as { id: string }
  const profileId = profiles.list()[0]!.id
  projects.setProfiles(project.id, [profileId])
  const chatId = new ConversationRepository(database).createChat({ projectId: project.id, cardId: card.id, purpose: 'execution', profileId }).id
  return { root, repo, database, manager: new GitManager(database), projectId: project.id, sourceId: source.id, cardId: card.id, wt: member.path, branch: worktree.branch, chatId, profileId }
}

describe('assignLanes', () => {
  it('keeps linear history in one lane and opens another for the branch', () => {
    // top → base: merge(m) joins a (lane 0) and b (lane 1); base is the parent of both.
    const lanes = assignLanes([
      { hash: 'm', parents: ['a', 'b'] }, { hash: 'a', parents: ['base'] }, { hash: 'b', parents: ['base'] }, { hash: 'base', parents: [] }
    ])
    expect(lanes).toEqual([0, 0, 1, 0])
  })

  it('the main history stays in the left lane even after a branch that reaches it', () => {
    // main: m2 → base; feature: f → base (f is older than m2 in log order)
    const lanes = assignLanes([{ hash: 'merge', parents: ['m2', 'f'] }, { hash: 'f', parents: ['base'] }, { hash: 'm2', parents: ['base'] }, { hash: 'base', parents: [] }])
    expect(lanes).toEqual([0, 1, 0, 0])
  })

  it('the parent lane stays reserved until it appears', () => {
    const lanes = assignLanes([
      { hash: 'tip1', parents: ['x'] }, { hash: 'tip2', parents: ['x'] }, { hash: 'x', parents: ['y'] }, { hash: 'z', parents: [] }
    ])
    expect(lanes).toEqual([0, 1, 0, 1])
  })
})

describe('agent commit rule', () => {
  it('project default: ask permission, exception never on main, develop and release/*', () => {
    expect(resolveRule(defaultGitPolicy, 'gearmod/tela-1234')).toEqual({ rule: 'ask', why: 'padrão do projeto' })
    expect(resolveRule(defaultGitPolicy, 'main')).toEqual({ rule: 'never', why: 'exceção da branch main' })
    expect(resolveRule(defaultGitPolicy, 'develop').rule).toBe('never')
    expect(resolveRule(defaultGitPolicy, 'release/1.2').rule).toBe('never')
    expect(resolveRule(defaultGitPolicy, 'releases').rule).toBe('ask')
  })

  it('the first matching exception wins and * covers any segment', () => {
    const policy = { def: 'auto' as const, rules: [{ pattern: 'gearmod/*-x', rule: 'never' as const }, { pattern: 'gearmod/*', rule: 'ask' as const }, { pattern: '  ', rule: 'never' as const }] }
    expect(resolveRule(policy, 'gearmod/a-x').rule).toBe('never')
    expect(resolveRule(policy, 'gearmod/a-y').rule).toBe('ask')
    expect(resolveRule(policy, 'feature/z').rule).toBe('auto')
  })

  it('stores the rule in the database and falls back to the default when nothing is saved', async () => {
    const { manager, projectId } = await setup()
    expect(manager.policy(projectId)).toEqual(defaultGitPolicy)
    const saved = manager.setPolicy(projectId, { def: 'auto', rules: [{ pattern: ' hotfix/* ', rule: 'ask' }, { pattern: '', rule: 'never' }] })
    expect(saved).toEqual({ def: 'auto', mergeMethod: 'merge', rules: [{ pattern: 'hotfix/*', rule: 'ask' }] })
    expect(manager.policy(projectId)).toEqual(saved)
    expect(manager.ruleFor(projectId, 'hotfix/1')).toEqual({ rule: 'ask', why: 'exceção da branch hotfix/*' })
    expect(manager.setPolicy(projectId, { def: 'ask', rules: [], mergeMethod: 'rebase' }).mergeMethod).toBe('rebase')
    expect(manager.policy(projectId).mergeMethod).toBe('rebase')
  })

  it('translates common Git errors', () => {
    expect(errorCodeOf(friendlyError(new Error('! [rejected] main -> main (non-fast-forward)')))).toBe('git-push-rejected')
    expect(friendlyError(new Error('fatal: unable to auto-detect email address'))).toContain('não sabe quem você é')
    expect(friendlyError(Object.assign(new Error('x'), { stderr: '! [rejected] main -> main (non-fast-forward)' }))).toContain('Faça Pull')
  })
})

describe('GitManager with real repositories', () => {
  it('discards only the unstaged part, including new files', async () => {
    const { manager, sourceId, cardId, wt } = await setup()
    await writeFile(join(wt, 'README.md'), 'preparado\n'); await manager.stage(sourceId, cardId, ['README.md'], true)
    await writeFile(join(wt, 'README.md'), 'não preparado\n'); await writeFile(join(wt, 'novo.txt'), 'novo\n')
    await manager.discardUnstaged(sourceId, cardId, ['README.md', 'novo.txt'])
    expect(await readFile(join(wt, 'README.md'), 'utf8')).toBe('preparado\n')
    await expect(readFile(join(wt, 'novo.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await manager.changes(sourceId, cardId)).files).toMatchObject([{ path: 'README.md', staged: true }])
  })

  it('stashes only the chosen file and creates ignore rules', async () => {
    const { manager, sourceId, cardId, wt, projectId } = await setup()
    await mkdir(join(wt, 'pasta')); await writeFile(join(wt, 'pasta', 'novo.txt'), 'novo\n'); await writeFile(join(wt, 'outro.txt'), 'outro\n')
    await manager.stashFile(sourceId, cardId, 'pasta/novo.txt')
    const graph = await manager.graph(projectId, sourceId, 300, cardId), stashRow = graph.rows.find((row) => row.stash)
    expect(stashRow?.stash?.ref).toBe('stash@{0}')
    expect(graph.rows.findIndex((row) => row.hash === stashRow?.parents[0])).toBeGreaterThan(graph.rows.indexOf(stashRow!))
    expect((await manager.stashDetail(sourceId, cardId, stashRow!.stash!.ref, stashRow!.stash!.commit)).files.map((file) => file.path)).toEqual(['pasta/novo.txt'])
    await manager.renameStash(sourceId, cardId, stashRow!.stash!.ref, stashRow!.stash!.commit, 'Nome novo')
    expect((await manager.graph(projectId, sourceId, 300, cardId)).stashes[0]?.message).toBe('Nome novo')
    expect((await manager.changes(sourceId, cardId)).files.map((file) => file.path)).toEqual(['outro.txt'])
    await git(wt, 'stash', 'pop'); expect(await readFile(join(wt, 'pasta', 'novo.txt'), 'utf8')).toBe('novo\n')
    await manager.ignoreFile(sourceId, cardId, 'pasta/novo.txt', 'directory')
    expect(await readFile(join(wt, '.gitignore'), 'utf8')).toBe('/pasta/\n')
    expect((await manager.changes(sourceId, cardId)).files.map((file) => file.path)).toEqual(['.gitignore', 'outro.txt'])
  })
  it('stash from the bar counts new files and a pop with a conflict enters the conflicts screen without losing the stash', async () => {
    const { manager, sourceId, cardId, wt, projectId } = await setup()
    await writeFile(join(wt, 'README.md'), '# do stash\n'); await writeFile(join(wt, 'novo.txt'), 'novo\n')
    expect((await manager.sync(sourceId, cardId, 'stash')).output).toMatch(/1 arquivo novo/)
    expect((await manager.sync(sourceId, cardId, 'stash')).output).toMatch(/Não há alterações/)
    await writeFile(join(wt, 'README.md'), '# do commit\n'); await git(wt, 'commit', '-am', 'muda o README')
    const popped = await manager.sync(sourceId, cardId, 'pop')
    expect(popped.conflicts).toBe(1); expect(popped.output).toMatch(/stash foi mantido/)
    expect(await manager.conflicts(sourceId, cardId)).toEqual({ operation: 'stash', files: ['README.md'] })
    expect((await manager.conflictsAll(projectId)).map((item) => item.operation)).toEqual(['stash'])
    await expect(manager.finishConflicts(sourceId, 'abort', cardId)).rejects.toThrow(/não pode ser cancelado/)
    expect((await manager.resolveConflict(sourceId, 'README.md', 'ours', cardId)).left).toBe(0)
    expect(await manager.conflicts(sourceId, cardId)).toEqual({ operation: null, files: [] })
    expect(await readFile(join(wt, 'README.md'), 'utf8')).toBe('# do commit\n')
    expect((await git(wt, 'stash', 'list')).stdout.trim().split('\n')).toHaveLength(1)
  })

  it('changes only the last commit message, preserving the body and the index', async () => {
    const { manager, sourceId, cardId, wt } = await setup()
    await writeFile(join(wt, 'README.md'), 'preparado\n'); await manager.stage(sourceId, cardId, ['README.md'], true)
    const before = (await git(wt, 'rev-parse', 'HEAD')).stdout.trim()
    const result = await manager.renameCommit({ sourceId, cardId, hash: before, message: 'Novo resumo' })
    expect(result.hash).not.toBe(before)
    expect((await git(wt, 'show', '-s', '--format=%s')).stdout.trim()).toBe('Novo resumo')
    expect((await git(wt, 'show', 'HEAD:README.md')).stdout).toBe('# fixture\n')
    expect((await git(wt, 'show', ':README.md')).stdout).toBe('preparado\n')
    await expect(manager.renameCommit({ sourceId, cardId, hash: before, message: 'Antigo' })).rejects.toThrow(/último commit/)
  })
  it('also lists worktrees made outside GearMod, without the main folder or the card worktree', async () => {
    const { manager, projectId, sourceId, repo, wt } = await setup()
    const outside = join(repo, '..', 'outside-wt')
    await git(repo, 'worktree', 'add', '-b', 'feature/outside', outside)
    const graph = await manager.graph(projectId, sourceId)
    expect(graph.externalWorktrees).toHaveLength(1)
    expect(graph.externalWorktrees[0]).toMatchObject({ branch: 'feature/outside', detached: false })
    expect(graph.externalWorktrees[0]!.path.endsWith('outside-wt')).toBe(true)
    expect(graph.worktrees.map((item) => item.path)).toEqual([wt])
  })
  it('deletes a worktree made outside GearMod with its branch, reporting what would be lost first; never a card worktree', async () => {
    const { manager, projectId, sourceId, repo, wt } = await setup()
    const outside = join(repo, '..', 'outside-del')
    await git(repo, 'worktree', 'add', '-b', 'feature/outside-del', outside)
    await writeFile(join(outside, 'loose.txt'), 'x')
    expect(await manager.externalWorktreeInfo(sourceId, outside)).toMatchObject({ branch: 'feature/outside-del', files: 1 })
    await expect(manager.deleteExternalWorktree(sourceId, wt, true)).rejects.toThrow()
    expect(await manager.deleteExternalWorktree(sourceId, outside, true)).toMatchObject({ keptBranches: [] })
    await expect(access(outside)).rejects.toThrow()
    expect((await manager.graph(projectId, sourceId)).externalWorktrees).toEqual([])
    expect((await git(repo, 'branch', '--list', 'feature/outside-del')).stdout.trim()).toBe('')
  })
  it('deleting a worktree never empties what its node_modules junctions point to', async () => {
    const { manager, sourceId, repo } = await setup()
    const outside = join(repo, '..', 'outside-junction'), shared = join(repo, '..', 'shared-pkg')
    await git(repo, 'worktree', 'add', '-b', 'feature/outside-junction', outside)
    await mkdir(shared, { recursive: true }); await writeFile(join(shared, 'index.js'), 'keep')
    await mkdir(join(outside, 'node_modules'), { recursive: true })
    await symlink(shared, join(outside, 'node_modules', 'pkg'), 'junction')
    await manager.deleteExternalWorktree(sourceId, outside, false)
    await expect(access(outside)).rejects.toThrow()
    expect(await readFile(join(shared, 'index.js'), 'utf8')).toBe('keep')
  })

  it('lets a card adopt a worktree made by hand, and letting it go never deletes the folder or the branch', async () => {
    const { database, manager, projectId, sourceId, repo, root } = await setup()
    const outside = join(root, 'by-hand')
    await git(repo, 'worktree', 'add', '-b', 'feature/by-hand', outside)
    await writeFile(join(outside, 'mine.txt'), 'mine\n')
    const projects = new ProjectRepository(database, new GitService()), board = new BoardRepository(database, projects), column = board.get(projectId).columns[0]!
    const card = board.create({ projectId, columnId: column.id, title: 'Uses it', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    const service = new WorktreeService(database, join(root, 'data'))
    expect((await service.startOptions(projectId)).external.map((item) => item.branch)).toEqual(['feature/by-hand'])
    // Only what Git lists as a worktree of the project can be opened or adopted, never an arbitrary folder.
    expect((await service.findExternal(projectId, outside))?.branch).toBe('feature/by-hand')
    expect(await service.findExternal(projectId, root)).toBeUndefined()
    await service.adopt(card.id, outside)
    expect(service.isExternal(card.id)).toBe(true)
    // Used as it is: nothing is created, renamed or added inside the user's folder.
    const used = await service.prepare(card.id)
    expect(used.path.endsWith('by-hand')).toBe(true); expect(used.branch).toBe('feature/by-hand')
    expect((await service.ensureMember(card.id, sourceId)).status).toBe('active')
    expect((await manager.graph(projectId, sourceId)).externalWorktrees).toEqual([])  // it is the card's now
    expect((await service.startOptions(projectId)).external).toEqual([])
    const result = await manager.deleteWorktree(projectId, card.id, true)
    expect(result.keptBranches).toEqual([])
    await expect(access(join(outside, 'mine.txt'))).resolves.toBeUndefined()
    expect((await git(repo, 'branch', '--list', 'feature/by-hand')).stdout.trim()).not.toBe('')
    expect(service.isExternal(card.id)).toBe(false)
    expect((await service.startOptions(projectId)).external.map((item) => item.branch)).toEqual(['feature/by-hand'])  // free to be adopted again
  })

  it('does not adopt a worktree on a detached HEAD, one that is gone, or when the card already has a worktree', async () => {
    const { database, projectId, repo, root, cardId } = await setup()
    const detached = join(root, 'detached')
    await git(repo, 'worktree', 'add', '--detach', detached)
    const projects = new ProjectRepository(database, new GitService()), board = new BoardRepository(database, projects), column = board.get(projectId).columns[0]!
    const card = board.create({ projectId, columnId: column.id, title: 'Other', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    const service = new WorktreeService(database, join(root, 'data'))
    await expect(service.adopt(card.id, detached)).rejects.toThrow(/detached|HEAD/i)
    await expect(service.adopt(card.id, join(root, 'nowhere'))).rejects.toThrow()
    const outside = join(root, 'by-hand')
    await git(repo, 'worktree', 'add', '-b', 'feature/by-hand', outside)
    await expect(service.adopt(cardId, outside)).rejects.toThrow()
  })

  it('lists repositories, graph with the card commits, WIP and worktrees', async () => {
    const { manager, projectId, sourceId, cardId, wt, branch, repo } = await setup()
    const repos = await manager.repos(projectId)
    expect(repos).toHaveLength(1); expect(repos[0]).toMatchObject({ sourceId, name: 'repo', head: 'main', hasRemote: false })
    await writeFile(join(wt, 'a.txt'), 'um\ndois\n'); await git(wt, 'add', 'a.txt'); await git(wt, 'commit', '-m', 'Card: cria a.txt')
    await writeFile(join(wt, 'b.txt'), 'novo\n')
    await writeFile(join(repo, 'README.md'), '# fixture\nmudou\n')
    await git(repo, 'stash'); await writeFile(join(repo, 'README.md'), '# fixture\nde novo\n')
    const graph = await manager.graph(projectId, sourceId)
    const commits = graph.rows.filter((row) => !row.wip && !row.stash)
    expect(commits.map((row) => row.subject)).toEqual(['Card: cria a.txt', 'primeiro'])
    expect(commits[0]).toMatchObject({ cardId, author: 'GearMod Test', agentProfileId: null }); expect(commits[0]!.refs.some((ref) => ref.name === branch)).toBe(true)
    expect(commits[1]!.cardId).toBeNull(); expect(commits[1]!.refs).toContainEqual({ name: 'main', kind: 'head' })
    const wips = graph.rows.filter((row) => row.wip)
    expect(wips.map((row) => row.cardId)).toEqual([null, cardId])
    expect(wips[0]!.wip).toMatchObject({ modified: 1, added: 0, deleted: 0, branch: 'main' }); expect(wips[1]!.wip).toMatchObject({ added: 1, branch })
    expect(graph.rows[0]).toMatchObject({ hash: 'wip:main' })
    expect(Math.max(...graph.rows.map((row) => row.lane))).toBeGreaterThanOrEqual(1)
    expect(graph.worktrees).toEqual([{ cardId, title: 'Tela de teste', branch, path: wt }])
    expect(graph.branches.local.find((item) => item.name === branch)?.cardId).toBe(cardId)
    expect(graph.stashes).toHaveLength(1); expect(graph.truncated).toBe(false)
    expect((await manager.graph(projectId, sourceId, 20)).rows.filter((row) => !row.wip && !row.stash)).toHaveLength(2)
  })

  it('stage, unstage, diff, commit and amend in the card worktree', async () => {
    const { manager, sourceId, cardId, wt } = await setup()
    await writeFile(join(wt, 'x.txt'), 'x1\nx2\nx3\n'); await writeFile(join(wt, 'y.txt'), 'y\n'); await writeFile(join(wt, 'README.md'), '# fixture\nmais\n')
    let state = await manager.changes(sourceId, cardId)
    expect(state.files.map((file) => [file.path, file.status, file.staged, file.additions, file.deletions])).toEqual([['README.md', 'M', false, 1, 0], ['x.txt', 'A', false, 3, 0], ['y.txt', 'A', false, 1, 0]])
    state = await manager.stage(sourceId, cardId, ['x.txt'], true)
    expect(state.files.filter((file) => file.staged).map((file) => file.path)).toEqual(['x.txt'])
    expect(await manager.diff(sourceId, cardId, 'y.txt', false)).toContain('+y')
    expect(await manager.diff(sourceId, cardId, 'README.md', false)).toContain('+mais')
    state = await manager.stage(sourceId, cardId, ['x.txt'], false)
    expect(state.files.some((file) => file.staged)).toBe(false)
    await expect(manager.commit({ sourceId, cardId, message: 'vazio' })).rejects.toThrow('nada preparado')
    await manager.stage(sourceId, cardId, [], true)
    const { hash } = await manager.commit({ sourceId, cardId, message: 'Adiciona x e y', description: 'Detalhe do commit' })
    expect((await git(wt, 'log', '-1', '--format=%s|%b')).stdout.trim()).toBe('Adiciona x e y|Detalhe do commit')
    expect((await manager.changes(sourceId, cardId))).toMatchObject({ files: [], lastMessage: 'Adiciona x e y' })
    await writeFile(join(wt, 'z.txt'), 'z\n'); await manager.stage(sourceId, cardId, ['z.txt'], true)
    const amended = await manager.commit({ sourceId, cardId, message: 'Adiciona x, y e z', amend: true })
    expect(amended.hash).not.toBe(hash)
    expect((await git(wt, 'rev-list', '--count', 'HEAD')).stdout.trim()).toBe('2')
    const detail = await manager.commitDetail(sourceId, amended.hash)
    expect(detail.files.map((file) => [file.path, file.status, file.additions]).sort()).toEqual([['README.md', 'M', 1], ['x.txt', 'A', 3], ['y.txt', 'A', 1], ['z.txt', 'A', 1]])
    const root = await manager.commitDetail(sourceId, (await git(wt, 'rev-list', '--max-parents=0', 'HEAD')).stdout.trim())
    expect(root.files).toEqual([{ path: 'README.md', status: 'A', additions: 1, deletions: 0 }])
  })

  it('committing only the chosen paths leaves the rest uncommitted; sync without a remote warns', async () => {
    const { manager, sourceId, cardId, wt } = await setup()
    await writeFile(join(wt, 'um.txt'), '1\n'); await writeFile(join(wt, 'dois.txt'), '2\n')
    await manager.commit({ sourceId, cardId, message: 'Só o um', paths: ['um.txt'] })
    expect((await manager.changes(sourceId, cardId)).files.map((file) => file.path)).toEqual(['dois.txt'])
    await expect(manager.sync(sourceId, cardId, 'push')).rejects.toThrow('não tem remoto')
    await expect(manager.stage(sourceId, null, [], true)).resolves.toBeDefined()
  })

  it('a commit with more than 400 paths still includes only them (D4)', async () => {
    const { manager, sourceId, cardId, wt } = await setup()
    const names = Array.from({ length: 450 }, (_, i) => `arq-${i}.txt`)
    await Promise.all(names.map((name) => writeFile(join(wt, name), 'x\n')))
    await writeFile(join(wt, 'fora.txt'), 'f\n')
    await git(wt, 'add', 'fora.txt')
    await manager.commit({ sourceId, cardId, message: 'Muitos arquivos', paths: names })
    expect((await git(wt, 'show', '--name-only', '--format=', 'HEAD')).stdout.split('\n').filter(Boolean)).toHaveLength(450)
    expect((await manager.changes(sourceId, cardId)).files.map((file) => file.path)).toEqual(['fora.txt'])
  })

  it('hard reset and deleting a stash leave a recoverable copy (D3)', async () => {
    const { manager, sourceId, cardId, wt } = await setup()
    const head = (await git(wt, 'rev-parse', 'HEAD')).stdout.trim()
    await writeFile(join(wt, 'README.md'), 'alterado e nao commitado\n')
    const reset = await manager.commitAction(sourceId, { cardId, action: 'reset-hard', hash: head })
    expect(reset.output).toContain('refs/gearmod/backup/reset-')
    expect(await readFile(join(wt, 'README.md'), 'utf8')).not.toContain('alterado')
    const ref = (await git(wt, 'for-each-ref', '--format=%(refname)', 'refs/gearmod/backup/')).stdout.trim()
    expect((await git(wt, 'show', `${ref}:README.md`)).stdout).toContain('alterado e nao commitado')
    await writeFile(join(wt, 'README.md'), 'para o stash\n'); await manager.sync(sourceId, cardId, 'stash')
    const dropped = await manager.stashAction(sourceId, { cardId, action: 'drop', ref: 'stash@{0}' })
    expect(dropped.output).toContain('refs/gearmod/backup/stash-')
  })

  it('publishes the card branch, shows the panel and updates with fetch and pull', async () => {
    const { manager, projectId, root, sourceId, cardId, wt, branch, repo } = await setup()
    const remote = join(root, 'remote.git'); await mkdir(remote); await exec('git', ['init', '--bare', '-b', 'main', remote])
    await git(repo, 'remote', 'add', 'origin', remote); await git(repo, 'push', '-u', 'origin', 'main')
    await writeFile(join(wt, 'p.txt'), 'p\n'); await manager.commit({ sourceId, cardId, message: 'Primeira do card', paths: ['p.txt'] })
    await writeFile(join(wt, 'q.txt'), 'q\n')
    let card = await manager.card(cardId)
    expect(card).toMatchObject({ branch, baseBranch: 'main', rule: { rule: 'ask' } })
    expect(card.repos[0]).toMatchObject({ ahead: 1, behind: 0, published: false, hasRemote: true })
    expect(card.repos[0]!.commits.map((item) => item.subject)).toEqual(['Primeira do card']); expect(card.repos[0]!.files.map((file) => file.path)).toEqual(['q.txt'])
    expect((await manager.sync(sourceId, cardId, 'push')).output).toBeTypeOf('string')
    card = await manager.card(cardId); expect(card.repos[0]!.published).toBe(true)
    await manager.sync(sourceId, null, 'fetch')
    expect((await manager.graph(projectId, sourceId)).branches.remote.map((item) => item.name)).toContain(`origin/${branch}`)
    await manager.sync(sourceId, null, 'pull')
  })

  it('pushes and pulls a picked branch that is not the one checked out, without switching branches', async () => {
    const { manager, root, sourceId, repo } = await setup()
    const remote = join(root, 'remote.git'); await mkdir(remote); await exec('git', ['init', '--bare', '-b', 'main', remote])
    await git(repo, 'remote', 'add', 'origin', remote); await git(repo, 'push', '-u', 'origin', 'main')
    await git(repo, 'branch', 'lateral'); await git(repo, 'worktree', 'add', join(root, 'lateral-wt'), 'lateral')
    await writeFile(join(root, 'lateral-wt', 'l.txt'), 'l'); await git(join(root, 'lateral-wt'), 'add', 'l.txt'); await git(join(root, 'lateral-wt'), 'commit', '-m', 'Commit lateral')
    await git(repo, 'worktree', 'remove', '--force', join(root, 'lateral-wt'))
    // Main folder is on `main`; Push with the picked branch publishes `lateral` and leaves `main` checked out.
    await manager.sync(sourceId, null, 'push', 'ff-only', false, 'lateral')
    expect((await exec('git', ['ls-remote', '--heads', remote, 'lateral'])).stdout).toContain('refs/heads/lateral')
    expect((await exec('git', ['-C', repo, 'branch', '--show-current'])).stdout.trim()).toBe('main')
    // Someone else advances `lateral` on the remote; Pull with the picked branch fast-forwards it without checking it out.
    const other = join(root, 'other'); await exec('git', ['clone', '-b', 'lateral', remote, other])
    await git(other, 'config', 'user.email', 'o@o.o'); await git(other, 'config', 'user.name', 'o')
    await writeFile(join(other, 'm.txt'), 'm'); await git(other, 'add', 'm.txt'); await git(other, 'commit', '-m', 'Remoto avancou'); await git(other, 'push', 'origin', 'lateral')
    await manager.sync(sourceId, null, 'pull', 'ff-only', false, 'lateral')
    expect((await exec('git', ['-C', repo, 'log', '-1', '--format=%s', 'lateral'])).stdout.trim()).toBe('Remoto avancou')
    expect((await exec('git', ['-C', repo, 'branch', '--show-current'])).stdout.trim()).toBe('main')
  })

  it('rebasing the card branch onto another branch does not mix its commits into the card ones', async () => {
    const { manager, projectId, sourceId, cardId, wt, repo } = await setup()
    await git(repo, 'branch', 'outra'); await git(repo, 'worktree', 'add', join(repo, '..', 'outra'), 'outra')
    await writeFile(join(repo, '..', 'outra', 'o.txt'), 'o\n'); await git(join(repo, '..', 'outra'), 'add', 'o.txt'); await git(join(repo, '..', 'outra'), 'commit', '-m', 'Commit da outra')
    await writeFile(join(wt, 'c.txt'), 'c\n'); await manager.commit({ sourceId, cardId, message: 'Commit do card', paths: ['c.txt'] })
    await git(wt, 'rebase', 'outra')
    expect((await manager.card(cardId)).repos[0]!.commits.map((item) => item.subject)).toEqual(['Commit do card'])
    const graph = await manager.graph(projectId, sourceId)
    expect(graph.rows.filter((item) => item.cardId === cardId).map((item) => item.subject)).toEqual(['Commit do card'])
    expect(graph.branches.local.map((item) => item.name)).toEqual(expect.arrayContaining(['main', 'outra']))
  })
})

describe('delete card worktree', () => {
  const folderExists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

  it('reports unpushed commits and uncommitted files', async () => {
    const { manager, projectId, sourceId, cardId, wt, branch } = await setup()
    expect((await manager.worktreeInfo(projectId, cardId)).repos[0]).toMatchObject({ unpushed: 0, files: 0, branch })
    await writeFile(join(wt, 'c.txt'), 'c\n'); await manager.commit({ sourceId, cardId, message: 'Commit do card', paths: ['c.txt'] })
    await writeFile(join(wt, 'solto.txt'), 's\n')
    expect((await manager.worktreeInfo(projectId, cardId)).repos[0]).toMatchObject({ unpushed: 1, files: 1 })
  })

  it('deletes the folder, keeps the branch with unpushed commits and preserves the card', async () => {
    const { manager, database, projectId, sourceId, cardId, wt, branch, repo } = await setup()
    await writeFile(join(wt, 'c.txt'), 'c\n'); await manager.commit({ sourceId, cardId, message: 'Commit do card', paths: ['c.txt'] })
    const refreshed: string[] = []; manager.onWorktreeDeleted = (id) => refreshed.push(id)
    const out = await manager.deleteWorktree(projectId, cardId, false)
    expect(out.keptBranches).toEqual([])
    // every window is told, so an open card stops showing the deleted worktree
    expect(refreshed).toEqual([cardId])
    expect(await folderExists(wt)).toBe(false)
    expect((await git(repo, 'branch', '--list', branch)).stdout).toContain(branch)
    expect(database.db.prepare('SELECT cleanup_state FROM worktrees WHERE card_id = ?').pluck().get(cardId)).toBe('removed')
    expect(database.db.prepare('SELECT COUNT(*) FROM cards WHERE id = ?').pluck().get(cardId)).toBe(1)
    expect((await manager.graph(projectId, sourceId)).worktrees).toEqual([])
    await expect(manager.deleteWorktree(projectId, cardId, false)).rejects.toThrow()
  })

  it('keeps a branch with commits outside the base unless the deletion is forced', async () => {
    const kept = await setup()
    await writeFile(join(kept.wt, 'c.txt'), 'c\n'); await kept.manager.commit({ sourceId: kept.sourceId, cardId: kept.cardId, message: 'Commit do card', paths: ['c.txt'] })
    expect((await kept.manager.deleteWorktree(kept.projectId, kept.cardId, true)).keptBranches).toEqual([kept.branch])
    const forced = await setup()
    await writeFile(join(forced.wt, 'c.txt'), 'c\n'); await forced.manager.commit({ sourceId: forced.sourceId, cardId: forced.cardId, message: 'Commit do card', paths: ['c.txt'] })
    expect((await forced.manager.deleteWorktree(forced.projectId, forced.cardId, true, undefined, true)).keptBranches).toEqual([])
    expect((await git(forced.repo, 'branch', '--list', forced.branch)).stdout.trim()).toBe('')
  })

  it('deletes the branch too when requested', async () => {
    const { manager, projectId, cardId, wt, branch, repo } = await setup()
    await writeFile(join(wt, 'solto.txt'), 's\n')
    await manager.deleteWorktree(projectId, cardId, true)
    expect(await folderExists(wt)).toBe(false)
    expect((await git(repo, 'branch', '--list', branch)).stdout.trim()).toBe('')
  })

  it('deleting only one repository folder: with no other folders, the whole worktree goes away; with a sourceId coming from a card without projectId', async () => {
    const { manager, database, projectId, sourceId, cardId, wt } = await setup()
    expect(manager.projectOfCard(cardId)).toBe(projectId)
    expect((await manager.worktreeInfo(projectId, cardId, sourceId)).repos).toHaveLength(1)
    await manager.deleteWorktree(projectId, cardId, false, sourceId)
    expect(await folderExists(wt)).toBe(false)
    expect(database.db.prepare('SELECT COUNT(*) FROM worktree_members').pluck().get()).toBe(0)
    expect(database.db.prepare('SELECT cleanup_state FROM worktrees WHERE card_id = ?').pluck().get(cardId)).toBe('removed')
  })

  it('refuses while a card agent is running', async () => {
    const { manager, database, projectId, cardId, wt, chatId, profileId } = await setup()
    database.db.prepare(`INSERT INTO runs(id, card_id, chat_id, profile_id, status, started_at) VALUES ('11111111-1111-4111-8111-111111111111', ?, ?, ?, 'running', ?)`).run(cardId, chatId, profileId, new Date().toISOString())
    await expect(manager.deleteWorktree(projectId, cardId, true)).rejects.toThrow(/agente/i)
    expect(await folderExists(wt)).toBe(true)
  })
})

describe('agent lock on Git page actions (D1)', () => {
  it('with an agent running on the card, actions that touch files are refused; reading and fetch continue', async () => {
    const { manager, database, sourceId, cardId, wt, chatId, profileId, branch } = await setup()
    await writeFile(join(wt, 'novo.txt'), 'x')
    database.db.prepare(`INSERT INTO runs(id, card_id, chat_id, profile_id, status, started_at) VALUES ('11111111-1111-4111-8111-111111111111', ?, ?, ?, 'running', ?)`).run(cardId, chatId, profileId, new Date().toISOString())
    await expect(manager.discardUnstaged(sourceId, cardId, ['novo.txt'])).rejects.toThrow(/agente/i)
    await expect(manager.writeFileText(sourceId, cardId, 'novo.txt', 'y')).rejects.toThrow(/agente/i)
    await expect(manager.commitAction(sourceId, { cardId, action: 'reset-hard', hash: 'a'.repeat(40) })).rejects.toThrow(/agente/i)
    await expect(manager.branchAction(sourceId, { cardId, action: 'merge', name: 'main' })).rejects.toThrow(/agente/i)
    await expect(manager.stashAction(sourceId, { cardId, action: 'pop', ref: 'stash@{0}' })).rejects.toThrow(/agente/i)
    expect(await readFile(join(wt, 'novo.txt'), 'utf8')).toBe('x')
    expect((await manager.changes(sourceId, cardId)).files.map((file) => file.path)).toContain('novo.txt')
    expect(branch).toBeTruthy()
  })
})

describe('agent commit', () => {
  it('never: refuses and explains; otherwise follows the branch rule', async () => {
    const { manager, projectId, cardId, chatId, wt, branch } = await setup()
    await writeFile(join(wt, 'n.txt'), 'n\n')
    manager.setPolicy(projectId, { def: 'ask', rules: [{ pattern: branch, rule: 'never' }] })
    await expect(manager.agentCommit({ cardId, chatId, message: 'Tenta' })).rejects.toThrow(`turned off on branch ${branch}`)
    expect(manager.agentRule(cardId)).toContain('Do not commit on this branch')
    expect(manager.requests(cardId)).toEqual([])
  })

  it('ask permission: records the request, authorizes, commits only the files and marks the agent as author', async () => {
    const { manager, projectId, sourceId, cardId, chatId, wt, profileId, database } = await setup()
    await writeFile(join(wt, 'a.txt'), 'a\n'); await writeFile(join(wt, 'b.txt'), 'b\n')
    expect(manager.agentRule(cardId)).toContain('gearmod_request_commit')
    const asked = await manager.agentCommit({ cardId, chatId, message: 'Cria a e b\n\nDetalhes', files: ['a.txt'] })
    expect(asked.rule).toBe('ask')
    const [request] = manager.requests(cardId)
    expect(request).toMatchObject({ status: 'pending', repoName: 'repo', files: ['a.txt'], agentProfileId: profileId })
    expect(database.db.prepare('SELECT COUNT(*) AS n FROM git_commit_requests WHERE status = ?').get('pending')).toEqual({ n: 1 })
    // a new request on the same repository replaces the pending one
    await manager.agentCommit({ cardId, chatId, message: 'Cria a', files: ['a.txt'] })
    expect(manager.requests(cardId).filter((item) => item.status === 'pending')).toHaveLength(1)
    const pending = manager.requests(cardId)[0]!
    expect((await manager.card(cardId)).repos[0]!.request?.id).toBe(pending.id)
    const done = await manager.decide(pending.id, 'allow', 'Cria o arquivo a')
    expect(done).toMatchObject({ status: 'done' }); expect(done.hash).toMatch(/^[0-9a-f]{40}$/)
    expect((await git(wt, 'log', '-1', '--format=%s')).stdout.trim()).toBe('Cria o arquivo a')
    expect((await manager.changes(sourceId, cardId)).files.map((file) => file.path)).toEqual(['b.txt'])
    const graph = await manager.graph(projectId, sourceId)
    expect(graph.rows.find((row) => row.hash === done.hash)).toMatchObject({ agentProfileId: profileId, cardId })
    expect((await manager.decide(pending.id, 'deny')).status).toBe('done')
  })

  it('refusing does not commit; automatic commits right away and warns when there are no new files', async () => {
    const { manager, projectId, sourceId, cardId, chatId, wt } = await setup()
    await writeFile(join(wt, 'r.txt'), 'r\n')
    await manager.agentCommit({ cardId, chatId, message: 'Quer commitar' })
    const id = manager.requests(cardId)[0]!.id
    expect((await manager.decide(id, 'deny')).status).toBe('denied')
    expect((await manager.changes(sourceId, cardId)).files).toHaveLength(1)
    manager.setPolicy(projectId, { def: 'auto', rules: [] })
    const auto = await manager.agentCommit({ cardId, chatId, message: 'Commit automático' })
    expect(auto.text).toContain('Commit done')
    expect((await manager.changes(sourceId, cardId)).files).toEqual([])
    await expect(manager.agentCommit({ cardId, chatId, message: 'Nada mais' })).rejects.toThrow('Não há alterações')
    expect((await git(wt, 'log', '-1', '--format=%s')).stdout.trim()).toBe('Commit automático')
  })

  it('amend: folds the files into the card branch last commit, and refuses a commit that is also in another branch', async () => {
    const { manager, cardId, chatId, wt } = await setup()
    await writeFile(join(wt, 'x.txt'), 'x\n')
    // The branch still points to the base commit (also in main): nothing of its own to amend.
    await expect(manager.agentCommit({ cardId, chatId, message: '', files: ['x.txt'], amend: true })).rejects.toThrow(/Cannot amend/)
    await manager.agentCommit({ cardId, chatId, message: 'Cria x', files: ['x.txt'] })
    await manager.decide(manager.requests(cardId).find((item) => item.status === 'pending')!.id, 'allow')
    const count = (await git(wt, 'rev-list', '--count', 'HEAD')).stdout.trim()
    await writeFile(join(wt, 'y.txt'), 'y\n')
    await manager.agentCommit({ cardId, chatId, message: '', files: ['y.txt'], amend: true })
    const request = manager.requests(cardId).find((item) => item.status === 'pending')!
    expect(request).toMatchObject({ amend: true, files: ['y.txt'] })
    expect((await manager.decide(request.id, 'allow')).status).toBe('done')
    expect((await git(wt, 'rev-list', '--count', 'HEAD')).stdout.trim()).toBe(count)
    expect((await git(wt, 'log', '-1', '--format=%s')).stdout.trim()).toBe('Cria x')
    expect((await git(wt, 'show', '--name-only', '--format=', 'HEAD')).stdout.trim().split('\n').sort()).toEqual(['x.txt', 'y.txt'])
    // Only a new message, nothing changed and no repo named: the card's only repository is used.
    await manager.agentCommit({ cardId, chatId, message: 'feature: Create x and y', amend: true })
    const reword = manager.requests(cardId).find((item) => item.status === 'pending')!
    expect(reword).toMatchObject({ amend: true, files: [] })
    expect((await manager.decide(reword.id, 'allow')).status).toBe('done')
    expect((await git(wt, 'rev-list', '--count', 'HEAD')).stdout.trim()).toBe(count)
    expect((await git(wt, 'log', '-1', '--format=%s')).stdout.trim()).toBe('feature: Create x and y')
    expect((await git(wt, 'show', '--name-only', '--format=', 'HEAD')).stdout.trim().split('\n').sort()).toEqual(['x.txt', 'y.txt'])
  })
})

describe('secret in the agent commit (S13)', () => {
  it('blocks the commit with a real API key, but lets .env.example with a sample value through', async () => {
    const { manager, projectId, cardId, chatId, wt } = await setup()
    manager.setPolicy(projectId, { def: 'auto', rules: [] })
    await writeFile(join(wt, '.env.example'), 'OPENAI_API_KEY=coloque-sua-chave\n')
    await writeFile(join(wt, 'config.ts'), 'export const key = "sk-abcdefghijklmnop1234"\n')
    await expect(manager.agentCommit({ cardId, chatId, message: 'Config' })).rejects.toThrow(/config\.ts:1/)
    expect((await git(wt, 'rev-list', '--count', 'HEAD')).stdout.trim()).toBe('1')
    const ok = await manager.agentCommit({ cardId, chatId, message: 'Só o exemplo', files: ['.env.example'] })
    expect(ok.text).toContain('Commit done')
  })
})

describe('conflicts per repository and worktree', () => {
  it('lists only those with an operation in progress and resolves in the right folder (repository or card worktree)', async () => {
    const { repo, wt, manager, projectId, sourceId, cardId } = await setup()
    await writeFile(join(repo, 'README.md'), '# principal\n'); await git(repo, 'commit', '-am', 'main muda')
    await writeFile(join(wt, 'README.md'), '# do card\n'); await git(wt, 'commit', '-am', 'card muda')
    expect(await manager.conflictsAll(projectId)).toEqual([])
    await git(wt, 'merge', 'main').catch(() => undefined)
    const all = await manager.conflictsAll(projectId)
    expect(all).toHaveLength(1); expect(all[0]).toMatchObject({ sourceId, cardId, repo: 'repo', cardTitle: 'Tela de teste', operation: 'merge', files: ['README.md'] })
    expect((await manager.conflicts(sourceId)).operation).toBeNull()
    expect((await manager.conflicts(sourceId, cardId)).files).toEqual(['README.md'])
    expect(await manager.conflictFile(sourceId, 'README.md', cardId)).toContain('<<<<<<<')
    await expect(manager.resolveConflict(sourceId, 'README.md', 'marked', cardId)).rejects.toThrow('marcadores')
    expect(await manager.saveConflict(sourceId, 'README.md', '# resolvido\n', cardId)).toEqual({ left: 1 })
    await expect(manager.saveConflict(sourceId, 'outro.txt', 'x', cardId)).rejects.toThrow('não está em conflito')
    expect(await manager.resolveConflict(sourceId, 'README.md', 'marked', cardId)).toEqual({ left: 0 })
    await manager.finishConflicts(sourceId, 'continue', cardId)
    expect(await manager.conflictsAll(projectId)).toEqual([])
    expect((await git(wt, 'show', 'HEAD:README.md')).stdout).toBe('# resolvido\n')
  })

  it('a conflict in the main repository shows up without cardId', async () => {
    const { repo, manager, projectId, sourceId } = await setup()
    await git(repo, 'checkout', '-b', 'feat'); await writeFile(join(repo, 'README.md'), '# feat\n'); await git(repo, 'commit', '-am', 'feat')
    await git(repo, 'checkout', 'main'); await writeFile(join(repo, 'README.md'), '# main\n'); await git(repo, 'commit', '-am', 'main')
    await git(repo, 'merge', 'feat').catch(() => undefined)
    const all = await manager.conflictsAll(projectId)
    expect(all).toHaveLength(1); expect(all[0]).toMatchObject({ sourceId, cardId: null, cardTitle: null, operation: 'merge' })
    await manager.finishConflicts(sourceId, 'abort')
    expect(await manager.conflictsAll(projectId)).toEqual([])
  })
})

describe('fileVersions', () => {
  it('unstaged, staged, commit, new file, deleted and renamed', async () => {
    const { repo, manager, sourceId } = await setup()
    await writeFile(join(repo, 'README.md'), 'novo texto\n')
    expect(await manager.fileVersions(sourceId, null, 'README.md', 'unstaged')).toEqual({ before: '# fixture\n', after: 'novo texto\n', binary: false, truncated: false })
    await git(repo, 'add', 'README.md')
    expect(await manager.fileVersions(sourceId, null, 'README.md', 'staged')).toMatchObject({ before: '# fixture\n', after: 'novo texto\n' })
    expect(await manager.fileVersions(sourceId, null, 'README.md', 'unstaged')).toMatchObject({ before: 'novo texto\n', after: 'novo texto\n' })
    await git(repo, 'commit', '-m', 'edita'); const edit = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim()
    expect(await manager.fileVersions(sourceId, null, 'README.md', 'commit', edit)).toMatchObject({ before: '# fixture\n', after: 'novo texto\n' })
    await writeFile(join(repo, 'novo.txt'), 'oi\n'); await git(repo, 'add', 'novo.txt'); await git(repo, 'mv', 'README.md', 'LEIAME.md'); await git(repo, 'commit', '-m', 'novo e renomeia'); const second = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim()
    expect(await manager.fileVersions(sourceId, null, 'novo.txt', 'commit', second)).toMatchObject({ before: null, after: 'oi\n' })
    expect(await manager.fileVersions(sourceId, null, 'LEIAME.md', 'commit', second)).toMatchObject({ before: 'novo texto\n', after: 'novo texto\n' })
    await git(repo, 'rm', '-q', 'novo.txt'); await git(repo, 'commit', '-m', 'apaga'); const third = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim()
    expect(await manager.fileVersions(sourceId, null, 'novo.txt', 'commit', third)).toMatchObject({ before: 'oi\n', after: null })
    const first = (await git(repo, 'rev-list', '--max-parents=0', 'HEAD')).stdout.trim()
    expect(await manager.fileVersions(sourceId, null, 'README.md', 'commit', first)).toMatchObject({ before: null, after: '# fixture\n' })
  })

  it('binary and large files do not send content', async () => {
    const { repo, manager, sourceId } = await setup()
    await writeFile(join(repo, 'a.bin'), Buffer.from([1, 0, 2])); await writeFile(join(repo, 'grande.txt'), 'x'.repeat(1_100_000))
    expect(await manager.fileVersions(sourceId, null, 'a.bin', 'unstaged')).toEqual({ before: null, after: null, binary: true, truncated: false })
    expect(await manager.fileVersions(sourceId, null, 'grande.txt', 'unstaged')).toEqual({ before: null, after: null, binary: false, truncated: true })
  })
})

describe('rebase onto another branch', () => {
  it("makes that branch the card's new base", async () => {
    const { manager, database, repo, sourceId, cardId } = await setup()
    await git(repo, 'branch', 'dev'); await git(repo, 'checkout', 'dev')
    await writeFile(join(repo, 'dev.txt'), 'dev\n'); await git(repo, 'add', 'dev.txt'); await git(repo, 'commit', '-m', 'na dev'); await git(repo, 'checkout', 'main')
    await manager.branchAction(sourceId, { cardId, action: 'rebase-onto', name: 'dev' })
    expect(database.db.prepare('SELECT base_ref FROM worktrees WHERE card_id = ?').pluck().get(cardId)).toBe('dev')
    expect(database.db.prepare('SELECT m.base_ref FROM worktree_members m JOIN worktrees w ON w.id = m.worktree_id WHERE w.card_id = ?').pluck().get(cardId)).toBe('dev')
    expect(database.db.prepare('SELECT base_branch FROM cards WHERE id = ?').pluck().get(cardId)).toBe('dev')
  })
})

describe('rename branch', () => {
  it('renames a loose branch and refuses a name already in use', async () => {
    const { manager, repo, sourceId } = await setup()
    await git(repo, 'branch', 'solta'); await git(repo, 'branch', 'ocupada')
    await expect(manager.branchAction(sourceId, { action: 'rename', name: 'solta', newName: 'ocupada' })).rejects.toThrow(/ocupada/)
    await expect(manager.branchAction(sourceId, { action: 'rename', name: 'solta', newName: 'nome ruim' })).rejects.toThrow()
    expect((await manager.branchAction(sourceId, { action: 'rename', name: 'solta', newName: 'feature/nova' })).output).toContain('feature/nova')
    const branches = (await git(repo, 'branch', '--list')).stdout
    expect(branches).toContain('feature/nova'); expect(branches).not.toContain('solta')
  })

  it("renames a card's branch in its worktree and in the card's record", async () => {
    const { manager, database, repo, sourceId, cardId, wt, branch } = await setup()
    await manager.branchAction(sourceId, { action: 'rename', name: branch, newName: 'feature/instalador-linux' })
    expect((await git(wt, 'branch', '--show-current')).stdout.trim()).toBe('feature/instalador-linux')
    expect((await git(repo, 'branch', '--list', branch)).stdout.trim()).toBe('')
    expect(database.db.prepare('SELECT branch FROM worktrees WHERE card_id = ?').pluck().get(cardId)).toBe('feature/instalador-linux')
  })
})

describe('commit message convention', () => {
  async function withHistory(): Promise<Awaited<ReturnType<typeof setup>> & { file: string }> {
    const ctx = await setup()
    for (const [index, subject] of ['feat(#ASF-9503): Nova análise de crédito', 'fix(#ASF-9028): Corrige o cálculo do limite', 'feat(#ASF-9411): Adiciona filtro por status', 'fix(#ASF-9300): Ajusta mensagem de erro', 'chore(#ASF-9100): Atualiza dependências', 'feat(#ASF-9200): Cria tela de histórico', 'refactor(#ASF-9150): Separa o serviço de propostas', 'fix(#ASF-9120): Remove validação duplicada', 'feat(#ASF-9110): Exporta relatório em CSV', 'fix(#ASF-9101): Evita erro quando não há contrato', 'feat(#ASF-9090): Inclui campo de observação'].entries()) {
      await writeFile(join(ctx.repo, `h${index}.txt`), `${index}\n`); await git(ctx.repo, 'add', '.'); await git(ctx.repo, 'commit', '-m', subject)
    }
    const file = join(ctx.root, 'data', 'commit-conventions.json')
    ctx.manager.conventions = new CommitConventionStore(file)
    return { ...ctx, file }
  }

  it('the agent tool analyzes the history, saves it in the JSON and accepts an agent review', async () => {
    const { manager, projectId, file, repo } = await withHistory()
    const read = await manager.commitConvention(projectId, {})
    expect(read).toContain('Conventional Commits'); expect(read).toContain('#ASF-9503'); expect(read).toContain('deduced automatically'); expect(read).toContain('- feat(#ASF-9090): Inclui campo de observação')
    const saved = JSON.parse(await readFile(file, 'utf8')) as { repos: Record<string, { source: string; analyzedAt: string; repoPath: string }> }
    expect(Object.values(saved.repos)).toMatchObject([{ source: 'auto', repoName: 'repo' }]); expect(Object.values(saved.repos)[0]!.repoPath.toLowerCase()).toContain(basename(repo).toLowerCase())
    expect(Date.parse(Object.values(saved.repos)[0]!.analyzedAt)).toBeGreaterThan(Date.now() - 60_000)
    await expect(manager.commitConvention(projectId, { repo: 'nope' })).rejects.toThrow('Unknown repository')
    await expect(manager.commitConvention(projectId, { description: 'x', examples: [] })).rejects.toThrow('exemplos')
    const reviewed = await manager.commitConvention(projectId, { description: 'tipo(#ASF-nnnn): Texto em português, com maiúscula', examples: ['feat(#ASF-9503): Nova análise de crédito'] })
    expect(reviewed).toContain('Saved'); expect(reviewed).toContain('reviewed by an agent')
    expect(await manager.commitConvention(projectId, {})).not.toContain('deduced automatically')
  })

  it('an agent commit outside the convention comes back to be rewritten; the right one goes through', async () => {
    const { manager, projectId, cardId, chatId, wt } = await withHistory()
    manager.setPolicy(projectId, { def: 'auto', rules: [] })
    await writeFile(join(wt, 'n.txt'), 'n\n')
    await expect(manager.agentCommit({ cardId, chatId, message: 'Cria a tela nova' })).rejects.toThrow(/does not follow the commit convention[\s\S]*Examples:/)
    const done = await manager.agentCommit({ cardId, chatId, message: 'feat(#ASF-1): Cria a tela nova' })
    expect(done.text).toContain('Commit done'); expect(done.text).not.toContain('Convention notes')
    await writeFile(join(wt, 'm.txt'), 'm\n')
    const forced = await manager.agentCommit({ cardId, chatId, message: 'Create the screen', ignoreConvention: true })
    expect(forced.text).toContain('Commit done'); expect(forced.text).toContain('Convention notes')
    expect((await git(wt, 'log', '-1', '--format=%s')).stdout.trim()).toBe('Create the screen')
  })

  it('the commit-message suggestion gets the convention', async () => {
    const { manager, sourceId, cardId, wt } = await withHistory()
    await writeFile(join(wt, 's.txt'), 's\n')
    const context = await manager.suggestionContext(sourceId, cardId, [])
    expect(context.startsWith('Padrão de commit do repositório')).toBe(true); expect(context).toContain('feat(#ASF-9090): Inclui campo de observação')
  })

  it('without the store, nothing is checked', async () => {
    const { manager, projectId, cardId, chatId, wt, sourceId } = await setup()
    manager.setPolicy(projectId, { def: 'auto', rules: [] })
    await writeFile(join(wt, 'z.txt'), 'z\n')
    expect((await manager.agentCommit({ cardId, chatId, message: 'qualquer' })).text).toContain('Commit done')
    expect(await manager.conventionOf(sourceId)).toBeNull()
  })
})
