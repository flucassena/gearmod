import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { withErrorCode, type GitSnapshot, type Worktree } from '@gearmod/contracts'
import type { AppDatabase } from './database'
import { branchPrefixOf, findCardType } from '@gearmod/contracts'
import { projectCardTypes } from './card-types'
import { tm } from './i18n'

const exec = promisify(execFile)
export interface GitRunner { run(args: string[]): Promise<{ stdout: string; stderr: string }> }
export const nativeGit: GitRunner = { run: (args) => exec('git', args, { timeout: 120_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }) }

export class WorktreeService {
  constructor(private readonly database: AppDatabase, private readonly dataDir: string, private readonly git: GitRunner = nativeGit) {}

  /** Owner of the worktree the card uses: itself, or the card whose worktree it borrowed (`link`). */
  ownerOf(cardId: string): string {
    const linked = this.database.db.prepare(`SELECT o.id FROM cards c JOIN cards o ON o.id = c.worktree_card_id WHERE c.id = ?`).pluck().get(cardId) as string | undefined
    return linked ?? cardId
  }

  get(cardId: string): Worktree | null {
    const row = this.database.db.prepare(`SELECT id, card_id AS cardId, repo_path AS repoPath, path, branch, base_ref AS baseRef,
      created_at AS createdAt, cleanup_state AS cleanupState FROM worktrees WHERE card_id = ? ORDER BY created_at DESC LIMIT 1`).get(this.ownerOf(cardId)) as Worktree | undefined
    return row ?? null
  }

  /** Cards of the same project with an active worktree that this card can use (does not include itself nor cards that also use another's). */
  candidates(cardId: string): Array<{ cardId: string; title: string; branch: string; path: string }> {
    return this.database.db.prepare(`SELECT c.id AS cardId, c.title, w.branch, w.path FROM cards c JOIN worktrees w ON w.card_id = c.id
      WHERE c.project_id = (SELECT project_id FROM cards WHERE id = ?) AND c.id != ? AND c.worktree_card_id IS NULL AND w.cleanup_state = 'active'
        AND w.id = (SELECT id FROM worktrees x WHERE x.card_id = c.id ORDER BY x.created_at DESC LIMIT 1) ORDER BY c.updated_at DESC`).all(cardId, cardId) as Array<{ cardId: string; title: string; branch: string; path: string }>
  }

  /**
   * What a new card can start from, before the card exists: the worktrees of other cards that it could use and the ones made by hand
   * (Git lists them in the project's repositories and GearMod did not create them) that it could adopt.
   */
  async startOptions(projectId: string): Promise<{ cards: Array<{ cardId: string; title: string; branch: string; path: string }>; external: Array<{ path: string; repoPath: string; repoName: string; branch: string | null }> }> {
    const cards = this.database.db.prepare(`SELECT c.id AS cardId, c.title, w.branch, w.path FROM cards c JOIN worktrees w ON w.card_id = c.id
      WHERE c.project_id = ? AND c.worktree_card_id IS NULL AND w.cleanup_state = 'active'
        AND w.id = (SELECT id FROM worktrees x WHERE x.card_id = c.id ORDER BY x.created_at DESC LIMIT 1) ORDER BY c.updated_at DESC`).all(projectId) as Array<{ cardId: string; title: string; branch: string; path: string }>
    return { cards, external: await this.externalOptions(projectId) }
  }

  /** Worktrees that Git lists in the project's repositories and that are neither the main folder nor already a card's. Folders that are gone are left out. */
  async externalOptions(projectId: string): Promise<Array<{ path: string; repoPath: string; repoName: string; branch: string | null }>> {
    const project = this.database.db.prepare('SELECT local_path AS projectPath FROM projects WHERE id = ?').get(projectId) as { projectPath: string } | undefined
    if (!project) return []
    const taken = this.database.db.prepare(`SELECT w.path FROM worktrees w WHERE w.cleanup_state != 'removed'
      UNION SELECT m.path FROM worktree_members m JOIN worktrees w ON w.id = m.worktree_id WHERE w.cleanup_state != 'removed'`).pluck().all() as string[]
    const found: Array<{ path: string; repoPath: string; repoName: string; branch: string | null }> = []
    const realTaken = new Set(await Promise.all(taken.map(realKey))), seen = new Set<string>()
    const skip = async (path: string, repoPath: string): Promise<boolean> => { const key = await realKey(path); return key === await realKey(repoPath) || realTaken.has(key) || seen.has(key) }
    for (const source of await this.gitSources(projectId, project.projectPath)) {
      const listing = (await this.git.run(['-C', source.repoPath, 'worktree', 'list', '--porcelain']).catch(() => ({ stdout: '' }))).stdout
      for (const block of listing.split(/\r?\n\r?\n/)) {
        const path = /^worktree (.+)$/m.exec(block)?.[1]?.trim()
        if (!path || /^(bare|prunable)\b/m.test(block) || await skip(path, source.repoPath) || !await exists(path)) continue
        seen.add(await realKey(path))
        found.push({ path, repoPath: source.repoPath, repoName: source.name, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() ?? null })
      }
    }
    return found
  }

  /** The worktree made by hand that Git lists in the project's repositories at that path (compared by real path), if there is one. */
  async findExternal(projectId: string, path: string): Promise<{ path: string; repoPath: string; repoName: string; branch: string | null } | undefined> {
    const wanted = await realKey(path)
    for (const item of await this.externalOptions(projectId)) if (await realKey(item.path) === wanted) return item
    return undefined
  }

  /**
   * Makes the card work in a worktree that the user made by hand. GearMod only registers it: the folder and the branch stay the user's, so
   * removing the card's worktree later just lets it go (see `GitManager.deleteWorktree`). One repository only: nothing is created inside that folder.
   */
  async adopt(cardId: string, path: string): Promise<Worktree> {
    if (this.ownerOf(cardId) !== cardId) throw new Error(tm().worktrees.cardUsesAnotherWorktree)
    if (this.database.db.prepare(`SELECT 1 FROM worktrees WHERE card_id = ? AND cleanup_state = 'active' LIMIT 1`).get(cardId)) throw new Error(tm().worktrees.cardHasOwnWorktree)
    const card = this.database.db.prepare(`SELECT project_id AS projectId, NULLIF(cards.base_branch, '') AS baseBranch FROM cards WHERE id = ?`).get(cardId) as { projectId: string; baseBranch: string | null } | undefined
    if (!card) throw new Error(tm().common.cardNotFound)
    const chosen = await this.findExternal(card.projectId, path)
    if (!chosen) throw new Error(tm().worktrees.externalGone)
    if (!chosen.branch) throw new Error(tm().worktrees.externalDetached)
    const source = (await this.gitSources(card.projectId, chosen.repoPath)).find((item) => same(item.repoPath, chosen.repoPath))
    // The card's base (when one was chosen and exists in this repository) is where the branch's own work is counted from; otherwise the repository's current branch.
    let baseRef = source?.baseRef ?? 'HEAD'
    if (card.baseBranch) for (const candidate of [card.baseBranch, `origin/${card.baseBranch}`]) { if (await this.git.run(['-C', chosen.repoPath, 'rev-parse', '--verify', candidate]).then(() => true, () => false)) { baseRef = candidate; break } }
    const worktree: Worktree = { id: randomUUID(), cardId, repoPath: chosen.repoPath, path: chosen.path, branch: chosen.branch, baseRef, createdAt: new Date().toISOString(), cleanupState: 'active' }
    this.database.db.transaction(() => {
      this.database.db.prepare(`INSERT INTO worktrees(id, card_id, repo_path, path, branch, base_ref, created_at, cleanup_state, external) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
        .run(worktree.id, cardId, worktree.repoPath, worktree.path, worktree.branch, worktree.baseRef, worktree.createdAt, worktree.cleanupState)
      this.database.db.prepare(`INSERT INTO worktree_members(id, worktree_id, repo_path, path, base_ref, status, error) VALUES (?, ?, ?, ?, ?, 'active', NULL)`)
        .run(randomUUID(), worktree.id, worktree.repoPath, worktree.path, baseRef)
      // The card's repository is the one the worktree belongs to.
      this.database.db.prepare('UPDATE cards SET source_id = COALESCE((SELECT id FROM project_sources WHERE project_id = ? AND local_path = ?), source_id) WHERE id = ?').run(card.projectId, worktree.repoPath, cardId)
    })()
    return worktree
  }

  /** True when the card's worktree is one the user made (adopted): GearMod must never delete its folder or branch. */
  isExternal(cardId: string): boolean {
    return Boolean(this.database.db.prepare(`SELECT 1 FROM worktrees WHERE card_id = ? AND external = 1 AND cleanup_state = 'active' LIMIT 1`).get(this.ownerOf(cardId)))
  }

  /** Makes the card use another's worktree (or goes back to having its own with `null`). It only sees and works there: cleanup and merge remain the owner's. */
  link(cardId: string, fromCardId: string | null): void {
    if (fromCardId === null) { this.database.db.prepare('UPDATE cards SET worktree_card_id = NULL WHERE id = ?').run(cardId); return }
    if (fromCardId === cardId) throw new Error(tm().worktrees.cardCannotUseOwn)
    if (!this.candidates(cardId).some((item) => item.cardId === fromCardId)) throw new Error(tm().worktrees.otherCardNoWorktree)
    const own = this.database.db.prepare(`SELECT 1 FROM worktrees WHERE card_id = ? AND cleanup_state = 'active' LIMIT 1`).get(cardId)
    if (own) throw new Error(tm().worktrees.cardHasOwnWorktree)
    this.database.db.prepare('UPDATE cards SET worktree_card_id = ? WHERE id = ?').run(fromCardId, cardId)
  }

  /** If the file is inside another card's worktree (and this card does not use it yet), returns who the owner is. */
  foreignOwner(cardId: string, filePath: string): { cardId: string; title: string } | null {
    const normal = (value: string): string => value.split(String.fromCharCode(92)).join('/').toLowerCase()
    const target = normal(filePath), mine = this.ownerOf(cardId)
    const rows = this.database.db.prepare(`SELECT c.id AS cardId, c.title, w.path FROM worktrees w JOIN cards c ON c.id = w.card_id
      WHERE c.project_id = (SELECT project_id FROM cards WHERE id = ?) AND c.id != ? AND w.cleanup_state = 'active'`).all(cardId, mine) as Array<{ cardId: string; title: string; path: string }>
    const hit = rows.find((row) => { const base = normal(row.path).replace(/\/+$/, ''); return target === base || target.startsWith(`${base}/`) })
    return hit ? { cardId: hit.cardId, title: hit.title } : null
  }

  /**
   * Composite worktree of the card: one folder per involved repository (`cards.repo_ids`; empty = only the project's first repository, the others join on demand), all on the
   * same branch. A failure in one repository does not undo the others: it stays `failed` with the error and the next preparation tries again.
   * A repository that joins the card later (the agent found out it needs it) gets its folder in the worktree that already exists.
   */
  async prepare(cardId: string): Promise<Worktree> {
    const owner = this.ownerOf(cardId)
    if (owner !== cardId) return this.prepare(owner)
    // Two runs of the same card must not compete for `worktree add`: the second waits for the first and reuses its result.
    const running = this.preparing.get(cardId)
    const next = (running ?? Promise.resolve()).catch(() => undefined).then(() => this.prepareNow(cardId))
    this.preparing.set(cardId, next)
    try { return await next } finally { if (this.preparing.get(cardId) === next) this.preparing.delete(cardId) }
  }
  private readonly preparing = new Map<string, Promise<Worktree>>()

  private async prepareNow(cardId: string): Promise<Worktree> {
    const existing = this.get(cardId)
    const alive = existing && await exists(existing.path) ? existing : null
    if (existing && !alive) this.database.db.prepare(`UPDATE worktrees SET cleanup_state = 'missing' WHERE id = ?`).run(existing.id)
    // A worktree the user made and the card adopted is used as it is: nothing is created, renamed or added inside it.
    if (alive && this.database.db.prepare('SELECT external FROM worktrees WHERE id = ?').pluck().get(alive.id) === 1) return alive
    const card = this.database.db.prepare(`SELECT c.title, c.type AS type, c.project_id AS projectId, NULLIF(c.base_branch, '') AS baseBranch, c.repo_ids AS repoIds, p.local_path AS projectPath
      FROM cards c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`).get(cardId) as { title: string; type: string; projectId: string; baseBranch: string | null; repoIds: string | null; projectPath: string } | undefined
    if (!card) throw new Error(tm().common.cardNotFound)
    const all = await this.gitSources(card.projectId, card.projectPath)
    if (!all.length) throw new Error(tm().worktrees.noGitRepoFound)
    const wanted = card.repoIds ? JSON.parse(card.repoIds) as string[] : null
    // With no repositories chosen on the card, a new worktree starts with all of them (the agent then keeps only the ones it will change, see `trim`);
    // an existing one keeps the repositories it already has. The others join on demand (ensureMember).
    const had = alive ? this.members(alive.id).filter((member) => member.status === 'active') : []
    const kept = all.filter((source) => had.some((member) => same(member.repoPath, source.repoPath)))
    const sources = wanted?.length ? all.filter((source) => wanted.includes(source.id)) : alive ? (kept.length ? kept : all.slice(0, 1)) : all
    if (!sources.length) throw new Error(tm().worktrees.chosenReposGone)
    // Short path (wt/<8 letters of the card>/<repo>): on Windows the 260-character limit breaks repositories with long names (migrations etc.).
    const short = cardId.slice(0, 8), path = alive?.path ?? join(this.dataDir, 'wt', short)
    await mkdir(path, { recursive: true })
    const slug = plain(card.title).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 36) || 'task'
    // A recreated worktree (deleted folder) stays on the branch it already had, even if the generated name has changed.
    // The branch is born with the card type's prefix, in English by default (feature/, fix/, hotfix/...); whoever wants can change the prefix in the type.
    // The branch can be born before the card has a title (the agent names it later): "feature/task-<id>". Once the title exists, the branch takes its name.
    const renamed = alive && slug !== 'task' ? await this.renamePlaceholderBranch(alive, slug, short) : null
    const branch = renamed ?? existing?.branch ?? `${branchPrefixOf(findCardType(projectCardTypes(this.database.db, card.projectId).types, card.type), card.type)}/${slug}-${short}`
    if (alive && renamed) alive.branch = renamed
    const current = alive ? this.members(alive.id) : []
    const todo = sources.filter((source) => !current.some((member) => same(member.repoPath, source.repoPath) && member.status === 'active' && existsSync(member.path)))
    if (alive && !todo.length) return alive
    const results: Array<{ repoPath: string; path: string; baseRef: string; error: string | null }> = []
    for (const source of todo) {
      const index = all.findIndex((item) => item.id === source.id)
      const memberPath = current.find((member) => same(member.repoPath, source.repoPath))?.path ?? join(path, `${index + 1}-${memberName(source.name, index)}`)
      results.push(await this.addMember(source, card.baseBranch, branch, memberPath))
    }
    const ok = results.filter((item) => !item.error)
    if (!alive && !ok.length) throw new Error(results.map((item) => item.error).join('\n'))
    const first = sources[0]!
    const worktree: Worktree = alive ?? { id: randomUUID(), cardId, repoPath: card.projectPath, path, branch, baseRef: ok[0]?.baseRef ?? first.baseRef, createdAt: new Date().toISOString(), cleanupState: 'active' }
    this.database.db.transaction(() => {
      if (!alive) this.database.db.prepare(`INSERT INTO worktrees(id, card_id, repo_path, path, branch, base_ref, created_at, cleanup_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(worktree.id, worktree.cardId, worktree.repoPath, worktree.path, worktree.branch, worktree.baseRef, worktree.createdAt, worktree.cleanupState)
      const upsert = this.database.db.prepare(`INSERT INTO worktree_members(id, worktree_id, repo_path, path, base_ref, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worktree_id, repo_path) DO UPDATE SET path = excluded.path, base_ref = excluded.base_ref, status = excluded.status, error = excluded.error`)
      results.forEach((item) => upsert.run(randomUUID(), worktree.id, item.repoPath, item.path, item.baseRef, item.error ? 'failed' : 'active', item.error))
    })()
    return worktree
  }

  /**
   * Renames the placeholder branch (`<prefix>/task-<id>`) to one that follows the card title. Only when it is safe: every repository's branch
   * has no commit of its own and was never published (no upstream), and the new name is free. Returns the new name, or null when nothing changed.
   */
  private async renamePlaceholderBranch(worktree: Worktree, slug: string, short: string): Promise<string | null> {
    const old = worktree.branch, marker = `/task-${short}`
    if (!old.endsWith(marker)) return null
    const next = `${old.slice(0, -marker.length)}/${slug}-${short}`
    const members = this.members(worktree.id).filter((member) => member.status === 'active' && existsSync(member.path))
    if (!members.length) return null
    try {
      for (const member of members) {
        const base = member.baseRef
        const unique = Number((await this.git.run(['-C', member.path, 'rev-list', '--count', `${base}..${old}`])).stdout.trim()) || 0
        const upstream = (await this.git.run(['-C', member.path, 'config', '--get', `branch.${old}.remote`]).catch(() => ({ stdout: '' }))).stdout.trim()
        const taken = (await this.git.run(['-C', member.path, 'branch', '--list', next])).stdout.trim()
        if (unique > 0 || upstream || taken) return null
      }
      const done: string[] = []
      try {
        for (const member of members) { await this.git.run(['-C', member.path, 'branch', '-m', old, next]); done.push(member.path) }
      } catch (error) {
        for (const path of done) await this.git.run(['-C', path, 'branch', '-m', next, old]).catch(() => undefined)  // all or nothing
        throw error
      }
      this.database.db.prepare('UPDATE worktrees SET branch = ? WHERE id = ?').run(next, worktree.id)
      return next
    } catch { return null }
  }

  /** Creates (or confirms) a repository's folder in the worktree, on the card's branch; never throws — the error goes in the `error` field. */
  private async addMember(source: { repoPath: string; name: string; baseRef: string }, cardBaseBranch: string | null, branch: string, memberPath: string): Promise<{ repoPath: string; path: string; baseRef: string; error: string | null }> {
    let baseRef = source.baseRef
    try {
      // Branch chosen at start: applies to the repositories that have it (local or in origin); in the others the current branch stays.
      if (cardBaseBranch) for (const candidate of [cardBaseBranch, `origin/${cardBaseBranch}`]) { if (await this.git.run(['-C', source.repoPath, 'rev-parse', '--verify', candidate]).then(() => true, () => false)) { baseRef = candidate; break } }
      // Always from the latest version of the base: fetches it and uses the remote's when the local copy is behind.
      baseRef = await this.freshest(source.repoPath, baseRef)
      await this.git.run(['-C', source.repoPath, 'rev-parse', '--verify', baseRef])
      await this.releaseStale(source.repoPath, branch, memberPath)
      try {
        try { await this.git.run(['-c', 'core.longpaths=true', '-C', source.repoPath, 'worktree', 'add', '-b', branch, memberPath, baseRef]) }
        catch (error) {
          const branches = await this.git.run(['-C', source.repoPath, 'branch', '--list', branch])
          if (!branches.stdout.trim()) throw error
          // Existing branch: with its own commits (work from a deleted worktree) it is reused as is; with no commit that the base
          // does not have, it would just be sitting at an old point, so it is recreated on top of the current base.
          const unique = Number((await this.git.run(['-C', source.repoPath, 'rev-list', '--count', `${baseRef}..${branch}`])).stdout.trim()) || 0
          await this.git.run(['-c', 'core.longpaths=true', '-C', source.repoPath, 'worktree', 'add', ...(unique === 0 ? ['-B', branch, memberPath, baseRef] : [memberPath, branch])])
        }
      } catch (error) {
        // A half-created worktree holds the branch and blocks the next attempt: undoes it before warning.
        await this.discard(source.repoPath, memberPath)
        throw error
      }
      return { repoPath: source.repoPath, path: memberPath, baseRef, error: null }
    } catch (error) {
      return { repoPath: source.repoPath, path: memberPath, baseRef, error: friendlyGitError(error, source.name) }
    }
  }

  /**
   * Latest version of a base branch: fetches it from origin (quick, without asking for credentials) and returns `origin/<branch>`, unless the local
   * branch has commits the remote does not (then the local one) or there is no remote copy (offline, or never published: the local one).
   */
  private async freshest(repoPath: string, ref: string): Promise<string> {
    const branch = ref.replace(/^origin\//, '')
    if (!branch || branch === 'HEAD') return ref
    const verify = (name: string): Promise<boolean> => this.git.run(['-C', repoPath, 'rev-parse', '--verify', '-q', `${name}^{commit}`]).then(() => true, () => false)
    const remotes = await this.git.run(['-C', repoPath, 'remote']).then((result) => result.stdout.split(/\r?\n/).map((item) => item.trim()), () => [] as string[])
    if (!remotes.includes('origin')) return ref
    const fetch = this.git.run(['-c', 'credential.interactive=never', '-C', repoPath, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]).then(() => undefined, () => undefined)
    await Promise.race([fetch, new Promise<void>((done) => setTimeout(done, 20_000))])
    const [local, remote] = await Promise.all([verify(`refs/heads/${branch}`), verify(`refs/remotes/origin/${branch}`)])
    if (!remote) return local ? branch : ref
    if (!local) return `origin/${branch}`
    const ahead = Number((await this.git.run(['-C', repoPath, 'rev-list', '--count', `origin/${branch}..${branch}`]).catch(() => ({ stdout: '0' }))).stdout.trim()) || 0
    return ahead > 0 ? branch : `origin/${branch}`
  }

  /**
   * Keeps in the card's worktree only the repositories it works in (`keep`, ids of project repositories): the others leave the worktree (folder
   * and branch) when they have nothing of their own (no uncommitted change and no commit beyond the base). The ones with work stay, and say why.
   * A worktree adopted from outside or shared with other cards is not touched. A repository that left comes back with `prepare`/`ensureMember`.
   */
  async trim(cardId: string, keep: string[]): Promise<{ removed: string[]; kept: Array<{ name: string; reason: string }> }> {
    const owner = this.ownerOf(cardId), worktree = this.get(owner), done = { removed: [] as string[], kept: [] as Array<{ name: string; reason: string }> }
    if (!worktree || owner !== cardId || this.isExternal(owner)) return done
    if (this.database.db.prepare('SELECT 1 FROM cards WHERE worktree_card_id = ? AND id <> ? LIMIT 1').get(owner, owner)) return done
    const projectId = this.database.db.prepare('SELECT project_id FROM cards WHERE id = ?').pluck().get(owner) as string | undefined
    if (!projectId) return done
    const sources = this.database.db.prepare('SELECT id, name, local_path AS repoPath FROM project_sources WHERE project_id = ?').all(projectId) as Array<{ id: string; name: string; repoPath: string }>
    const wanted = sources.filter((source) => keep.includes(source.id))
    if (!wanted.length) return done
    for (const member of this.members(worktree.id)) {
      if (wanted.some((source) => same(source.repoPath, member.repoPath))) continue
      const name = sources.find((source) => same(source.repoPath, member.repoPath))?.name ?? basename(member.repoPath)
      if (member.status === 'active' && existsSync(member.path)) {
        const changes = await this.git.run(['-C', member.path, 'status', '--porcelain']).then((result) => result.stdout.trim(), () => 'unknown')
        if (changes) { done.kept.push({ name, reason: 'has uncommitted changes' }); continue }
        const ahead = Number((await this.git.run(['-C', member.path, 'rev-list', '--count', `${member.baseRef}..HEAD`]).catch(() => ({ stdout: '1' }))).stdout.trim()) || 0
        if (ahead > 0) { done.kept.push({ name, reason: 'has commits of its own' }); continue }
        await this.discard(member.repoPath, member.path)
        await this.git.run(['-C', member.repoPath, 'branch', '-D', worktree.branch]).catch(() => undefined)
      }
      this.database.db.prepare('DELETE FROM worktree_members WHERE worktree_id = ? AND repo_path = ?').run(worktree.id, member.repoPath)
      done.removed.push(name)
    }
    return done
  }

  private readonly ensuring = new Map<string, Promise<unknown>>()
  /**
   * G07 — ensures a specific repository is in the card's composite worktree, even outside `cards.repo_ids` (e.g. the
   * SDD repository, which only joins on the first write). Idempotent: a repository already a member and active is not recreated. Does not
   * recreate the other existing members. Two concurrent calls for the same card+repository are serialized (the
   * second reuses the first's result), so they never compete for the same folder/branch in Git.
   */
  async ensureMember(cardId: string, sourceId: string): Promise<{ repoPath: string; path: string; baseRef: string; status: 'active' | 'failed'; error: string | null }> {
    const owner = this.ownerOf(cardId)
    const key = `${owner}:${sourceId}`
    const prior = this.ensuring.get(key) ?? Promise.resolve()
    const next = prior.catch(() => undefined).then(() => this.ensureMemberNow(owner, sourceId))
    this.ensuring.set(key, next)
    try { return await next } finally { if (this.ensuring.get(key) === next) this.ensuring.delete(key) }
  }

  private async ensureMemberNow(owner: string, sourceId: string): Promise<{ repoPath: string; path: string; baseRef: string; status: 'active' | 'failed'; error: string | null }> {
    const worktree = await this.prepare(owner)
    const source = this.database.db.prepare(`SELECT name, local_path AS repoPath, COALESCE(NULLIF(base_branch, ''), current_branch) AS baseRef FROM project_sources WHERE id = ?`).get(sourceId) as { name: string; repoPath: string; baseRef: string } | undefined
    if (!source) throw new Error(tm().common.repoNotFoundInProject)
    const current = this.members(worktree.id)
    const existing = current.find((member) => same(member.repoPath, source.repoPath))
    if (existing && existing.status === 'active' && existsSync(existing.path)) return existing
    if (this.isExternal(owner)) return { repoPath: source.repoPath, path: worktree.path, baseRef: worktree.baseRef, status: 'failed', error: tm().worktrees.externalOneRepo }
    const card = this.database.db.prepare(`SELECT NULLIF(cards.base_branch, '') AS baseBranch FROM cards WHERE id = ?`).get(owner) as { baseBranch: string | null }
    // First free number: a repository that left the worktree (trim) leaves a gap.
    let slot = current.length + 1
    while (current.some((member) => basename(member.path).startsWith(`${slot}-`)) || existsSync(join(worktree.path, `${slot}-${memberName(source.name, slot - 1)}`))) slot++
    const memberPath = existing?.path ?? join(worktree.path, `${slot}-${memberName(source.name, slot - 1)}`)
    const result = await this.addMember(source, card.baseBranch, worktree.branch, memberPath)
    this.database.db.prepare(`INSERT INTO worktree_members(id, worktree_id, repo_path, path, base_ref, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worktree_id, repo_path) DO UPDATE SET path = excluded.path, base_ref = excluded.base_ref, status = excluded.status, error = excluded.error`)
      .run(randomUUID(), worktree.id, result.repoPath, result.path, result.baseRef, result.error ? 'failed' : 'active', result.error)
    return { ...result, status: result.error ? 'failed' : 'active' }
  }

  /** State of each repository in the card's worktree: `active` (folder ready), `failed` (with the error) or `missing` (folder gone). */
  repositories(cardId: string): Array<{ repoPath: string; path: string; baseRef: string; status: 'active' | 'failed' | 'missing'; error: string | null; prUrl: string | null }> {
    const worktree = this.get(cardId)
    if (!worktree) return []
    return this.members(worktree.id).map((member) => ({ ...member, status: member.status === 'active' && !existsSync(member.path) ? 'missing' : member.status }))
  }

  private members(worktreeId: string): Array<{ repoPath: string; path: string; baseRef: string; status: 'active' | 'failed'; error: string | null; prUrl: string | null }> {
    return this.database.db.prepare('SELECT repo_path AS repoPath, path, base_ref AS baseRef, status, error, pr_url AS prUrl FROM worktree_members WHERE worktree_id = ? ORDER BY path').all(worktreeId) as Array<{ repoPath: string; path: string; baseRef: string; status: 'active' | 'failed'; error: string | null; prUrl: string | null }>
  }

  /** Project Git repositories; without a registry, searches the project folder and saves what it found. */
  private async gitSources(projectId: string, projectPath: string): Promise<Array<{ id: string; name: string; repoPath: string; baseRef: string }>> {
    // Each repository's own base branch (set in the Git tab or when the project was created); without one, its current branch.
    const read = (): Array<{ id: string; name: string; repoPath: string; baseRef: string }> => this.database.db.prepare(`SELECT id, name, local_path AS repoPath, COALESCE(NULLIF(base_branch, ''), current_branch) AS baseRef
      FROM project_sources WHERE project_id = ? AND is_git_repository = 1 ORDER BY sort_order`).all(projectId) as Array<{ id: string; name: string; repoPath: string; baseRef: string }>
    const saved = read()
    if (saved.length) return saved
    const found = await this.discoverRepositories(projectPath)
    this.database.db.transaction(() => {
      const update = this.database.db.prepare('UPDATE project_sources SET name = ?, is_git_repository = 1, current_branch = ? WHERE project_id = ? AND local_path = ?')
      const insert = this.database.db.prepare(`INSERT OR IGNORE INTO project_sources(id, project_id, name, local_path, is_git_repository, current_branch, sort_order)
        VALUES (?, ?, ?, ?, 1, ?, ?)`)
      found.forEach((source, index) => {
        const changed = update.run(source.name, source.baseRef, projectId, source.repoPath).changes
        if (!changed) insert.run(randomUUID(), projectId, source.name, source.repoPath, source.baseRef, index + 1)
      })
    })()
    return read()
  }

  async snapshot(cardId: string): Promise<GitSnapshot> {
    const worktree = this.get(cardId)
    if (!worktree) throw new Error(withErrorCode('no-worktree', tm().worktrees.notCreatedYet))
    if (!await exists(worktree.path)) {
      this.database.db.prepare(`UPDATE worktrees SET cleanup_state = 'missing' WHERE id = ?`).run(worktree.id)
      return { worktreeId: worktree.id, status: '', diff: '', exists: false }
    }
    const members = this.database.db.prepare(`SELECT repo_path AS repoPath, path, base_ref AS baseRef FROM worktree_members WHERE worktree_id = ? AND status = 'active' ORDER BY path`).all(worktree.id) as Array<{ repoPath: string; path: string; baseRef: string }>
    const targets: typeof members = []
    for (const member of members) {
      const state = await directoryState(member.path)
      if (state !== 'missing') { targets.push(member); continue }
      // The folder was deleted outside GearMod: removes both the orphan Git link and the local record.
      // Permission failures do not come in here and remain visible to the user, since they may be temporary.
      await this.git.run(['-C', member.repoPath, 'worktree', 'prune']).catch(() => undefined)
      this.database.db.prepare('DELETE FROM worktree_members WHERE worktree_id = ? AND path = ?').run(worktree.id, member.path)
    }
    if (members.length && !targets.length) {
      this.database.db.prepare(`UPDATE worktrees SET cleanup_state = 'missing' WHERE id = ?`).run(worktree.id)
      return { worktreeId: worktree.id, status: '', diff: '', exists: false }
    }
    if (!members.length) targets.push({ repoPath: worktree.repoPath, path: worktree.path, baseRef: worktree.baseRef })
    const snapshots = await Promise.all(targets.map(async (member) => {
      // What the card changed is counted from the point where the branch left the base (merge-base), not from the current tip of the base:
      // otherwise everything the base gained afterwards (or has extra) would appear as if the card had deleted it.
      const since = await this.mergeBase(member)
      const [status, diff] = await Promise.all([
        this.git.run(['-C', member.path, 'status', '--short', '--branch']),
        this.git.run(['-C', member.path, 'diff', '--no-ext-diff', '--binary', since, '--'])
      ])
      // The worktree's real root accompanies each chunk: the changes screen needs it to open relative paths
      // correctly when the card uses more than one repository.
      return { heading: `\n### GearMod root: ${member.path}\n`, status: status.stdout, diff: diff.stdout }
    }))
    return { worktreeId: worktree.id, status: snapshots.map((item) => `${item.heading}${item.status}`).join(''), diff: snapshots.map((item) => `${item.heading}${item.diff}`).join(''), exists: true }
  }

  /**
   * Repositories of the card's worktree and whether the card changed each one (commits since it left the base, or uncommitted files).
   * A card with a single repository has no members: the worktree itself is the only one.
   */
  async changedRepos(cardId: string): Promise<Array<{ repoPath: string; path: string; changed: boolean }>> {
    const worktree = this.get(cardId)
    if (!worktree) throw new Error(withErrorCode('no-worktree', tm().worktrees.notCreatedYet))
    const members = this.database.db.prepare(`SELECT repo_path AS repoPath, path, base_ref AS baseRef FROM worktree_members WHERE worktree_id = ? AND status = 'active' ORDER BY path`).all(worktree.id) as Array<{ repoPath: string; path: string; baseRef: string }>
    const targets = members.length ? members : [{ repoPath: worktree.repoPath, path: worktree.path, baseRef: worktree.baseRef }]
    return Promise.all(targets.filter((member) => existsSync(member.path)).map(async (member) => {
      const since = await this.mergeBase(member)
      const [status, diff] = await Promise.all([
        this.git.run(['-C', member.path, 'status', '--porcelain']).then((result) => result.stdout.trim(), () => ''),
        this.git.run(['-C', member.path, 'diff', '--name-only', since, 'HEAD', '--']).then((result) => result.stdout.trim(), () => '')
      ])
      return { repoPath: member.repoPath, path: member.path, changed: Boolean(status || diff) }
    }))
  }

  /** Card's exit point in the repository (merge-base with the base; without it, the base itself): the "before" of everything the card changed. */
  private mergeBase(member: { path: string; baseRef: string }): Promise<string> {
    return this.git.run(['-C', member.path, 'merge-base', member.baseRef, 'HEAD']).then((result) => result.stdout.trim() || member.baseRef, () => member.baseRef)
  }

  /** "Before" reference of a worktree repository (the worktree's `repoPath` folder); `null` if the folder belongs to no member. */
  async baseFor(cardId: string, repoPath: string): Promise<{ ref: string; label: string } | null> {
    const worktree = this.get(cardId)
    if (!worktree) return null
    const member = this.members(worktree.id).find((item) => item.status === 'active' && same(item.path, repoPath))
    return member ? { ref: await this.mergeBase(member), label: tm().worktrees.cardStartingPoint(member.baseRef) } : null
  }

  /** Releases the branch of old GearMod worktrees that were left broken (deleted folder or interrupted creation). */
  private async releaseStale(repoPath: string, branch: string, target: string): Promise<void> {
    await this.git.run(['-C', repoPath, 'worktree', 'prune']).catch(() => undefined)
    const list = await this.git.run(['-C', repoPath, 'worktree', 'list', '--porcelain']).catch(() => ({ stdout: '' }))
    // Real path on both sides: Git returns the long name and Windows may hand over the short one (FRANCI~1).
    const real = async (path: string): Promise<string> => (await realpath(path).catch(() => resolve(path))).toLowerCase()
    const ours = await real(this.dataDir), wanted = await real(target)
    for (const block of list.stdout.split(/\r?\n\r?\n/)) {
      const path = /^worktree (.+)$/m.exec(block)?.[1]?.trim(), ref = /^branch (.+)$/m.exec(block)?.[1]?.trim()
      if (!path) continue
      const found = await real(path)
      if ((ref !== `refs/heads/${branch}` && found !== wanted) || !found.startsWith(ours)) continue
      if (await exists(path) && this.database.db.prepare(`SELECT 1 FROM worktree_members WHERE path = ?`).get(path)) continue
      await this.discard(repoPath, path)
    }
  }

  private async discard(repoPath: string, path: string): Promise<void> {
    await this.git.run(['-C', repoPath, 'worktree', 'remove', '--force', path]).catch(() => undefined)
    await rm(path, { recursive: true, force: true }).catch(() => undefined)
    await this.git.run(['-C', repoPath, 'worktree', 'prune']).catch(() => undefined)
  }

  private async discoverRepositories(projectPath: string): Promise<Array<{ name: string; repoPath: string; baseRef: string }>> {
    const inspect = async (path: string): Promise<{ name: string; repoPath: string; baseRef: string } | null> => {
      try {
        const root = resolve((await this.git.run(['-C', path, 'rev-parse', '--show-toplevel'])).stdout.trim())
        const branch = (await this.git.run(['-C', root, 'branch', '--show-current'])).stdout.trim()
        return branch ? { name: basename(root), repoPath: root, baseRef: branch } : null
      } catch { return null }
    }
    const direct = await inspect(projectPath)
    if (direct) return [direct]
    const children = await readdir(projectPath, { withFileTypes: true })
    const found = await Promise.all(children.filter((entry) => entry.isDirectory() && entry.name !== '.git').map((entry) => inspect(join(projectPath, entry.name))))
    return found.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  }
}

/** Same path, case-insensitive (Windows). */
const same = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()
/** Real path in lowercase: Git hands over the long name and Windows may have stored the short one (FRANCI~1). */
const realKey = async (path: string): Promise<string> => (await realpath(path).catch(() => resolve(path))).toLowerCase()

/** Strips accents ("Botão" → "Botao") before it becomes a branch or folder name. */
const plain = (text: string): string => text.normalize('NFKD').replace(/[̀-ͯ]/g, '')

/** Name of the repository folder inside the composite worktree (short, with no accent or special character). */
const memberName = (name: string, index: number): string => plain(name).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 24) || `repo-${index + 1}`

function friendlyGitError(error: unknown, repo: string): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/Filename too long/i.test(text)) return tm().worktrees.longPaths(repo)
  const detail = text.split(/\r?\n/).find((line) => /^(fatal|error):/.test(line.trim()))?.trim()
  return tm().worktrees.createFailed(repo, detail)
}

async function exists(path: string): Promise<boolean> { return stat(path).then((value) => value.isDirectory(), () => false) }

/** Tells a removed folder from a temporarily denied access; only the first case allows deleting the record. */
async function directoryState(path: string): Promise<'available' | 'missing' | 'unavailable'> {
  try { return (await stat(path)).isDirectory() ? 'available' : 'missing' }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR' ? 'missing' : 'unavailable' }
}
