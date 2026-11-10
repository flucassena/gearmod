import { describe, expect, it } from 'vitest'
import { guessProvider, HostApi, HostAuthError, parseRemote, type Fetch } from './git-host-api'

const reply = (status: number, body: unknown): ReturnType<Fetch> => Promise.resolve({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) })

describe('parseRemote', () => {
  it('understands https, scp and ssh', () => {
    expect(parseRemote('https://github.com/dono/repo.git')).toEqual({ host: 'github.com', path: 'dono/repo' })
    expect(parseRemote('git@gitlab.empresa.com:grupo/sub/repo.git')).toEqual({ host: 'gitlab.empresa.com', path: 'grupo/sub/repo' })
    expect(parseRemote('ssh://git@gitlab.empresa.com:2222/grupo/repo')).toEqual({ host: 'gitlab.empresa.com', path: 'grupo/repo' })
    expect(parseRemote('C:/pasta/local')).toBeNull()
  })
  it('guesses the provider from the host', () => {
    expect(guessProvider('github.com')).toBe('github')
    expect(guessProvider('gitlab.empresa.com')).toBe('gitlab')
    expect(guessProvider('git.empresa.com')).toBeNull()
  })
})

describe('HostApi', () => {
  it('reads the GitLab account and sends the token in the header', async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = []
    const api = new HostApi({ provider: 'gitlab', host: 'gitlab.empresa.com', token: 'glpat-x' }, (url, init) => { seen.push({ url, headers: init?.headers }); return reply(200, { username: 'chico', name: 'Francisco', email: 'c@e.com' }) })
    expect(await api.user()).toEqual({ login: 'chico', name: 'Francisco', email: 'c@e.com' })
    expect(seen[0]).toMatchObject({ url: 'https://gitlab.empresa.com/api/v4/user', headers: { 'PRIVATE-TOKEN': 'glpat-x' } })
  })
  it('a rejected token becomes HostAuthError', async () => {
    const api = new HostApi({ provider: 'github', host: 'github.com', token: 'ruim' }, () => reply(401, { message: 'Bad credentials' }))
    await expect(api.user()).rejects.toBeInstanceOf(HostAuthError)
  })
  it('lists the GitLab MRs by the encoded project path', async () => {
    const urls: string[] = []
    const api = new HostApi({ provider: 'gitlab', host: 'gitlab.empresa.com', token: 't' }, (url) => { urls.push(url); return reply(200, [{ iid: 7, title: 'Algo', web_url: 'https://x/7', source_branch: 'a', target_branch: 'develop', updated_at: '2026-01-01', author: { username: 'ana' }, reviewers: [{ username: 'chico' }], user_notes_count: 2 }]) })
    const prs = await api.list({ host: 'gitlab.empresa.com', path: 'grupo/sub/repo' }, 'chico')
    expect(urls[0]).toContain('/projects/grupo%2Fsub%2Frepo/merge_requests')
    expect(prs[0]).toMatchObject({ number: 7, head: 'a', base: 'develop', author: 'ana', reviewRequested: true, comments: 2 })
  })
  it('opens a PR on GitHub as a draft', async () => {
    let body: unknown
    const api = new HostApi({ provider: 'github', host: 'github.com', token: 't' }, (_url, init) => { body = JSON.parse(init!.body as string); return reply(201, { html_url: 'https://github.com/o/r/pull/3' }) })
    expect(await api.create({ host: 'github.com', path: 'o/r' }, { head: 'f', base: 'main', title: 'T', body: 'B', draft: true })).toMatchObject({ url: 'https://github.com/o/r/pull/3' })
    expect(body).toMatchObject({ head: 'f', base: 'main', draft: true })
  })
  it('turns proxy pages and network failures into plain sentences', async () => {
    const page = (status: number) => (() => Promise.resolve({ ok: false, status, text: () => Promise.resolve('<html><body><h1>403 Forbidden</h1></body></html>'), json: () => Promise.reject(new Error('x')) }))
    const user = (fetcher: unknown) => new HostApi({ provider: 'gitlab', host: 'git.empresa.com', token: 't' }, fetcher as never).user()
    await expect(user(page(403))).rejects.toThrow(/bloqueou|blocked/)
    await expect(user(page(502))).rejects.toThrow(/indispon|unavailable/)
    await expect(user(() => Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })))).rejects.toThrow(/git.empresa.com/)
    await expect(user(() => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })))).rejects.toThrow(/demorou|too long/)
  })
})

describe('HostApi.repo', () => {
  it('builds the GitHub repo URL and sends PUT/DELETE with JSON body', async () => {
    const seen: Array<{ url: string; method?: string; body?: string }> = []
    const api = new HostApi({ provider: 'github', host: 'github.com', token: 't' }, (url, init) => { seen.push({ url, method: init?.method, body: init?.body as string | undefined }); return Promise.resolve({ ok: true, status: init?.method === 'DELETE' ? 204 : 200, json: async () => ({ merged: true }), text: async () => '' }) })
    const rc = api.repo({ host: 'github.com', path: 'dono/repo' }, 'chico')
    await rc.call('PUT', 'pulls/3/merge', { merge_method: 'squash' })
    expect(await rc.call('DELETE', 'git/refs/heads/x')).toBeUndefined()
    expect(seen[0]).toEqual({ url: 'https://api.github.com/repos/dono/repo/pulls/3/merge', method: 'PUT', body: '{"merge_method":"squash"}' })
    expect(seen[1]).toMatchObject({ url: 'https://api.github.com/repos/dono/repo/git/refs/heads/x', method: 'DELETE' })
  })
  it('builds the GitLab project URL and paginates by page', async () => {
    const urls: string[] = []
    const api = new HostApi({ provider: 'gitlab', host: 'gitlab.empresa.com', token: 't' }, (url) => { urls.push(url); return reply(200, []) })
    const rc = api.repo({ host: 'gitlab.empresa.com', path: 'grupo/repo' }, null)
    await rc.call('GET', 'merge_requests/7/notes?per_page=100&page=2')
    expect(urls[0]).toBe('https://gitlab.empresa.com/api/v4/projects/grupo%2Frepo/merge_requests/7/notes?per_page=100&page=2')
  })
  it('GitHub job logs: follows the redirect by hand and never sends the token to another host', async () => {
    const seen: Array<{ url: string; headers?: Record<string, string>; redirect?: string }> = []
    const api = new HostApi({ provider: 'github', host: 'github.com', token: 'segredo' }, (url, init) => {
      seen.push({ url, headers: init?.headers, redirect: init?.redirect })
      if (url.includes('/actions/jobs/')) return Promise.resolve({ ok: false, status: 302, headers: { get: (n: string) => n === 'location' ? 'https://blob.storage.example/log?sig=1' : null }, json: async () => ({}), text: async () => '' })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => 'linha 1\nlinha 2' })
    })
    const text = await api.repo({ host: 'github.com', path: 'o/r' }, null).call<string>('GET', 'actions/jobs/9/logs', undefined, { text: true })
    expect(text).toBe('linha 1\nlinha 2')
    expect(seen[0]).toMatchObject({ url: 'https://api.github.com/repos/o/r/actions/jobs/9/logs', redirect: 'manual' })
    expect(seen[0]!.headers!.Authorization).toBe('Bearer segredo')
    expect(seen[1]!.url).toBe('https://blob.storage.example/log?sig=1')
    expect(JSON.stringify(seen[1]!.headers)).not.toContain('segredo')
  })
  it('GitLab trace comes back as text, keeping the token on the same host', async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = []
    const api = new HostApi({ provider: 'gitlab', host: 'gitlab.com', token: 'tk' }, (url, init) => { seen.push({ url, headers: init?.headers }); return Promise.resolve({ ok: true, status: 200, json: async () => { throw new Error('not json') }, text: async () => 'saida' }) })
    expect(await api.repo({ host: 'gitlab.com', path: 'g/r' }, null).call('GET', 'jobs/5/trace', undefined, { text: true })).toBe('saida')
    expect(seen[0]).toMatchObject({ url: 'https://gitlab.com/api/v4/projects/g%2Fr/jobs/5/trace', headers: { 'PRIVATE-TOKEN': 'tk' } })
  })
  it('sends PATCH and uploads multipart on GitLab only', async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown; headers?: Record<string, string> }> = []
    const api = new HostApi({ provider: 'gitlab', host: 'gitlab.com', token: 't' }, (url, init) => { seen.push({ url, method: init?.method, body: init?.body, headers: init?.headers }); return reply(201, { markdown: '![a](/uploads/x/a.png)' }) })
    const rc = api.repo({ host: 'gitlab.com', path: 'g/r' }, null)
    await rc.call('PATCH', 'issues/1', { milestone: 2 })
    expect(seen[0]).toMatchObject({ method: 'PATCH', body: '{"milestone":2}' })
    expect(await rc.upload!('uploads', 'a.png', new Uint8Array([1, 2, 3]))).toEqual({ markdown: '![a](/uploads/x/a.png)' })
    expect(seen[1]!.url).toBe('https://gitlab.com/api/v4/projects/g%2Fr/uploads')
    expect(seen[1]!.body).toBeInstanceOf(FormData)
    expect(((seen[1]!.body as FormData).get('file') as File).name).toBe('a.png')
    expect(seen[1]!.headers!['Content-Type']).toBeUndefined()
    expect(new HostApi({ provider: 'github', host: 'github.com', token: 't' }).repo({ host: 'github.com', path: 'o/r' }, null).upload).toBeUndefined()
  })
  it('sends squash when creating a GitLab MR', async () => {
    let body: Record<string, unknown> = {}
    const api = new HostApi({ provider: 'gitlab', host: 'gitlab.com', token: 't' }, (_u, init) => { body = JSON.parse(init!.body as string); return reply(201, { web_url: 'https://gitlab.com/g/r/-/merge_requests/1' }) })
    await api.create({ host: 'gitlab.com', path: 'g/r' }, { head: 'a', base: 'main', title: 't', body: '', draft: false, squash: true })
    expect(body.squash).toBe(true)
  })
})
