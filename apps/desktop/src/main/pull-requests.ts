import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prMergeMethodSchema } from '@gearmod/contracts'
import type { PrCommit, PrCompare, PrMergeMethod, PrCreateOptions, PrFile, PrPipeline, PrVersion, PullRequestDetail, PullRequestList, PullRequestSummary } from '@gearmod/contracts'
import type { AppDatabase } from './database'
import { nativeCli, type CliRunner } from './git-manager'
import { nativeGit, type GitRunner } from './worktrees'
import { tm } from './i18n'
import type { GitAccounts } from './git-accounts'
import { guessProvider, HostApi, HostAuthError, type RemoteRef } from './git-host-api'
import * as actions from './pr-actions'
import type { CreateInput, HttpMethod, RepoCall, PrState } from './pr-actions'
import type { LineCommentInput } from './pr-positions'

type Provider = 'github' | 'gitlab'
const cliOf = (provider: Provider): string => provider === 'gitlab' ? 'glab' : 'gh'
const cliError = (provider: Provider, error: unknown): string => {
  const cli = cliOf(provider), name = provider === 'gitlab' ? 'GitLab CLI' : 'GitHub CLI'
  const text = [(error as { stderr?: string })?.stderr, error instanceof Error ? error.message : String(error)].filter(Boolean).join('\n')
  if (/ENOENT|not recognized|não é reconhecido/i.test(text)) return tm().pullRequests.installCli(name, cli)
  if (/auth login|not logged in|authentication|401/i.test(text)) return tm().pullRequests.notAuthenticated(name, cli)
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !/^Command failed/i.test(line))?.slice(0, 300) ?? tm().pullRequests.cliFailed(name)
}
const problemOf = (error: unknown): 'no-cli' | 'not-logged-in' | null => {
  const text = [(error as { stderr?: string })?.stderr, error instanceof Error ? error.message : String(error)].filter(Boolean).join(' ')
  return /ENOENT|not recognized|não é reconhecido|Instale o|Install /i.test(text) ? 'no-cli' : /auth login|not logged in|authentication|401|não está autenticado|not authenticated/i.test(text) ? 'not-logged-in' : null
}
interface RawPr {
  number: number; title: string; url: string; isDraft?: boolean; headRefName: string; baseRefName: string; updatedAt: string; createdAt?: string; reviewDecision?: string | null
  author?: { login?: string } | null; assignees?: Array<{ login?: string }>; reviewRequests?: Array<{ login?: string; slug?: string }>; comments?: unknown[]; labels?: Array<{ name?: string; color?: string }>
}
interface RawMr {
  iid: number; title: string; web_url: string; draft?: boolean; work_in_progress?: boolean; source_branch: string; target_branch: string; updated_at: string; created_at?: string
  author?: { username?: string } | null; assignees?: Array<{ username?: string; name?: string; avatar_url?: string | null; public_email?: string | null }>; reviewers?: Array<{ username?: string }>; user_notes_count?: number; labels?: Array<string | { name?: string; color?: string }>
}

/** The CLI door into the repository: `gh api`/`glab api` with the JSON body in a temp file (the runner has no stdin), always removed afterwards. The token never goes in the file. */
export function cliRepoCall(cli: CliRunner, provider: Provider, dir: string, viewer: string | null, tempRoot: string = tmpdir()): RepoCall {
  return {
    provider, viewer,
    async call<T>(method: HttpMethod, subpath: string, body?: unknown, options?: { text?: boolean }): Promise<T> {
      const tail = subpath ? `/${subpath}` : ''
      const endpoint = provider === 'gitlab' ? `projects/:id${tail}` : `repos/{owner}/{repo}${tail}`
      const args = ['api', '-X', method, endpoint]
      let folder: string | null = null
      try {
        if (body !== undefined) {
          folder = await mkdtemp(join(tempRoot, 'gearmod-pr-'))
          const file = join(folder, 'body.json')
          await writeFile(file, JSON.stringify(body), 'utf8')
          args.push('-H', 'Content-Type: application/json', '--input', file)
        }
        const out = await cli.run(cliOf(provider), args, dir)
        if (options?.text) return out as T
        return (out.trim() ? JSON.parse(out) : undefined) as T
      } catch (error) {
        throw new Error(cliError(provider, error))
      } finally {
        if (folder) await rm(folder, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
}

/** Pull requests (GitHub, via gh) and merge requests (GitLab, via glab) per project repository. Only runs when the screen asks; never stores credentials. */
export class PullRequestService {
  private viewers = new Map<Provider, string | null>()
  constructor(private readonly database: AppDatabase, private readonly cli: CliRunner = nativeCli, private readonly git: GitRunner = nativeGit, private readonly accounts?: GitAccounts) {}

  /** Runs through the API with the project/repository token, if any; without a token returns `used: false` and the caller falls back to gh/glab. */
  private async viaToken<T>(sourceId: string, run: (api: HostApi, remote: RemoteRef, login: string) => Promise<T>): Promise<{ used: true; value: T } | { used: false }> {
    const found = await this.accounts?.lookup(sourceId)
    if (!found || found.status === 'none') return { used: false }
    if (found.status === 'invalid') throw new Error(tm().gitAccounts.invalidToken(found.remote.host))
    try { return { used: true, value: await run(new HostApi(found.access), found.remote, found.login) } } catch (error) {
      if (error instanceof HostAuthError) { await this.accounts!.markInvalid(found.key); throw new Error(tm().gitAccounts.invalidToken(found.remote.host)) }
      throw error
    }
  }

  /** The merge method the project chose beforehand (its Git settings); `merge` when none. */
  private mergeDefault(sourceId: string): PrMergeMethod {
    try {
      const raw = this.database.db.prepare('SELECT p.git_policy FROM project_sources s JOIN projects p ON p.id = s.project_id WHERE s.id = ?').pluck().get(sourceId) as string | null | undefined
      return prMergeMethodSchema.safeParse(raw ? (JSON.parse(raw) as { mergeMethod?: unknown }).mergeMethod : undefined).data ?? 'merge'
    } catch { return 'merge' }
  }

  private path(sourceId: string): string {
    const row = this.database.db.prepare('SELECT local_path FROM project_sources WHERE id = ?').pluck().get(sourceId) as string | undefined
    if (!row) throw new Error(tm().common.repoNotFoundInProject)
    return row
  }
  private async provider(dir: string): Promise<Provider | null> {
    try {
      const remote = (await this.git.run(['-C', dir, 'remote', 'get-url', 'origin'])).stdout
      return /github\.com/i.test(remote) ? 'github' : /gitlab/i.test(remote) ? 'gitlab' : null
    } catch { return null }
  }
  private async need(dir: string): Promise<Provider> {
    const provider = await this.provider(dir)
    if (!provider) throw new Error(tm().pullRequests.notGithubNorGitlab)
    return provider
  }
  private async exec(provider: Provider, dir: string, args: string[]): Promise<string> {
    try { return await this.cli.run(cliOf(provider), args, dir) } catch (error) { throw new Error(cliError(provider, error)) }
  }
  private async viewer(provider: Provider, dir: string): Promise<string | null> {
    if (this.viewers.get(provider)) return this.viewers.get(provider)!
    let login: string | null = null
    try {
      login = provider === 'github' ? (await this.exec(provider, dir, ['api', 'user', '--jq', '.login'])).trim() || null
        : (JSON.parse(await this.exec(provider, dir, ['api', 'user'])) as { username?: string }).username ?? null
    } catch { /* no login: nothing is "mine" */ }
    if (login) this.viewers.set(provider, login)
    return login
  }

  /** A page (from 1) of the PRs/MRs of a state; `more` says whether a next page may exist (infinite scroll of the list). */
  async list(sourceId: string, state: PrState = 'open', page = 1): Promise<PullRequestList> {
    const dir = this.path(sourceId), found = await this.accounts?.lookup(sourceId)
    if (found?.status === 'invalid') return { supported: true, provider: guessProvider(found.remote.host), error: tm().gitAccounts.invalidToken(found.remote.host), viewer: null, prs: [], via: 'token', problem: 'invalid-token', host: found.remote.host }
    if (found?.status === 'ok') {
      try { const { prs, more } = await new HostApi(found.access).listPage(found.remote, found.login, state, page); return { supported: true, provider: found.access.provider, error: null, viewer: found.login, prs, more, via: 'token', problem: null, host: found.remote.host } } catch (error) {
        if (error instanceof HostAuthError) { await this.accounts!.markInvalid(found.key); return { supported: true, provider: found.access.provider, error: tm().gitAccounts.invalidToken(found.remote.host), viewer: null, prs: [], via: 'token', problem: 'invalid-token', host: found.remote.host } }
        return { supported: true, provider: found.access.provider, error: (error as Error).message, viewer: null, prs: [], via: 'token', problem: null, host: found.remote.host }
      }
    }
    const provider = await this.provider(dir)
    if (!provider) return { supported: false, provider: null, error: tm().pullRequests.unsupportedRepo, viewer: null, prs: [] }
    try {
      const viewer = await this.viewer(provider, dir)
      let prs: PullRequestSummary[], more: boolean
      // Other states and further pages go through the REST door of gh/glab (the list commands do not page).
      if (state !== 'open' || page > 1) ({ prs, more } = await actions.listPage(cliRepoCall(this.cli, provider, dir, viewer), state, page))
      else if (provider === 'github') {
        const raw = JSON.parse(await this.exec(provider, dir, ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,url,isDraft,headRefName,baseRefName,updatedAt,createdAt,reviewDecision,author,assignees,reviewRequests,comments,labels'])) as RawPr[]
        more = raw.length >= actions.PR_PAGE
        const labels = await actions.colorLabels(cliRepoCall(this.cli, provider, dir, viewer), raw.map((pr) => pr.labels))
        prs = raw.map((pr, index) => ({
          number: pr.number, title: pr.title, url: pr.url, draft: Boolean(pr.isDraft), head: pr.headRefName, base: pr.baseRefName, updatedAt: pr.updatedAt, createdAt: pr.createdAt ?? pr.updatedAt, state: 'OPEN' as const,
          reviewDecision: pr.reviewDecision || null, author: pr.author?.login ?? '', comments: pr.comments?.length ?? 0,
          reviewRequested: Boolean(viewer && pr.reviewRequests?.some((item) => item.login === viewer)), labels: labels[index] ?? [], assignees: actions.listAssignees((pr.assignees ?? []).map((item) => ({ login: item.login })))
        }))
      } else {
        const raw = JSON.parse(await this.exec(provider, dir, ['mr', 'list', '-F', 'json', '--per-page', '50'])) as RawMr[]
        more = raw.length >= actions.PR_PAGE
        // glab gives only label names: they are colored from the project's labels (one extra call, only when some MR has labels).
        const labels = await actions.colorLabels(cliRepoCall(this.cli, provider, dir, viewer), raw.map((mr) => mr.labels))
        prs = raw.map((mr, index) => ({
          number: mr.iid, title: mr.title, url: mr.web_url, draft: Boolean(mr.draft ?? mr.work_in_progress), head: mr.source_branch, base: mr.target_branch, updatedAt: mr.updated_at, createdAt: mr.created_at ?? mr.updated_at, state: 'OPEN' as const,
          reviewDecision: null, author: mr.author?.username ?? '', comments: mr.user_notes_count ?? 0,
          reviewRequested: Boolean(viewer && mr.reviewers?.some((item) => item.username === viewer)), labels: labels[index] ?? [], assignees: actions.listAssignees((mr.assignees ?? []).map((item) => ({ login: item.username, avatar: item.avatar_url, email: actions.personEmail(item) })))
        }))
      }
      return { supported: true, provider, error: null, viewer, prs, more, via: 'cli', problem: null, host: found?.remote?.host ?? null }
    } catch (error) { return { supported: true, provider, error: error instanceof SyntaxError ? `Resposta inesperada do ${cliOf(provider)}.` : (error as Error).message, viewer: null, prs: [], via: 'cli', problem: problemOf(error), host: found?.remote?.host ?? null } }
  }

  /** Runs one PR action through the REST door: the token when there is one, otherwise gh/glab. */
  private async act<T>(sourceId: string, run: (rc: RepoCall) => Promise<T>): Promise<T> {
    const viaApi = await this.viaToken(sourceId, (api, remote, login) => run(api.repo(remote, login)))
    if (viaApi.used) return viaApi.value
    const dir = this.path(sourceId), provider = await this.need(dir)
    return run(cliRepoCall(this.cli, provider, dir, await this.viewer(provider, dir)))
  }

  /** The PR/MR; the viewer's own photo comes from the repository's git e-mail when the host doesn't show it. */
  async view(sourceId: string, number: number): Promise<PullRequestDetail> {
    const detail = { ...await this.act(sourceId, (rc) => actions.view(rc, number)), mergeDefault: this.mergeDefault(sourceId) }
    if (!detail.viewer || detail.emails[detail.viewer]) return detail
    let email = ''
    try { email = (await this.git.run(['-C', this.path(sourceId), 'config', 'user.email'])).stdout.trim().toLowerCase() } catch { /* no e-mail set */ }
    return email ? { ...detail, emails: { ...detail.emails, [detail.viewer]: email } } : detail
  }
  checks(sourceId: string, numbers: number[]): Promise<{ checks: Array<{ number: number; status: PullRequestDetail['pipeline']; approvals: number | null }> }> { return this.act(sourceId, async (rc) => ({ checks: await actions.checks(rc, numbers) })) }
  async commits(sourceId: string, number: number): Promise<{ commits: PrCommit[] }> { return { commits: await this.act(sourceId, (rc) => actions.commits(rc, number)) } }
  pipelines(sourceId: string, number: number): Promise<{ pipelines: PrPipeline[]; canAct: boolean }> { return this.act(sourceId, (rc) => actions.pipelines(rc, number)) }
  jobLog(sourceId: string, jobId: string): Promise<{ text: string; truncated: boolean }> { return this.act(sourceId, (rc) => actions.jobLog(rc, jobId)) }
  async pipelineAction(sourceId: string, pipelineId: string, action: 'cancel' | 'retry'): Promise<Record<string, never>> { await this.act(sourceId, (rc) => actions.pipelineAction(rc, pipelineId, action)); return {} }
  async jobAction(sourceId: string, jobId: string, action: 'cancel' | 'retry'): Promise<Record<string, never>> { await this.act(sourceId, (rc) => actions.jobAction(rc, jobId, action)); return {} }
  async versions(sourceId: string, number: number): Promise<{ versions: PrVersion[] }> { return { versions: await this.act(sourceId, (rc) => actions.versions(rc, number)) } }
  versionDiff(sourceId: string, number: number, versionId: string): Promise<{ diff: string; files: PrFile[]; headSha: string | null; baseSha: string | null; startSha: string | null }> { return this.act(sourceId, (rc) => actions.versionDiff(rc, number, versionId)) }
  /** Edits, marks/unmarks draft, closes or reopens the PR/MR. */
  update(sourceId: string, number: number, input: actions.UpdateInput): Promise<{ warning: string | null }> { return this.act(sourceId, (rc) => actions.update(rc, number, input)) }
  async unapprove(sourceId: string, number: number): Promise<Record<string, never>> { await this.act(sourceId, (rc) => actions.unapprove(rc, number)); return {} }
  async resolve(sourceId: string, number: number, threadId: string, resolved: boolean): Promise<Record<string, never>> { await this.act(sourceId, (rc) => actions.resolve(rc, number, threadId, resolved)); return {} }
  createOptions(sourceId: string): Promise<PrCreateOptions> { return this.act(sourceId, (rc) => actions.createOptions(rc)) }
  /** Uploads go only through the token (the CLI door has no multipart); without a token `actions.upload` explains it. */
  upload(sourceId: string, name: string, dataBase64: string): Promise<{ markdown: string }> { return this.act(sourceId, (rc) => actions.upload(rc, name, dataBase64)) }
  lineComment(sourceId: string, number: number, input: LineCommentInput): Promise<PullRequestDetail['threads'][number]> { return this.act(sourceId, (rc) => actions.lineComment(rc, number, input)) }
  reply(sourceId: string, number: number, threadId: string, body: string, resolve = false): Promise<PullRequestDetail['threads'][number]['comments'][number]> { return this.act(sourceId, (rc) => actions.reply(rc, number, threadId, body, resolve)) }
  /** Edits, deletes or reacts to one comment. */
  note(sourceId: string, number: number, input: Parameters<typeof actions.noteAction>[2]): ReturnType<typeof actions.noteAction> { return this.act(sourceId, (rc) => actions.noteAction(rc, number, input)) }
  react(sourceId: string, number: number, kind: 'up' | 'down'): Promise<PullRequestDetail['reactions']> { return this.act(sourceId, (rc) => actions.react(rc, number, kind)) }
  merge(sourceId: string, number: number, options: { method: PrMergeMethod; deleteSourceBranch: boolean; message: string | null }): Promise<{ merged: true; branchDeleted: boolean; warning: string | null }> { return this.act(sourceId, (rc) => actions.merge(rc, number, options)) }

  async comment(sourceId: string, number: number, body: string): Promise<void> {
    if ((await this.viaToken(sourceId, (api, remote) => api.comment(remote, number, body))).used) return
    const dir = this.path(sourceId), provider = await this.need(dir)
    await this.exec(provider, dir, provider === 'gitlab' ? ['mr', 'note', String(number), '-m', body] : ['pr', 'comment', String(number), '--body', body])
  }

  async review(sourceId: string, number: number, action: 'approve' | 'request-changes' | 'comment', body: string): Promise<void> {
    if (await this.accounts?.lookup(sourceId).then((found) => found.status !== 'none')) {
      const found = await this.accounts!.lookup(sourceId)
      if (found.status === 'ok' && found.access.provider === 'gitlab' && action === 'request-changes') throw new Error(tm().pullRequests.gitlabNoRequestChanges)
      if (action !== 'approve' && !body.trim()) throw new Error(tm().pullRequests.writeReviewComment)
      if ((await this.viaToken(sourceId, (api, remote) => api.review(remote, number, action, body))).used) return
    }
    const dir = this.path(sourceId), provider = await this.need(dir)
    if (provider === 'gitlab') {
      if (action === 'request-changes') throw new Error(tm().pullRequests.gitlabNoRequestChanges)
      if (action === 'comment') { await this.comment(sourceId, number, body); return }
      if (body.trim()) await this.exec(provider, dir, ['mr', 'note', String(number), '-m', body])
      await this.exec(provider, dir, ['mr', 'approve', String(number)])
      return
    }
    if (action !== 'approve' && !body.trim()) throw new Error(tm().pullRequests.writeReviewComment)
    await this.exec(provider, dir, ['pr', 'review', String(number), `--${action}`, ...(body.trim() ? ['--body', body] : [])])
  }

  /** The remote's default branch (origin/HEAD, as GitHub/GitLab set it), or null when the repository does not know it. */
  async defaultBase(sourceId: string): Promise<{ branch: string | null }> {
    try { const { stdout } = await this.git.run(['-C', this.path(sourceId), 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']); return { branch: stdout.trim().replace(/^origin\//, '') || null } } catch { return { branch: null } }
  }

  /** Publishes the branch and opens the PR/MR. The title and body come from the screen; nothing is sent unless the user asks. */
  /**
   * Publishes the branch and opens the PR/MR with its metadata, through the REST door (token or `gh api`/`glab api`), so everything goes
   * in one go. The title and body come from the screen; nothing is sent unless the user asks.
   */
  async create(sourceId: string, input: CreateInput): Promise<{ url: string; number: number | null; warning: string | null }> {
    const dir = this.path(sourceId), provider = await this.provider(dir) ?? 'gitlab'
    try { await this.git.run(['-C', dir, 'push', '-u', 'origin', input.head]) } catch (error) { throw new Error(tm().pullRequests.couldNotPublishBranch(cliError(provider, error))) }
    return this.act(sourceId, (rc) => actions.create(rc, input))
  }

  /** What a new PR would carry, from the local repository only: head's commits that base lacks and the changed files. `base` prefers `origin/<base>`. */
  async compare(sourceId: string, head: string, base: string): Promise<PrCompare> {
    if (head.startsWith('-') || base.startsWith('-')) throw new Error(tm().pullRequests.invalidId)
    const dir = this.path(sourceId)
    const git = async (args: string[]): Promise<string> => (await this.git.run(['-C', dir, ...args])).stdout
    let from = base
    try { await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}^{commit}`]); from = `origin/${base}` } catch { /* no remote copy: use the local branch */ }
    try {
      const [count, log, numstat, nameStatus] = await Promise.all([
        git(['rev-list', '--count', `${from}..${head}`, '--']),
        git(['log', '--max-count=200', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%ae', `${from}..${head}`, '--']),
        git(['diff', '--numstat', '-z', '-M', `${from}...${head}`, '--']),
        git(['diff', '--name-status', '-z', '-M', `${from}...${head}`, '--'])
      ])
      const files = actions.parseDiffFiles(numstat, nameStatus), ahead = Number.parseInt(count.trim(), 10) || 0
      let message = ''
      if (ahead > 0) try { message = (await git(['log', '-1', '--format=%b', head, '--'])).trim() } catch { /* the title alone */ }
      return {
        ahead, message,
        additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        commits: actions.parseLog(log).slice(0, 200), files: files.slice(0, 1000)
      }
    } catch (error) {
      const detail = [(error as { stderr?: string })?.stderr, error instanceof Error ? error.message : String(error)].filter(Boolean).join('\n')
      throw new Error(tm().pullRequests.compareFailed(detail.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !/^Command failed/i.test(line))?.slice(0, 300) ?? ''))
    }
  }

  /** Only opens in the browser a PR address listed for this repository, or a page of the same repository (pipelines, jobs, runs). */
  async assertUrl(sourceId: string, url: string): Promise<string> {
    const open = await this.list(sourceId)
    if (allowedOpenUrl(url, open.prs.map((pr) => pr.url))) return url
    // Without an open PR there is nothing to derive the repository address from: try the recent ones of any state.
    const all = await this.list(sourceId, 'all')
    if (allowedOpenUrl(url, all.prs.map((pr) => pr.url))) return url
    throw new Error(tm().pullRequests.unknownPrUrlRepo)
  }
}

/** The repository's web address from a PR/MR address: GitHub `https://host/owner/repo/`, GitLab `https://host/group/…/project/-/`. */
export function repoWebPrefix(prUrl: string): string | null {
  try {
    const u = new URL(prUrl)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    const gitlab = /^(\/.+?\/-\/)merge_requests\/\d+/.exec(u.pathname)
    if (gitlab) return `${u.origin}${gitlab[1]}`
    const github = /^(\/[^/]+\/[^/]+\/)pull\/\d+/.exec(u.pathname)
    return github ? `${u.origin}${github[1]}` : null
  } catch { return null }
}

/** A listed PR address, or an http(s) page under the same repository's web address on the same host. */
export function allowedOpenUrl(url: string, prUrls: string[]): boolean {
  if (prUrls.includes(url)) return true
  let u: URL
  try { u = new URL(url) } catch { return false }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return false
  const target = `${u.origin}${u.pathname}`
  return prUrls.some((prUrl) => { const prefix = repoWebPrefix(prUrl); return Boolean(prefix && target.startsWith(prefix) && target.length > prefix.length) })
}
