import type { PullRequestDetail, PullRequestList, PullRequestSummary } from '@gearmod/contracts'
import type { AppDatabase } from './database'
import { nativeCli, type CliRunner } from './git-manager'
import { nativeGit, type GitRunner } from './worktrees'
import { tm } from './i18n'
import type { GitAccounts } from './git-accounts'
import { guessProvider, HostApi, HostAuthError, type RemoteRef } from './git-host-api'

type Provider = 'github' | 'gitlab'
const MAX_DIFF = 300_000
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
const countDiff = (diff: string): { additions: number; deletions: number } => {
  let additions = 0, deletions = 0
  for (const line of diff.split('\n')) { if (line.startsWith('+') && !line.startsWith('+++')) additions++; else if (line.startsWith('-') && !line.startsWith('---')) deletions++ }
  return { additions, deletions }
}
const cutDiff = (diff: string): string => diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… diff cortado (muito grande); abra o PR no navegador para ver tudo.` : diff

interface RawPr {
  number: number; title: string; url: string; isDraft?: boolean; headRefName: string; baseRefName: string; updatedAt: string; reviewDecision?: string | null
  author?: { login?: string } | null; reviewRequests?: Array<{ login?: string; slug?: string }>; comments?: unknown[]
}
interface RawMr {
  iid: number; title: string; web_url: string; draft?: boolean; work_in_progress?: boolean; source_branch: string; target_branch: string; updated_at: string
  author?: { username?: string } | null; reviewers?: Array<{ username?: string }>; user_notes_count?: number
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

  async list(sourceId: string): Promise<PullRequestList> {
    const dir = this.path(sourceId), found = await this.accounts?.lookup(sourceId)
    if (found?.status === 'invalid') return { supported: true, provider: guessProvider(found.remote.host), error: tm().gitAccounts.invalidToken(found.remote.host), viewer: null, prs: [], via: 'token', problem: 'invalid-token', host: found.remote.host }
    if (found?.status === 'ok') {
      try { const prs = await new HostApi(found.access).list(found.remote, found.login); return { supported: true, provider: found.access.provider, error: null, viewer: found.login, prs, via: 'token', problem: null, host: found.remote.host } } catch (error) {
        if (error instanceof HostAuthError) { await this.accounts!.markInvalid(found.key); return { supported: true, provider: found.access.provider, error: tm().gitAccounts.invalidToken(found.remote.host), viewer: null, prs: [], via: 'token', problem: 'invalid-token', host: found.remote.host } }
        return { supported: true, provider: found.access.provider, error: (error as Error).message, viewer: null, prs: [], via: 'token', problem: null, host: found.remote.host }
      }
    }
    const provider = await this.provider(dir)
    if (!provider) return { supported: false, provider: null, error: tm().pullRequests.unsupportedRepo, viewer: null, prs: [] }
    try {
      const viewer = await this.viewer(provider, dir)
      let prs: PullRequestSummary[]
      if (provider === 'github') {
        const raw = JSON.parse(await this.exec(provider, dir, ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,url,isDraft,headRefName,baseRefName,updatedAt,reviewDecision,author,reviewRequests,comments'])) as RawPr[]
        prs = raw.map((pr) => ({
          number: pr.number, title: pr.title, url: pr.url, draft: Boolean(pr.isDraft), head: pr.headRefName, base: pr.baseRefName, updatedAt: pr.updatedAt,
          reviewDecision: pr.reviewDecision || null, author: pr.author?.login ?? '', comments: pr.comments?.length ?? 0,
          reviewRequested: Boolean(viewer && pr.reviewRequests?.some((item) => item.login === viewer))
        }))
      } else {
        const raw = JSON.parse(await this.exec(provider, dir, ['mr', 'list', '-F', 'json', '--per-page', '50'])) as RawMr[]
        prs = raw.map((mr) => ({
          number: mr.iid, title: mr.title, url: mr.web_url, draft: Boolean(mr.draft ?? mr.work_in_progress), head: mr.source_branch, base: mr.target_branch, updatedAt: mr.updated_at,
          reviewDecision: null, author: mr.author?.username ?? '', comments: mr.user_notes_count ?? 0,
          reviewRequested: Boolean(viewer && mr.reviewers?.some((item) => item.username === viewer))
        }))
      }
      return { supported: true, provider, error: null, viewer, prs, via: 'cli', problem: null, host: found?.remote?.host ?? null }
    } catch (error) { return { supported: true, provider, error: error instanceof SyntaxError ? `Resposta inesperada do ${cliOf(provider)}.` : (error as Error).message, viewer: null, prs: [], via: 'cli', problem: problemOf(error), host: found?.remote?.host ?? null } }
  }

  async view(sourceId: string, number: number): Promise<PullRequestDetail> {
    const viaApi = await this.viaToken(sourceId, (api, remote) => api.view(remote, number))
    if (viaApi.used) return viaApi.value
    const dir = this.path(sourceId), provider = await this.need(dir)
    if (provider === 'gitlab') return this.viewMr(dir, number)
    const raw = JSON.parse(await this.exec(provider, dir, ['pr', 'view', String(number), '--json', 'number,title,body,url,state,isDraft,headRefName,baseRefName,reviewDecision,author,comments,reviews,files,additions,deletions,mergeable'])) as {
      number: number; title: string; body: string; url: string; state: string; isDraft: boolean; headRefName: string; baseRefName: string; reviewDecision?: string | null; mergeable?: string
      author?: { login?: string }; additions: number; deletions: number; files?: Array<{ path: string; additions: number; deletions: number }>
      comments?: Array<{ author?: { login?: string }; body: string; createdAt: string }>; reviews?: Array<{ author?: { login?: string }; body: string; state: string; submittedAt?: string }>
    }
    let diff = ''
    try { diff = await this.exec(provider, dir, ['pr', 'diff', String(number)]) } catch { /* the rest still opens */ }
    return {
      number: raw.number, title: raw.title, body: raw.body ?? '', url: raw.url, state: raw.state, draft: raw.isDraft, head: raw.headRefName, base: raw.baseRefName,
      reviewDecision: raw.reviewDecision || null, author: raw.author?.login ?? '', additions: raw.additions, deletions: raw.deletions, mergeable: raw.mergeable ?? null,
      files: (raw.files ?? []).map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
      comments: (raw.comments ?? []).map((item) => ({ author: item.author?.login ?? '', body: item.body, at: item.createdAt })),
      reviews: (raw.reviews ?? []).filter((item) => item.state !== 'PENDING').map((item) => ({ author: item.author?.login ?? '', body: item.body, state: item.state, at: item.submittedAt ?? '' })),
      diff: cutDiff(diff)
    }
  }

  /** GitLab merge request through glab's API (`:id` is the folder's project). */
  private async viewMr(dir: string, number: number): Promise<PullRequestDetail> {
    const api = async <T>(path: string): Promise<T> => JSON.parse(await this.exec('gitlab', dir, ['api', path])) as T
    const base = `projects/:id/merge_requests/${number}`
    const mr = await api<{ iid: number; title: string; description?: string; web_url: string; state: string; draft?: boolean; source_branch: string; target_branch: string; has_conflicts?: boolean; author?: { username?: string } }>(base)
    const [notes, changes, approvals] = await Promise.all([
      api<Array<{ author?: { username?: string }; body: string; created_at: string; system?: boolean }>>(`${base}/notes?per_page=100&sort=asc`).catch(() => []),
      api<{ changes?: Array<{ new_path: string; diff: string }> }>(`${base}/changes`).catch(() => ({ changes: [] })),
      api<{ approved_by?: Array<{ user?: { username?: string } }> }>(`${base}/approvals`).catch(() => ({ approved_by: [] }))
    ])
    const files = (changes.changes ?? []).map((item) => ({ path: item.new_path, ...countDiff(item.diff) }))
    const diff = (changes.changes ?? []).map((item) => `diff --git a/${item.new_path} b/${item.new_path}\n${item.diff}`).join('\n')
    const approved = approvals.approved_by ?? []
    return {
      number: mr.iid, title: mr.title, body: mr.description ?? '', url: mr.web_url, state: mr.state.toUpperCase(), draft: Boolean(mr.draft), head: mr.source_branch, base: mr.target_branch,
      reviewDecision: approved.length ? 'APPROVED' : null, author: mr.author?.username ?? '', additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      mergeable: mr.has_conflicts ? 'CONFLICTING' : null, files,
      comments: notes.filter((note) => !note.system).map((note) => ({ author: note.author?.username ?? '', body: note.body, at: note.created_at })),
      reviews: approved.map((item) => ({ author: item.user?.username ?? '', body: '', state: 'APPROVED', at: '' })),
      diff: cutDiff(diff)
    }
  }

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
  async create(sourceId: string, input: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ url: string }> {
    const dir = this.path(sourceId), provider = await this.provider(dir) ?? 'gitlab'
    try { await this.git.run(['-C', dir, 'push', '-u', 'origin', input.head]) } catch (error) { throw new Error(tm().pullRequests.couldNotPublishBranch(cliError(provider, error))) }
    const viaApi = await this.viaToken(sourceId, (api, remote) => api.create(remote, input))
    if (viaApi.used) return viaApi.value
    await this.need(dir)
    const output = await this.exec(provider, dir, provider === 'gitlab'
      ? ['mr', 'create', '--source-branch', input.head, '--target-branch', input.base, '--title', input.title, '--description', input.body, '--yes', ...(input.draft ? ['--draft'] : [])]
      : ['pr', 'create', '--head', input.head, '--base', input.base, '--title', input.title, '--body', input.body, ...(input.draft ? ['--draft'] : [])])
    const url = output.match(/https?:\/\/\S+/g)?.at(-1)
    if (!url) throw new Error(tm().pullRequests.cliNoPrUrl(cliOf(provider)))
    return { url }
  }

  /** Only opens in the browser a PR address that the CLI listed for this repository. */
  async assertUrl(sourceId: string, url: string): Promise<string> {
    const list = await this.list(sourceId)
    if (!list.prs.some((pr) => pr.url === url)) throw new Error(tm().pullRequests.unknownPrUrlRepo)
    return url
  }
}
