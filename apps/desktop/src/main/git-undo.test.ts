import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { GitManager } from './git-manager'
import { entryLabel, sameState, undoLimit, UndoJournal, type UndoEntry } from './git-undo'
import { BoardRepository, GitService, ProfileRepository, ProjectRepository } from './projects'
import { seedProfiles } from './test-helpers'
import { WorktreeService } from './worktrees'

const exec = promisify(execFile), roots: string[] = [], opened: AppDatabase[] = []
afterEach(async () => { opened.splice(0).forEach((item) => item.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))) })
const git = (dir: string, ...args: string[]): Promise<{ stdout: string }> => exec('git', ['-C', dir, ...args])
const out = async (dir: string, ...args: string[]): Promise<string> => (await git(dir, ...args)).stdout.trim()
const head = (dir: string): Promise<string> => out(dir, 'rev-parse', 'HEAD')
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
const refs = async (dir: string): Promise<string[]> => (await out(dir, 'for-each-ref', '--format=%(refname)', 'refs/gearmod/undo')).split(/\r?\n/).filter(Boolean)

/** Temporary repository registered in a project; `remote` attaches a bare repo as origin, `empty` leaves the repository with no commit. */
async function setup(options: { remote?: boolean; empty?: boolean } = {}): Promise<{ root: string; repo: string; remote: string; backup: string; database: AppDatabase; manager: GitManager; projectId: string; sourceId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-undo-')); roots.push(root)
  const repo = join(root, 'repo'), remote = join(root, 'remote.git'), backup = join(root, 'backup'), trash = join(root, 'trash')
  await exec('git', ['init', '-b', 'main', repo])
  await git(repo, 'config', 'user.email', 'test@example.invalid'); await git(repo, 'config', 'user.name', 'GearMod Test'); await git(repo, 'config', 'core.autocrlf', 'false')
  if (!options.empty) { await writeFile(join(repo, 'README.md'), '# fixture\n'); await git(repo, 'add', 'README.md'); await git(repo, 'commit', '-m', 'primeiro') }
  if (options.remote) { await exec('git', ['init', '--bare', '-b', 'main', remote]); await git(repo, 'remote', 'add', 'origin', remote); await git(repo, 'push', '-u', 'origin', 'main') }
  const database = new AppDatabase(join(root, 'data', 'db.sqlite'), '0.1.0'); await database.open(); opened.push(database)
  const project = await new ProjectRepository(database, new GitService()).create({ localPath: repo })
  const source = database.db.prepare('SELECT id FROM project_sources WHERE project_id = ?').get(project.id) as { id: string }
  const toTrash = async (path: string): Promise<void> => { await mkdir(trash, { recursive: true }); await rename(path, join(trash, `${Date.now()}-${basename(path)}`)) }
  return { root, repo, remote, backup, database, manager: new GitManager(database, undefined, undefined, undefined, toTrash, backup), projectId: project.id, sourceId: source.id }
}

const entry = (id: string): UndoEntry => ({ id, kind: 'commit', at: '', before: { head: null, branch: null }, after: { head: id, branch: 'main' }, dir: '/x', pins: [], data: { message: id } })

describe('undo history', () => {
  it('keeps at most 20 actions per folder and returns the one that dropped out', () => {
    const journal = new UndoJournal()
    const gone: string[] = []
    for (let i = 0; i < undoLimit + 3; i++) gone.push(...journal.push('a', entry(`e${i}`)).map((item) => item.id))
    expect(gone).toEqual(['e0', 'e1', 'e2'])
    expect(journal.all()).toHaveLength(undoLimit)
    expect(journal.peekUndo('a')?.id).toBe(`e${undoLimit + 2}`)
    expect(journal.peekUndo('b')).toBeUndefined()
  })

  it('a new action clears redo; undo and redo move the entry around', () => {
    const journal = new UndoJournal()
    journal.push('a', entry('um')); journal.push('a', entry('dois'))
    journal.moveToUndone('a')
    expect(journal.peekUndo('a')?.id).toBe('um'); expect(journal.peekRedo('a')?.id).toBe('dois')
    journal.moveToDone('a')
    expect(journal.peekUndo('a')?.id).toBe('dois'); expect(journal.peekRedo('a')).toBeUndefined()
    journal.moveToUndone('a')
    expect(journal.push('a', entry('tres')).map((item) => item.id)).toEqual(['dois'])
    expect(journal.peekRedo('a')).toBeUndefined()
  })

  it('drop removes an entry and clear empties the folder, returning everything', () => {
    const journal = new UndoJournal()
    journal.push('a', entry('um')); journal.push('a', entry('dois')); journal.moveToUndone('a'); journal.push('b', entry('tres'))
    expect(journal.drop('a', 'um').map((item) => item.id)).toEqual(['um'])
    expect(journal.peekUndo('a')).toBeUndefined()
    journal.push('a', entry('quatro')); journal.moveToUndone('a')
    expect(journal.clear('a').map((item) => item.id)).toEqual(['quatro'])
    expect(journal.clearWhere((key) => key === 'b').map((item) => item.id)).toEqual(['tres'])
    expect(journal.all()).toEqual([])
  })

  it('compares states and writes the action text', () => {
    expect(sameState({ head: 'a', branch: 'main' }, { head: 'a', branch: 'main' })).toBe(true)
    expect(sameState({ head: 'a', branch: 'main' }, { head: 'a', branch: null })).toBe(false)
    expect(entryLabel('commit', { message: 'Corrige filtro' })).toBe('commit "Corrige filtro"')
    expect(entryLabel('checkout', { to: 'dev' })).toBe('checkout de dev')
    expect(entryLabel('create-branch', { name: 'feature/x' })).toBe('criar a branch feature/x')
    expect(entryLabel('delete-branch', { name: 'feature/x' })).toBe('apagar a branch feature/x')
    expect(entryLabel('reset', { mode: 'hard', to: 'abcdef1234' })).toBe('reset hard para abcdef1')
  })
})

describe('undo commit, amend and rename', () => {
  it('undoes the commit (files come back staged) and redoes it with the same hash', async () => {
    const { manager, repo, sourceId } = await setup()
    const first = await head(repo)
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', 'a.txt')
    const { hash } = await manager.commit({ sourceId, cardId: null, message: 'Adiciona a' })
    expect(await manager.undoState(sourceId, null)).toEqual({ undo: { label: 'commit "Adiciona a"' }, redo: null })
    expect((await manager.undoLast(sourceId, null)).output).toBe('Desfeito: commit "Adiciona a".')
    expect(await head(repo)).toBe(first)
    expect(await out(repo, 'status', '--porcelain')).toBe('A  a.txt')
    expect(await manager.undoState(sourceId, null)).toEqual({ undo: null, redo: { label: 'commit "Adiciona a"' } })
    expect((await manager.redoLast(sourceId, null)).output).toBe('Refeito: commit "Adiciona a".')
    expect(await head(repo)).toBe(hash)
    await expect(manager.redoLast(sourceId, null)).rejects.toThrow(/Nada para refazer/)
  })

  it('redo refuses if what is staged changed', async () => {
    const { manager, repo, sourceId } = await setup()
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', 'a.txt')
    await manager.commit({ sourceId, cardId: null, message: 'Adiciona a' })
    await manager.undoLast(sourceId, null)
    await writeFile(join(repo, 'a.txt'), 'outro\n'); await git(repo, 'add', 'a.txt')
    await expect(manager.redoLast(sourceId, null)).rejects.toThrow(/preparadas mudaram/)
  })

  it('amend: undo restores the old message', async () => {
    const { manager, repo, sourceId } = await setup()
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', 'a.txt')
    const one = (await manager.commit({ sourceId, cardId: null, message: 'um' })).hash
    const two = (await manager.commit({ sourceId, cardId: null, message: 'dois', amend: true })).hash
    expect((await manager.undoState(sourceId, null)).undo?.label).toBe('emendar o commit "dois"')
    await manager.undoLast(sourceId, null)
    expect(await head(repo)).toBe(one); expect(await out(repo, 'log', '-1', '--format=%s')).toBe('um')
    await manager.redoLast(sourceId, null)
    expect(await head(repo)).toBe(two)
  })

  it('renaming the commit goes on the stack and can be undone', async () => {
    const { manager, repo, sourceId } = await setup()
    const base = await head(repo)
    const renamed = await manager.renameCommit({ sourceId, cardId: null, hash: base, message: 'novo nome' })
    expect((await manager.undoState(sourceId, null)).undo?.label).toBe('renomear o commit "novo nome"')
    await manager.undoLast(sourceId, null)
    expect(await head(repo)).toBe(base)
    await manager.redoLast(sourceId, null)
    expect(await head(repo)).toBe(renamed.hash)
  })

  it('first commit of the repository: undo leaves the repository without HEAD and with the file staged', async () => {
    const { manager, repo, sourceId } = await setup({ empty: true })
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', 'a.txt')
    const { hash } = await manager.commit({ sourceId, cardId: null, message: 'inicial' })
    await manager.undoLast(sourceId, null)
    await expect(git(repo, 'rev-parse', '-q', '--verify', 'HEAD')).rejects.toThrow()
    expect(await out(repo, 'status', '--porcelain')).toBe('A  a.txt')
    await manager.redoLast(sourceId, null)
    expect(await head(repo)).toBe(hash)
  })

  it('an already published commit cannot be undone', async () => {
    const { manager, repo, sourceId } = await setup({ remote: true })
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', 'a.txt')
    const { hash } = await manager.commit({ sourceId, cardId: null, message: 'publicado' })
    await git(repo, 'push')
    await expect(manager.undoLast(sourceId, null)).rejects.toThrow(/já foi enviado para o remoto/)
    expect(await head(repo)).toBe(hash)
  })

  it('a commit made externally afterwards refuses the undo and removes the entry from the stack', async () => {
    const { manager, repo, sourceId } = await setup()
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', 'a.txt')
    await manager.commit({ sourceId, cardId: null, message: 'pela tela' })
    await git(repo, 'commit', '--allow-empty', '-m', 'pelo terminal')
    const outside = await head(repo)
    await expect(manager.undoLast(sourceId, null)).rejects.toThrow(/O repositório mudou/)
    expect(await head(repo)).toBe(outside)
    await expect(manager.undoLast(sourceId, null)).rejects.toThrow(/Nada para desfazer/)
  })

  it('the button does not promise what went stale: undoState discards the entry', async () => {
    const { manager, repo, sourceId } = await setup()
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', 'a.txt')
    await manager.commit({ sourceId, cardId: null, message: 'pela tela' })
    await git(repo, 'commit', '--allow-empty', '-m', 'por fora')
    expect(await manager.undoState(sourceId, null)).toEqual({ undo: null, redo: null })
  })

  it('each folder has its own stack: a commit in the card worktree does not show in the main folder', async () => {
    const { root, repo, database, manager, projectId, sourceId } = await setup()
    const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
    const projects = new ProjectRepository(database, new GitService()), board = new BoardRepository(database, projects), column = board.get(projectId).columns[0]!
    const card = board.create({ projectId, columnId: column.id, title: 'Tela de teste', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    const worktree = await new WorktreeService(database, join(root, 'data')).prepare(card.id)
    const wt = (database.db.prepare('SELECT path FROM worktree_members WHERE worktree_id = ?').get(worktree.id) as { path: string }).path
    const before = await head(wt)
    await writeFile(join(wt, 'w.txt'), 'w\n'); await git(wt, 'add', 'w.txt')
    await manager.commit({ sourceId, cardId: card.id, message: 'no card' })
    expect((await manager.undoState(sourceId, card.id)).undo?.label).toBe('commit "no card"')
    expect(await manager.undoState(sourceId, null)).toEqual({ undo: null, redo: null })
    await manager.undoLast(sourceId, card.id)
    expect(await head(wt)).toBe(before)
    expect(await head(repo)).toBe(before)
  })
})

describe('undo checkout, branch and tag', () => {
  it('checkout of a branch and of a commit: undo and redo', async () => {
    const { manager, repo, sourceId } = await setup()
    const first = await head(repo)
    await git(repo, 'branch', 'dev')
    await manager.branchAction(sourceId, { action: 'checkout', name: 'dev' })
    expect((await manager.undoState(sourceId, null)).undo?.label).toBe('checkout de dev')
    await manager.undoLast(sourceId, null)
    expect(await out(repo, 'branch', '--show-current')).toBe('main')
    await manager.redoLast(sourceId, null)
    expect(await out(repo, 'branch', '--show-current')).toBe('dev')
    await manager.undoLast(sourceId, null)
    await manager.commitAction(sourceId, { action: 'checkout', hash: first })
    expect(await out(repo, 'branch', '--show-current')).toBe('')
    await manager.undoLast(sourceId, null)
    expect(await out(repo, 'branch', '--show-current')).toBe('main')
    await manager.redoLast(sourceId, null)
    expect(await head(repo)).toBe(first); expect(await out(repo, 'branch', '--show-current')).toBe('')
  })

  it('checkout of a remote branch that created the local one: undo deletes the local one, redo recreates it', async () => {
    const { manager, repo, sourceId } = await setup({ remote: true })
    await git(repo, 'checkout', '-b', 'feature/x'); await writeFile(join(repo, 'b.txt'), 'b\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'feature')
    await git(repo, 'push', 'origin', 'feature/x'); await git(repo, 'checkout', 'main'); await git(repo, 'branch', '-D', 'feature/x')
    await manager.branchAction(sourceId, { action: 'checkout', name: 'origin/feature/x' })
    expect(await out(repo, 'branch', '--show-current')).toBe('feature/x')
    await manager.undoLast(sourceId, null)
    expect(await out(repo, 'branch', '--show-current')).toBe('main')
    expect(await out(repo, 'branch', '--list', 'feature/x')).toBe('')
    await manager.redoLast(sourceId, null)
    expect(await out(repo, 'branch', '--show-current')).toBe('feature/x')
    expect(await out(repo, 'rev-parse', '--abbrev-ref', 'feature/x@{upstream}')).toBe('origin/feature/x')
  })

  it('create branch: undo goes back and deletes the new one; committing on it requires undoing the commit first', async () => {
    const { manager, repo, sourceId } = await setup()
    const first = await head(repo)
    await manager.branchAction(sourceId, { action: 'create', name: 'main', newName: 'feat' })
    await manager.undoLast(sourceId, null)
    expect(await out(repo, 'branch', '--show-current')).toBe('main'); expect(await out(repo, 'branch', '--list', 'feat')).toBe('')
    await manager.redoLast(sourceId, null)
    expect(await out(repo, 'branch', '--show-current')).toBe('feat')
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', 'a.txt')
    await manager.commit({ sourceId, cardId: null, message: 'na feat' })
    await manager.undoLast(sourceId, null)
    expect(await head(repo)).toBe(first)
    await manager.undoLast(sourceId, null)
    expect(await out(repo, 'branch', '--show-current')).toBe('main'); expect(await out(repo, 'branch', '--list', 'feat')).toBe('')
  })

  it('creating a branch at a commit can also be undone', async () => {
    const { manager, repo, sourceId } = await setup()
    const first = await head(repo)
    await manager.commitAction(sourceId, { action: 'branch', hash: first, name: 'daqui' })
    expect(await out(repo, 'branch', '--show-current')).toBe('daqui')
    await manager.undoLast(sourceId, null)
    expect(await out(repo, 'branch', '--show-current')).toBe('main'); expect(await out(repo, 'branch', '--list', 'daqui')).toBe('')
  })

  it('delete branch with upstream: undo restores the hash and the upstream, redo deletes it again', async () => {
    const { manager, repo, sourceId } = await setup({ remote: true })
    await git(repo, 'branch', 'old'); await git(repo, 'push', '-u', 'origin', 'old')
    const hash = await out(repo, 'rev-parse', 'old')
    await manager.branchAction(sourceId, { action: 'delete', name: 'old' })
    expect(await out(repo, 'branch', '--list', 'old')).toBe('')
    expect((await manager.undoState(sourceId, null)).undo?.label).toBe('apagar a branch old')
    await manager.undoLast(sourceId, null)
    expect(await out(repo, 'rev-parse', 'old')).toBe(hash)
    expect(await out(repo, 'config', 'branch.old.remote')).toBe('origin'); expect(await out(repo, 'config', 'branch.old.merge')).toBe('refs/heads/old')
    await manager.redoLast(sourceId, null)
    expect(await out(repo, 'branch', '--list', 'old')).toBe('')
  })

  it('undoing a branch deletion refuses if another one with the name already exists', async () => {
    const { manager, repo, sourceId } = await setup()
    await git(repo, 'branch', 'old')
    await manager.branchAction(sourceId, { action: 'delete', name: 'old' })
    await git(repo, 'branch', 'old')
    await expect(manager.undoLast(sourceId, null)).rejects.toThrow(/Já existe uma branch chamada old/)
  })

  it('tag: undo deletes and redo creates it again', async () => {
    const { manager, repo, sourceId } = await setup()
    const first = await head(repo)
    await manager.commitAction(sourceId, { action: 'tag', hash: first, name: 'v1' })
    expect(await out(repo, 'tag', '--list', 'v1')).toBe('v1')
    await manager.undoLast(sourceId, null)
    expect(await out(repo, 'tag', '--list', 'v1')).toBe('')
    await manager.redoLast(sourceId, null)
    expect(await out(repo, 'rev-parse', 'v1^{commit}')).toBe(first)
  })
})

describe('undo reset', () => {
  async function history(repo: string): Promise<{ one: string; two: string }> {
    const one = await head(repo)
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', 'a.txt'); await git(repo, 'commit', '-m', 'dois')
    return { one, two: await head(repo) }
  }

  it('soft, mixed and hard (clean folder) can be undone and redone', async () => {
    const { manager, repo, sourceId } = await setup()
    const { one, two } = await history(repo)
    await manager.commitAction(sourceId, { action: 'reset-soft', hash: one })
    expect(await out(repo, 'status', '--porcelain')).toBe('A  a.txt')
    await manager.undoLast(sourceId, null)
    expect(await head(repo)).toBe(two); expect(await out(repo, 'status', '--porcelain')).toBe('')
    await manager.redoLast(sourceId, null)
    expect(await head(repo)).toBe(one)
    await manager.undoLast(sourceId, null)
    await manager.commitAction(sourceId, { action: 'reset-mixed', hash: one })
    expect(await out(repo, 'status', '--porcelain')).toBe('?? a.txt')
    await manager.undoLast(sourceId, null)
    expect(await head(repo)).toBe(two)
    await manager.redoLast(sourceId, null)
    expect(await head(repo)).toBe(one)
    await manager.undoLast(sourceId, null)
    await manager.commitAction(sourceId, { action: 'reset-hard', hash: one })
    expect(await exists(join(repo, 'a.txt'))).toBe(false)
    expect((await manager.undoState(sourceId, null)).undo?.label).toBe(`reset hard para ${one.slice(0, 7)}`)
    await manager.undoLast(sourceId, null)
    expect(await head(repo)).toBe(two); expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
    await manager.redoLast(sourceId, null)
    expect(await head(repo)).toBe(one); expect(await exists(join(repo, 'a.txt'))).toBe(false)
  })

  it('undoing a hard reset with a dirty folder is refused', async () => {
    const { manager, repo, sourceId } = await setup()
    const { one } = await history(repo)
    await manager.commitAction(sourceId, { action: 'reset-hard', hash: one })
    await writeFile(join(repo, 'README.md'), 'sujo\n')
    await expect(manager.undoLast(sourceId, null)).rejects.toThrow(/não commitadas/)
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('sujo\n')
  })

  it('hard reset with changes: undo restores both (staged stays staged)', async () => {
    const { manager, repo, sourceId } = await setup()
    const { one, two } = await history(repo)
    await writeFile(join(repo, 'a.txt'), 'alterado\n')
    await writeFile(join(repo, 'README.md'), 'preparado\n'); await git(repo, 'add', 'README.md')
    await manager.commitAction(sourceId, { action: 'reset-hard', hash: one })
    expect(await out(repo, 'status', '--porcelain')).toBe('')
    await manager.undoLast(sourceId, null)
    expect(await head(repo)).toBe(two)
    expect(await out(repo, 'status', '--porcelain')).toBe('M  README.md\n M a.txt')
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('alterado\n')
    await manager.redoLast(sourceId, null)
    expect(await head(repo)).toBe(one); expect(await out(repo, 'status', '--porcelain')).toBe('')
  })

  it('hard reset with changes: redo refuses if the folder changed after the undo', async () => {
    const { manager, repo, sourceId } = await setup()
    const { one } = await history(repo)
    await writeFile(join(repo, 'a.txt'), 'alterado\n')
    await manager.commitAction(sourceId, { action: 'reset-hard', hash: one })
    await manager.undoLast(sourceId, null)
    await writeFile(join(repo, 'a.txt'), 'mais coisa\n')
    await expect(manager.redoLast(sourceId, null)).rejects.toThrow(/pasta mudou/)
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('mais coisa\n')
  })
})

describe('undo discard, stash and ignore', () => {
  it('discard: tracked, new and binary files come back; redo discards again', async () => {
    const { manager, repo, sourceId } = await setup()
    const binary = Buffer.from([0, 255, 1, 2, 0, 128])
    await writeFile(join(repo, 'README.md'), 'alterado\n'); await writeFile(join(repo, 'novo.txt'), 'novo\n'); await writeFile(join(repo, 'bin.dat'), binary)
    await manager.discardUnstaged(sourceId, null, ['README.md', 'novo.txt', 'bin.dat'])
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('# fixture\n'); expect(await exists(join(repo, 'novo.txt'))).toBe(false)
    expect((await manager.undoState(sourceId, null)).undo?.label).toBe('descartar 3 arquivos')
    await manager.undoLast(sourceId, null)
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('alterado\n'); expect(await readFile(join(repo, 'novo.txt'), 'utf8')).toBe('novo\n')
    expect((await readFile(join(repo, 'bin.dat'))).equals(binary)).toBe(true)
    await manager.redoLast(sourceId, null)
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('# fixture\n'); expect(await exists(join(repo, 'bin.dat'))).toBe(false)
  })

  it('discard: if a file changed afterwards, undo refuses without touching any', async () => {
    const { manager, repo, sourceId } = await setup()
    await writeFile(join(repo, 'README.md'), 'alterado\n'); await writeFile(join(repo, 'novo.txt'), 'novo\n')
    await manager.discardUnstaged(sourceId, null, ['README.md', 'novo.txt'])
    await writeFile(join(repo, 'README.md'), 'editado depois\n')
    await expect(manager.undoLast(sourceId, null)).rejects.toThrow(/README\.md mudou depois do descarte/)
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('editado depois\n'); expect(await exists(join(repo, 'novo.txt'))).toBe(false)
  })

  it('discard without a copies folder works, but does not go on the stack', async () => {
    const { database, repo, sourceId } = await setup()
    const manager = new GitManager(database)
    await writeFile(join(repo, 'README.md'), 'alterado\n')
    await manager.discardUnstaged(sourceId, null, ['README.md'])
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('# fixture\n')
    expect(await manager.undoState(sourceId, null)).toEqual({ undo: null, redo: null })
  })

  it('stash: undo restores the changes, redo stashes again', async () => {
    const { manager, repo, sourceId } = await setup()
    await writeFile(join(repo, 'README.md'), 'alterado\n'); await writeFile(join(repo, 'novo.txt'), 'novo\n')
    await manager.sync(sourceId, null, 'stash')
    expect(await out(repo, 'status', '--porcelain')).toBe('')
    await manager.undoLast(sourceId, null)
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('alterado\n'); expect(await readFile(join(repo, 'novo.txt'), 'utf8')).toBe('novo\n')
    expect(await out(repo, 'stash', 'list')).toBe('')
    await manager.redoLast(sourceId, null)
    expect(await out(repo, 'status', '--porcelain')).toBe(''); expect((await out(repo, 'stash', 'list')).split('\n')).toHaveLength(1)
  })

  it('stashing one file only touches it; another stash afterwards refuses the undo', async () => {
    const { manager, repo, sourceId } = await setup()
    await writeFile(join(repo, 'README.md'), 'alterado\n'); await writeFile(join(repo, 'outro.txt'), 'outro\n')
    await manager.stashFile(sourceId, null, 'README.md')
    expect(await readFile(join(repo, 'outro.txt'), 'utf8')).toBe('outro\n')
    await manager.undoLast(sourceId, null)
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('alterado\n')
    await manager.redoLast(sourceId, null)
    await git(repo, 'stash', 'push', '--include-untracked')
    await manager.undoLast(sourceId, null).then(() => { throw new Error('devia recusar') }, (error: Error) => expect(error.message).toMatch(/Outro stash/))
  })

  it('delete stash: undo puts it back in the list, redo deletes it', async () => {
    const { manager, repo, sourceId } = await setup()
    await writeFile(join(repo, 'README.md'), 'alterado\n')
    await git(repo, 'stash', 'push', '-m', 'meu stash')
    const hash = await out(repo, 'rev-parse', 'stash@{0}')
    await manager.stashAction(sourceId, { action: 'drop', ref: 'stash@{0}' })
    expect(await out(repo, 'stash', 'list')).toBe('')
    expect((await manager.undoState(sourceId, null)).undo?.label).toBe('apagar o stash "On main: meu stash"')
    await manager.undoLast(sourceId, null)
    expect(await out(repo, 'rev-parse', 'stash@{0}')).toBe(hash); expect(await out(repo, 'stash', 'list')).toContain('meu stash')
    await manager.redoLast(sourceId, null)
    expect(await out(repo, 'stash', 'list')).toBe('')
  })

  it('ignore: undo deletes the .gitignore that did not exist; with an existing one, restores the previous', async () => {
    const { manager, repo, sourceId } = await setup()
    await writeFile(join(repo, 'debug.log'), 'x\n')
    await manager.ignoreFile(sourceId, null, 'debug.log', 'file')
    expect(await readFile(join(repo, '.gitignore'), 'utf8')).toBe('/debug.log\n')
    await manager.undoLast(sourceId, null)
    expect(await exists(join(repo, '.gitignore'))).toBe(false)
    await manager.redoLast(sourceId, null)
    expect(await readFile(join(repo, '.gitignore'), 'utf8')).toBe('/debug.log\n')
    await manager.undoLast(sourceId, null)
    await writeFile(join(repo, '.gitignore'), 'node_modules\n'); await git(repo, 'add', '.gitignore'); await git(repo, 'commit', '-m', 'ignore')
    await writeFile(join(repo, 'a.log'), 'x\n')
    await manager.ignoreFile(sourceId, null, 'a.log', 'extension')
    expect(await readFile(join(repo, '.gitignore'), 'utf8')).toBe('node_modules\n*.log\n')
    await writeFile(join(repo, '.gitignore'), 'node_modules\n*.log\nmais\n')
    await expect(manager.undoLast(sourceId, null)).rejects.toThrow(/\.gitignore mudou/)
  })
})

describe('force push', () => {
  it('when the remote changed after the last fetch, refuses with its own code, fetches the branch and the next force uses the fresh lease', async () => {
    const { manager, repo, remote, root, sourceId } = await setup({ remote: true })
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', 'a.txt'); await git(repo, 'commit', '-m', 'um')
    await manager.sync(sourceId, null, 'push')
    const branch = await out(repo, 'branch', '--show-current')
    // someone else rewrites the remote branch from another clone
    const other = join(root, 'other'); await git(root, 'clone', remote, other)
    await git(other, 'config', 'user.email', 'o@x'); await git(other, 'config', 'user.name', 'Outra Pessoa')
    await git(other, 'commit', '--amend', '-m', 'reescrito por outra pessoa'); await git(other, 'push', '--force', 'origin', branch)
    // here: amend, so the push needs force; the lease (origin/branch) is now stale
    await git(repo, 'commit', '--amend', '-m', 'meu amend')
    const error = await manager.sync(sourceId, null, 'push', 'ff-only', true).then(() => '', (reason: Error) => reason.message)
    expect(error).toMatch(/^\[\[git-push-stale\]\]/)
    expect(error).toContain('reescrito por outra pessoa')
    expect(await out(remote, 'log', '-1', '--format=%s', branch)).toBe('reescrito por outra pessoa')
    // after seeing it, forcing again overwrites exactly that version
    await manager.sync(sourceId, null, 'push', 'ff-only', true)
    expect(await out(remote, 'log', '-1', '--format=%s', branch)).toBe('meu amend')
  })
})

describe('stack cleanup and gc protection', () => {
  it('push clears the stack; fetch does not', async () => {
    const { manager, repo, sourceId } = await setup({ remote: true })
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', 'a.txt')
    await manager.commit({ sourceId, cardId: null, message: 'um' })
    await manager.sync(sourceId, null, 'fetch')
    expect((await manager.undoState(sourceId, null)).undo?.label).toBe('commit "um"')
    await manager.sync(sourceId, null, 'push')
    expect(await manager.undoState(sourceId, null)).toEqual({ undo: null, redo: null })
    expect(await refs(repo)).toEqual([])
  })

  it('merge and cherry-pick also clear it', async () => {
    const { manager, repo, sourceId } = await setup()
    for (const [name, file] of [['dev', 'd.txt'], ['dev2', 'e.txt']] as const) { await git(repo, 'checkout', '-b', name, 'main'); await writeFile(join(repo, file), 'x\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', name) }
    await git(repo, 'checkout', 'main')
    const mark = async (message: string): Promise<void> => { await writeFile(join(repo, `${message}.txt`), 'a\n'); await git(repo, 'add', '.'); await manager.commit({ sourceId, cardId: null, message }) }
    await mark('um')
    expect((await manager.undoState(sourceId, null)).undo).not.toBeNull()
    await manager.commitAction(sourceId, { action: 'cherry-pick', hash: await out(repo, 'rev-parse', 'dev') })
    expect(await manager.undoState(sourceId, null)).toEqual({ undo: null, redo: null })
    await mark('dois')
    await manager.branchAction(sourceId, { action: 'merge', name: 'dev2' })
    expect(await manager.undoState(sourceId, null)).toEqual({ undo: null, redo: null })
    expect(await refs(repo)).toEqual([])
  })

  it('the protection refs exist while the entry lives and disappear when it leaves', async () => {
    const { manager, repo, sourceId } = await setup()
    const first = await head(repo)
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', 'a.txt')
    const one = (await manager.commit({ sourceId, cardId: null, message: 'um' })).hash
    const pinned = await refs(repo)
    expect(pinned).toHaveLength(2)
    expect(await Promise.all(pinned.map((ref) => out(repo, 'rev-parse', ref)))).toEqual(expect.arrayContaining([first, one]))
    await manager.undoLast(sourceId, null)
    await writeFile(join(repo, 'b.txt'), 'b\n'); await git(repo, 'add', 'b.txt')
    const two = (await manager.commit({ sourceId, cardId: null, message: 'dois' })).hash
    const now = await Promise.all((await refs(repo)).map((ref) => out(repo, 'rev-parse', ref)))
    expect(now.sort()).toEqual([first, two].sort())
  })

  it('on open, deletes the refs and copies left over from the previous session', async () => {
    const { database, repo, backup, projectId } = await setup()
    await git(repo, 'update-ref', 'refs/gearmod/undo/velha-0', await head(repo))
    await mkdir(join(backup, 'velha'), { recursive: true }); await writeFile(join(backup, 'velha', 'x'), 'x')
    const reopened = new GitManager(database, undefined, undefined, undefined, undefined, backup)
    await reopened.repos(projectId)
    expect(await refs(repo)).toEqual([])
    expect(await readdir(backup)).toEqual([])
  })

  it('deleting the copies folder along with the entry: leaving the stack removes the copied files', async () => {
    const { manager, repo, backup, sourceId } = await setup()
    await writeFile(join(repo, 'README.md'), 'alterado\n')
    await manager.discardUnstaged(sourceId, null, ['README.md'])
    expect(await readdir(backup)).toHaveLength(1)
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', 'a.txt')
    await manager.undoLast(sourceId, null)
    await manager.commit({ sourceId, cardId: null, message: 'ação nova' })
    expect(await readdir(backup)).toEqual([])
  })
})
