import type { PullRequestDetail, PullRequestSummary } from '@gearmod/contracts'
import { tm } from './i18n'

export type HostProvider = 'github' | 'gitlab'
export interface HostAccess { provider: HostProvider; host: string; token: string }
export interface HostUser { login: string; name: string; email: string | null }
/** `origin` remote already parsed: where it is from and what the project's path is on the provider. */
export interface RemoteRef { host: string; path: string }
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

export class HostAuthError extends Error { constructor(readonly status: number) { super(`HTTP ${status}`) } }
export class HostApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }

/** A short sentence for an HTTP error answer: proxies and firewalls reply with web pages, so the body is never shown as it came. */
function friendlyStatus(host: string, status: number, detail: string, html: boolean): string {
  const p = tm().pullRequests
  if (status === 407) return p.hostProxyAuth(host)
  if (status === 429) return p.hostRateLimit(host)
  if (status === 404) return html ? p.hostNotApi(host, status) : p.hostNotFound(host)
  if (status >= 500) return p.hostDown(host, status)
  if (html) return status === 403 ? p.hostBlocked(host) : p.hostNotApi(host, status)
  if (status === 403) return p.hostForbidden(host, detail)
  return `${status}${detail ? ` · ${detail}` : ''}`
}

/** The reason a request never got an answer (timeout, DNS, refused, certificate…), in words. */
function friendlyNetwork(host: string, error: unknown): string {
  const p = tm().pullRequests, e = error as { name?: string; code?: string; cause?: { code?: string } }
  const code = e.code ?? e.cause?.code ?? ''
  if (e.name === 'AbortError') return p.hostTimeout(host)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return p.hostDns(host)
  if (code === 'ECONNREFUSED') return p.hostRefused(host)
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return p.hostTimeout(host)
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) return p.hostCertificate(host)
  return p.hostNetwork(host)
}

const MAX_DIFF = 300_000
const cutDiff = (diff: string): string => diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… diff cortado (muito grande); abra o PR no navegador para ver tudo.` : diff
const countDiff = (diff: string): { additions: number; deletions: number } => {
  let additions = 0, deletions = 0
  for (const line of diff.split('\n')) { if (line.startsWith('+') && !line.startsWith('+++')) additions++; else if (line.startsWith('-') && !line.startsWith('---')) deletions++ }
  return { additions, deletions }
}

/** Understands `https://host/owner/repo.git`, `git@host:owner/repo.git` and `ssh://git@host:port/owner/repo`. */
export function parseRemote(url: string): RemoteRef | null {
  const text = url.trim()
  const scp = /^[\w.-]+@([^:/\s]+):(?!\d+\/)(.+)$/.exec(text)
  let host: string | undefined, path: string | undefined
  if (scp) { host = scp[1]; path = scp[2] } else {
    try { const parsed = new URL(text); host = parsed.hostname; path = parsed.pathname } catch { return null }
  }
  if (!host || !path) return null
  path = path.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  return path.includes('/') ? { host: host.toLowerCase(), path } : null
}

export const guessProvider = (host: string): HostProvider | null => host === 'github.com' || /(^|\.)github\./i.test(host) ? 'github' : /gitlab/i.test(host) ? 'gitlab' : null

export class HostApi {
  constructor(private readonly access: HostAccess, private readonly fetcher: Fetch = (url, init) => fetch(url, init) as ReturnType<Fetch>) {}

  private get base(): string {
    const { provider, host } = this.access
    if (provider === 'github') return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
    return `https://${host}/api/v4`
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown; text?: boolean; accept?: string } = {}): Promise<T> {
    const headers: Record<string, string> = this.access.provider === 'github'
      ? { Authorization: `Bearer ${this.access.token}`, Accept: init.accept ?? 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'GearMod' }
      : { 'PRIVATE-TOKEN': this.access.token, Accept: 'application/json', 'User-Agent': 'GearMod' }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await this.fetcher(`${this.base}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: controller.signal }).catch((error: unknown) => { throw new HostApiError(0, friendlyNetwork(this.access.host, error)) })
      if (response.status === 401) throw new HostAuthError(401)
      if (!response.ok) {
        const raw = await response.text().catch(() => '')
        let detail = raw.slice(0, 300)
        try { const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown }; detail = String(typeof parsed.message === 'string' ? parsed.message : parsed.error ?? detail).slice(0, 300) } catch { /* plain text */ }
        // 403 for a missing scope also needs a new token; 403 for a rate limit does not.
        if (response.status === 403 && /bad credentials|insufficient|token/i.test(detail)) throw new HostAuthError(403)
        const html = /^\s*<(?:!doctype|html|head|body)/i.test(raw)
        throw new HostApiError(response.status, friendlyStatus(this.access.host, response.status, detail, html))
      }
      return (init.text ? await response.text() : await response.json()) as T
    } finally { clearTimeout(timer) }
  }

  /** Who owns the token; it is also the test that it is valid. */
  async user(): Promise<HostUser> {
    if (this.access.provider === 'github') {
      const me = await this.call<{ login: string; name?: string | null; email?: string | null }>('/user')
      let email = me.email ?? null
      if (!email) { try { const list = await this.call<Array<{ email: string; primary?: boolean; verified?: boolean }>>('/user/emails'); email = (list.find((item) => item.primary) ?? list[0])?.email ?? null } catch { /* no email scope */ } }
      return { login: me.login, name: me.name || me.login, email }
    }
    const me = await this.call<{ username: string; name?: string; email?: string; public_email?: string }>('/user')
    return { login: me.username, name: me.name || me.username, email: me.email || me.public_email || null }
  }

  private gh(remote: RemoteRef): string { return `/repos/${remote.path.split('/').map(encodeURIComponent).join('/')}` }
  private gl(remote: RemoteRef): string { return `/projects/${encodeURIComponent(remote.path)}` }

  async list(remote: RemoteRef, viewer: string | null): Promise<PullRequestSummary[]> {
    if (this.access.provider === 'github') {
      const raw = await this.call<Array<{ number: number; title: string; html_url: string; draft?: boolean; head: { ref: string }; base: { ref: string }; updated_at: string; user?: { login?: string } | null; requested_reviewers?: Array<{ login?: string }> }>>(`${this.gh(remote)}/pulls?state=open&per_page=50`)
      return raw.map((pr) => ({ number: pr.number, title: pr.title, url: pr.html_url, draft: Boolean(pr.draft), head: pr.head.ref, base: pr.base.ref, updatedAt: pr.updated_at, reviewDecision: null, author: pr.user?.login ?? '', comments: 0, reviewRequested: Boolean(viewer && pr.requested_reviewers?.some((item) => item.login === viewer)) }))
    }
    const raw = await this.call<Array<{ iid: number; title: string; web_url: string; draft?: boolean; work_in_progress?: boolean; source_branch: string; target_branch: string; updated_at: string; author?: { username?: string } | null; reviewers?: Array<{ username?: string }>; user_notes_count?: number }>>(`${this.gl(remote)}/merge_requests?state=opened&per_page=50&order_by=updated_at`)
    return raw.map((mr) => ({ number: mr.iid, title: mr.title, url: mr.web_url, draft: Boolean(mr.draft ?? mr.work_in_progress), head: mr.source_branch, base: mr.target_branch, updatedAt: mr.updated_at, reviewDecision: null, author: mr.author?.username ?? '', comments: mr.user_notes_count ?? 0, reviewRequested: Boolean(viewer && mr.reviewers?.some((item) => item.username === viewer)) }))
  }

  async view(remote: RemoteRef, number: number): Promise<PullRequestDetail> {
    if (this.access.provider === 'github') {
      const base = `${this.gh(remote)}/pulls/${number}`
      const pr = await this.call<{ number: number; title: string; body?: string | null; html_url: string; state: string; merged?: boolean; draft?: boolean; head: { ref: string }; base: { ref: string }; user?: { login?: string } | null; additions: number; deletions: number; mergeable_state?: string | null }>(base)
      const [files, comments, reviews] = await Promise.all([
        this.call<Array<{ filename: string; additions: number; deletions: number; patch?: string }>>(`${base}/files?per_page=100`).catch(() => []),
        this.call<Array<{ user?: { login?: string } | null; body: string; created_at: string }>>(`${this.gh(remote)}/issues/${number}/comments?per_page=100`).catch(() => []),
        this.call<Array<{ user?: { login?: string } | null; body?: string; state: string; submitted_at?: string }>>(`${base}/reviews?per_page=100`).catch(() => [])
      ])
      const decided = reviews.filter((item) => item.state === 'APPROVED' || item.state === 'CHANGES_REQUESTED').at(-1)
      const diff = files.map((file) => `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch ?? ''}`).join('\n')
      return {
        number: pr.number, title: pr.title, body: pr.body ?? '', url: pr.html_url, state: pr.merged ? 'MERGED' : pr.state.toUpperCase(), draft: Boolean(pr.draft), head: pr.head.ref, base: pr.base.ref,
        reviewDecision: decided ? (decided.state === 'APPROVED' ? 'APPROVED' : 'CHANGES_REQUESTED') : null, author: pr.user?.login ?? '', additions: pr.additions, deletions: pr.deletions,
        mergeable: pr.mergeable_state === 'dirty' ? 'CONFLICTING' : pr.mergeable_state && pr.mergeable_state !== 'unknown' ? 'MERGEABLE' : null,
        files: files.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions })),
        comments: comments.map((item) => ({ author: item.user?.login ?? '', body: item.body, at: item.created_at })),
        reviews: reviews.filter((item) => item.state !== 'PENDING').map((item) => ({ author: item.user?.login ?? '', body: item.body ?? '', state: item.state, at: item.submitted_at ?? '' })),
        diff: cutDiff(diff)
      }
    }
    const base = `${this.gl(remote)}/merge_requests/${number}`
    const mr = await this.call<{ iid: number; title: string; description?: string; web_url: string; state: string; draft?: boolean; source_branch: string; target_branch: string; has_conflicts?: boolean; author?: { username?: string } }>(base)
    const [notes, changes, approvals] = await Promise.all([
      this.call<Array<{ author?: { username?: string }; body: string; created_at: string; system?: boolean }>>(`${base}/notes?per_page=100&sort=asc`).catch(() => []),
      this.call<{ changes?: Array<{ new_path: string; diff: string }> }>(`${base}/changes`).catch(() => ({ changes: [] })),
      this.call<{ approved_by?: Array<{ user?: { username?: string } }> }>(`${base}/approvals`).catch(() => ({ approved_by: [] }))
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

  async comment(remote: RemoteRef, number: number, body: string): Promise<void> {
    if (this.access.provider === 'github') await this.call(`${this.gh(remote)}/issues/${number}/comments`, { method: 'POST', body: { body } })
    else await this.call(`${this.gl(remote)}/merge_requests/${number}/notes`, { method: 'POST', body: { body } })
  }

  /** `request-changes` only exists on GitHub; the caller already blocks it on GitLab. */
  async review(remote: RemoteRef, number: number, action: 'approve' | 'request-changes' | 'comment', body: string): Promise<void> {
    if (this.access.provider === 'github') {
      await this.call(`${this.gh(remote)}/pulls/${number}/reviews`, { method: 'POST', body: { event: action === 'approve' ? 'APPROVE' : action === 'request-changes' ? 'REQUEST_CHANGES' : 'COMMENT', ...(body.trim() ? { body } : {}) } })
      return
    }
    if (body.trim()) await this.comment(remote, number, body)
    if (action === 'approve') await this.call(`${this.gl(remote)}/merge_requests/${number}/approve`, { method: 'POST', body: {} })
  }

  async create(remote: RemoteRef, input: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ url: string }> {
    if (this.access.provider === 'github') {
      const pr = await this.call<{ html_url: string }>(`${this.gh(remote)}/pulls`, { method: 'POST', body: { title: input.title, head: input.head, base: input.base, body: input.body, draft: input.draft } })
      return { url: pr.html_url }
    }
    const mr = await this.call<{ web_url: string }>(`${this.gl(remote)}/merge_requests`, { method: 'POST', body: { source_branch: input.head, target_branch: input.base, title: input.draft && !/^draft:/i.test(input.title) ? `Draft: ${input.title}` : input.title, description: input.body } })
    return { url: mr.web_url }
  }
}
