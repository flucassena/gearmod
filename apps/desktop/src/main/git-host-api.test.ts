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
    const api = new HostApi({ provider: 'github', host: 'github.com', token: 't' }, (_url, init) => { body = JSON.parse(init!.body!); return reply(201, { html_url: 'https://github.com/o/r/pull/3' }) })
    expect(await api.create({ host: 'github.com', path: 'o/r' }, { head: 'f', base: 'main', title: 'T', body: 'B', draft: true })).toEqual({ url: 'https://github.com/o/r/pull/3' })
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
