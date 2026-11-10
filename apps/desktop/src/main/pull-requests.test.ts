import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowedOpenUrl, cliRepoCall, PullRequestService, repoWebPrefix } from './pull-requests'
import type { AppDatabase } from './database'
import type { CliRunner } from './git-manager'

describe('cliRepoCall', () => {
  it('builds gh api with the repo placeholders and a body file that is removed afterwards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gm-test-'))
    let seen: { command: string; args: string[]; body: string } | null = null
    const cli: CliRunner = { run: async (command, args) => { seen = { command, args, body: await readFile(args[args.indexOf('--input') + 1]!, 'utf8') }; return '{"id":1}' } }
    const out = await cliRepoCall(cli, 'github', '/repo', 'chico', root).call<{ id: number }>('POST', 'pulls/3/comments', { body: 'oi' })
    expect(out).toEqual({ id: 1 })
    expect(seen!.command).toBe('gh')
    expect(seen!.args.slice(0, 4)).toEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/pulls/3/comments'])
    expect(JSON.parse(seen!.body)).toEqual({ body: 'oi' })
    expect(await readdir(root)).toEqual([])
    await rm(root, { recursive: true, force: true })
  })
  it('builds glab api with :id and sends no file for GET', async () => {
    let args: string[] = []
    const cli: CliRunner = { run: async (_c, a) => { args = a; return '[]' } }
    await cliRepoCall(cli, 'gitlab', '/repo', null).call('GET', 'merge_requests/7/notes')
    expect(args).toEqual(['api', '-X', 'GET', 'projects/:id/merge_requests/7/notes'])
  })
  it('removes the temp file even when the CLI fails, and returns undefined for an empty answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gm-test-'))
    let file = ''
    const failing: CliRunner = { run: async (_c, a) => { file = a[a.indexOf('--input') + 1]!; throw Object.assign(new Error('Command failed'), { stderr: 'gh: Validation Failed (HTTP 422)' }) } }
    await expect(cliRepoCall(failing, 'github', '/r', null, root).call('PUT', 'pulls/1/merge', { a: 1 })).rejects.toThrow('Validation Failed')
    expect(existsSync(file)).toBe(false)
    expect(await readdir(root)).toEqual([])
    const empty: CliRunner = { run: async () => '' }
    expect(await cliRepoCall(empty, 'github', '/r', null).call('DELETE', 'git/refs/heads/x')).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })
})

describe('PullRequestService.create through the CLI REST door', () => {
  const database = { db: { prepare: () => ({ pluck: () => ({ get: () => '/repo' }) }) } } as unknown as AppDatabase
  const make = (remote: string, seen: Array<{ args: string[]; body: unknown }>, gitSeen: string[][] = []): PullRequestService => {
    const git = { run: async (args: string[]) => { gitSeen.push(args); return { stdout: args.includes('get-url') ? remote : '', stderr: '' } } }
    const cli: CliRunner = {
      run: async (_c, args) => {
        const file = args.indexOf('--input')
        seen.push({ args, body: file >= 0 ? JSON.parse(await readFile(args[file + 1]!, 'utf8')) : undefined })
        if (args.includes('user')) return remote.includes('gitlab') ? '{"username":"chico"}' : 'chico'
        if (args.some((a) => a.endsWith('merge_requests'))) return '{"web_url":"https://gitlab.com/g/r/-/merge_requests/9","iid":9}'
        if (args.some((a) => a.endsWith('/pulls'))) return '{"html_url":"https://github.com/o/r/pull/4","number":4}'
        if (args.some((a) => a.includes('members/all'))) return '[{"id":11,"username":"ana"}]'
        return '{}'
      }
    }
    return new PullRequestService(database, cli, git)
  }
  it('GitLab: one POST merge_requests with squash and the metadata, after pushing the branch', async () => {
    const seen: Array<{ args: string[]; body: unknown }> = [], gitSeen: string[][] = []
    const out = await make('https://gitlab.com/g/r.git', seen, gitSeen).create('s', { head: 'a', base: 'main', title: 't', body: '', draft: true, squash: true, reviewers: ['ana'], labels: ['bug'], deleteSourceBranch: true })
    expect(gitSeen.some((a) => a.join(' ') === '-C /repo push -u origin a')).toBe(true)
    const post = seen.find((s) => s.args.includes('projects/:id/merge_requests'))!
    expect(post.args.slice(0, 3)).toEqual(['api', '-X', 'POST'])
    expect(post.body).toEqual({ source_branch: 'a', target_branch: 'main', title: 'Draft: t', description: '', squash: true, remove_source_branch: true, reviewer_ids: [11], labels: 'bug' })
    expect(out).toEqual({ url: 'https://gitlab.com/g/r/-/merge_requests/9', number: 9, warning: null })
  })
  it('GitHub: POST pulls without squash', async () => {
    const seen: Array<{ args: string[]; body: unknown }> = []
    const out = await make('https://github.com/o/r.git', seen).create('s', { head: 'a', base: 'main', title: 't', body: '', draft: false, squash: true })
    const post = seen.find((s) => s.args.includes('repos/{owner}/{repo}/pulls'))!
    expect(post.body).toEqual({ title: 't', head: 'a', base: 'main', body: '', draft: false })
    expect(out).toMatchObject({ number: 4, warning: null })
  })
})

describe('cliRepoCall text answers', () => {
  it('returns the raw output for text (job logs) and accepts PATCH', async () => {
    const seen: string[][] = []
    const cli: CliRunner = { run: async (_c, a) => { seen.push(a); return 'not json\n' } }
    expect(await cliRepoCall(cli, 'gitlab', '/r', null).call('GET', 'jobs/4/trace', undefined, { text: true })).toBe('not json\n')
    expect(seen[0]).toEqual(['api', '-X', 'GET', 'projects/:id/jobs/4/trace'])
    const ok: CliRunner = { run: async (_c, a) => { seen.push(a); return '{}' } }
    await cliRepoCall(ok, 'github', '/r', null).call('PATCH', 'issues/1', { milestone: 1 })
    expect(seen[1]!.slice(0, 4)).toEqual(['api', '-X', 'PATCH', 'repos/{owner}/{repo}/issues/1'])
    expect(cliRepoCall(ok, 'gitlab', '/r', null).upload).toBeUndefined()
  })
})

describe('PullRequestService.compare', () => {
  const database = { db: { prepare: () => ({ pluck: () => ({ get: () => '/repo' }) }) } } as unknown as AppDatabase
  const answers = (hasRemote: boolean) => async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    const cmd = args.slice(2).join(' ')
    if (cmd.startsWith('rev-parse')) { if (hasRemote) return { stdout: 'abc\n', stderr: '' }; throw new Error('no ref') }
    if (cmd.startsWith('rev-list')) return { stdout: '2\n', stderr: '' }
    if (cmd.startsWith('log')) return { stdout: 'h2\x1fh2s\x1fSegundo\x1fAna\x1f2026-01-02T00:00:00Z\nh1\x1fh1s\x1fPrimeiro\x1fBia\x1f2026-01-01T00:00:00Z\n', stderr: '' }
    if (cmd.includes('--numstat')) return { stdout: '3\t1\tsrc/a.ts\0-\t-\timg.png\0' + '2\t0\t\0old.ts\0new.ts\0' + '0\t5\tgone.ts\0', stderr: '' }
    if (cmd.includes('--name-status')) return { stdout: 'M\0src/a.ts\0A\0img.png\0R087\0old.ts\0new.ts\0D\0gone.ts\0', stderr: '' }
    return { stdout: '', stderr: '' }
  }
  it('uses origin/<base> when it exists and parses commits and files', async () => {
    const seen: string[][] = []
    const service = new PullRequestService(database, { run: async () => '' }, { run: (args) => { seen.push(args); return answers(true)(args) } })
    const out = await service.compare('s', 'feat/x', 'main')
    expect(seen.find((a) => a[2] === 'rev-list')).toEqual(['-C', '/repo', 'rev-list', '--count', 'origin/main..feat/x', '--'])
    expect(seen.find((a) => a.includes('--numstat'))).toEqual(['-C', '/repo', 'diff', '--numstat', '-z', '-M', 'origin/main...feat/x', '--'])
    expect(out.ahead).toBe(2)
    expect(out.commits).toEqual([{ sha: 'h2', shortSha: 'h2s', title: 'Segundo', author: 'Ana', at: '2026-01-02T00:00:00Z', email: '' }, { sha: 'h1', shortSha: 'h1s', title: 'Primeiro', author: 'Bia', at: '2026-01-01T00:00:00Z', email: '' }])
    expect(out.files).toEqual([
      { path: 'src/a.ts', oldPath: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
      { path: 'img.png', oldPath: 'img.png', status: 'added', additions: 0, deletions: 0 },
      { path: 'new.ts', oldPath: 'old.ts', status: 'renamed', additions: 2, deletions: 0 },
      { path: 'gone.ts', oldPath: 'gone.ts', status: 'removed', additions: 0, deletions: 5 }
    ])
    expect(out).toMatchObject({ additions: 5, deletions: 6 })
  })
  it('falls back to the local base and rejects refs that look like options', async () => {
    const seen: string[][] = []
    const service = new PullRequestService(database, { run: async () => '' }, { run: (args) => { seen.push(args); return answers(false)(args) } })
    await service.compare('s', 'feat/x', 'main')
    expect(seen.find((a) => a[2] === 'rev-list')?.[4]).toBe('main..feat/x')
    await expect(service.compare('s', '--output=x', 'main')).rejects.toThrow()
  })
})

describe('allowedOpenUrl', () => {
  const gh = ['https://github.com/o/r/pull/3'], gl = ['https://gitlab.empresa.com/g/sub/proj/-/merge_requests/7']
  it('accepts listed PRs and pages of the same repository', () => {
    expect(repoWebPrefix(gh[0]!)).toBe('https://github.com/o/r/')
    expect(repoWebPrefix(gl[0]!)).toBe('https://gitlab.empresa.com/g/sub/proj/-/')
    expect(allowedOpenUrl(gh[0]!, gh)).toBe(true)
    expect(allowedOpenUrl('https://github.com/o/r/actions/runs/1/job/2', gh)).toBe(true)
    expect(allowedOpenUrl('https://github.com/o/r/runs/55', gh)).toBe(true)
    expect(allowedOpenUrl('https://gitlab.empresa.com/g/sub/proj/-/pipelines/123', gl)).toBe(true)
    expect(allowedOpenUrl('https://gitlab.empresa.com/g/sub/proj/-/jobs/456', gl)).toBe(true)
  })
  it('rejects other hosts, other repositories, look-alikes and non-http', () => {
    expect(allowedOpenUrl('https://evil.com/o/r/actions/runs/1', gh)).toBe(false)
    expect(allowedOpenUrl('https://github.com/o/other/actions/runs/1', gh)).toBe(false)
    expect(allowedOpenUrl('https://github.com/o/r-evil/actions', gh)).toBe(false)
    expect(allowedOpenUrl('https://github.com/o/r/../x/actions', gh)).toBe(false)
    expect(allowedOpenUrl('https://user:pw@github.com/o/r/actions', gh)).toBe(false)
    expect(allowedOpenUrl('file:///C:/o/r/pull/3', gh)).toBe(false)
    expect(allowedOpenUrl('javascript:alert(1)', gh)).toBe(false)
    expect(allowedOpenUrl('https://gitlab.empresa.com/g/sub/other/-/jobs/1', gl)).toBe(false)
    expect(allowedOpenUrl('https://github.com/o/r/actions', [])).toBe(false)
  })
})
