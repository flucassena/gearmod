import type { PullRequestDetail, PullRequestSummary } from '@gearmod/contracts'
import { tm } from './i18n'
import { create as createPr, listByState, listPage, view as viewPr, type CreateInput, type HttpMethod, type PrState, type RepoCall } from './pr-actions'

export type HostProvider = 'github' | 'gitlab'
export interface HostAccess { provider: HostProvider; host: string; token: string }
export interface HostUser { login: string; name: string; email: string | null }
/** `origin` remote already parsed: where it is from and what the project's path is on the provider. */
export interface RemoteRef { host: string; path: string }
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | FormData; signal?: AbortSignal; redirect?: 'follow' | 'manual' }) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; json(): Promise<unknown>; text(): Promise<string> }>

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

  /**
   * One API request. `text` returns the raw answer and follows redirects by hand (GitHub job logs redirect to a storage host):
   * the token only goes along while the address stays on the API's own origin.
   */
  private async call<T>(path: string, init: { method?: string; body?: unknown; text?: boolean; accept?: string; form?: FormData } = {}): Promise<T> {
    const headers: Record<string, string> = this.access.provider === 'github'
      ? { Authorization: `Bearer ${this.access.token}`, Accept: init.accept ?? 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'GearMod' }
      : { 'PRIVATE-TOKEN': this.access.token, Accept: 'application/json', 'User-Agent': 'GearMod' }
    if (init.body !== undefined && !init.form) headers['Content-Type'] = 'application/json'
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), init.text ? 120_000 : 30_000)
    const send = (url: string, options: Parameters<Fetch>[1]): ReturnType<Fetch> => this.fetcher(url, options).catch((error: unknown) => { throw new HostApiError(0, friendlyNetwork(this.access.host, error)) })
    try {
      const body = init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body))
      let url = `${this.base}${path}`
      let response = await send(url, { method: init.method ?? 'GET', headers, body, signal: controller.signal, ...(init.text ? { redirect: 'manual' as const } : {}) })
      const origin = new URL(this.base).origin
      for (let hop = 0; init.text && hop < 5 && [301, 302, 303, 307, 308].includes(response.status); hop++) {
        const location = response.headers?.get('location')
        if (!location) break
        url = new URL(location, url).href
        const sameOrigin = new URL(url).origin === origin
        response = await send(url, { method: 'GET', headers: sameOrigin ? headers : { 'User-Agent': 'GearMod' }, signal: controller.signal, redirect: 'manual' })
      }
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
      if (response.status === 204) return undefined as T
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

  /** The REST door of one repository (`subpath` relative to it), shared by every PR action. */
  repo(remote: RemoteRef, viewer: string | null): RepoCall {
    const root = this.access.provider === 'github' ? this.gh(remote) : this.gl(remote)
    const rc: RepoCall = { provider: this.access.provider, viewer, call: <T>(method: HttpMethod, subpath: string, body?: unknown, options?: { text?: boolean }) => this.call<T>(subpath ? `${root}/${subpath}` : root, { method, body, text: options?.text }) }
    if (this.access.provider === 'gitlab') {
      rc.upload = (subpath: string, name: string, data: Uint8Array) => {
        const form = new FormData()
        form.append('file', new Blob([new Uint8Array(data)]), name)
        return this.call(`${root}/${subpath}`, { method: 'POST', form })
      }
    }
    return rc
  }

  list(remote: RemoteRef, viewer: string | null, state: PrState = 'open'): Promise<PullRequestSummary[]> { return listByState(this.repo(remote, viewer), state) }
  /** One page of the list, and whether there may be more. */
  listPage(remote: RemoteRef, viewer: string | null, state: PrState, page: number): Promise<{ prs: PullRequestSummary[]; more: boolean }> { return listPage(this.repo(remote, viewer), state, page) }

  view(remote: RemoteRef, number: number, viewer: string | null = null): Promise<PullRequestDetail> { return viewPr(this.repo(remote, viewer), number) }

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

  create(remote: RemoteRef, input: CreateInput, viewer: string | null = null): Promise<{ url: string; number: number | null; warning: string | null }> { return createPr(this.repo(remote, viewer), input) }
}
