import { describe, expect, it } from 'vitest'
import { checks, cleanLog, colorLabels, commits, create, createOptions, ghApprovers, ghEvents, githubMethods, githubRunStatus, gitlabMethods, gitlabRunStatus, setRebaseWait, glStages, jobAction, jobLog, lineComment, listByState, listPage, merge, noteAction, parseDiffFiles, parseLog, pipelineAction, pipelines, react, reply, resolve, summarizeChecks, unapprove, update, upload, versionDiff, versions, view, type HttpMethod, type RepoCall } from './pr-actions'

type Call = { method: string; subpath: string; body?: unknown; text?: boolean }
/** Fake RepoCall: answers by the longest "METHOD subpath-prefix"; records every call. */
function fake(provider: 'github' | 'gitlab', answers: Record<string, unknown>, viewer: string | null = 'chico'): { rc: RepoCall; calls: Call[] } {
  const calls: Call[] = []
  const rc: RepoCall = {
    provider, viewer,
    async call<T>(method: HttpMethod, subpath: string, body?: unknown, options?: { text?: boolean }): Promise<T> {
      calls.push({ method, subpath, body, text: options?.text })
      const key = Object.keys(answers).filter((k) => `${method} ${subpath}`.startsWith(k)).sort((a, b) => b.length - a.length)[0]
      if (key === undefined) throw new Error(`sem resposta para ${method} ${subpath}`)
      const value = answers[key]
      if (value instanceof Error) throw value
      return value as T
    }
  }
  return { rc, calls }
}

const ghPull = { number: 3, title: 'T', body: 'b', html_url: 'u', state: 'open', draft: false, created_at: 'c', updated_at: 'up', head: { ref: 'feat/x', sha: 'h1', repo: { full_name: 'o/r' } }, base: { ref: 'main', sha: 'b1', repo: { full_name: 'o/r' } }, user: { login: 'ana' }, additions: 3, deletions: 1, mergeable_state: 'clean' }

describe('noteAction', () => {
  it('GitLab edits/deletes the note and toggles its award; GitHub routes issue and review comments', async () => {
    const gl = fake('gitlab', { 'PUT merge_requests/5/notes/7': { body: 'novo' }, 'DELETE merge_requests/5/notes/7': {}, 'GET merge_requests/5/notes/7/award_emoji': [], 'POST merge_requests/5/notes/7/award_emoji': {} })
    expect(await noteAction(gl.rc, 5, { kind: 'note', id: '7', action: 'edit', body: 'novo' })).toEqual({ body: 'novo' })
    await noteAction(gl.rc, 5, { kind: 'note', id: '7', action: 'delete' })
    expect(gl.calls[1]).toMatchObject({ method: 'DELETE', subpath: 'merge_requests/5/notes/7' })
    await noteAction(gl.rc, 5, { kind: 'note', id: '7', action: 'react', reaction: 'up' })
    expect(gl.calls.find((c) => c.method === 'POST')).toMatchObject({ subpath: 'merge_requests/5/notes/7/award_emoji', body: { name: 'thumbsup' } })
    const gh = fake('github', { 'PATCH issues/comments/8': { body: 'b' }, 'DELETE pulls/comments/9': {} })
    await noteAction(gh.rc, 3, { kind: 'issue', id: '8', action: 'edit', body: 'b' })
    await noteAction(gh.rc, 3, { kind: 'review', id: '9', action: 'delete' })
    expect(gh.calls.map((c) => `${c.method} ${c.subpath}`)).toEqual(['PATCH issues/comments/8', 'DELETE pulls/comments/9'])
    await expect(noteAction(gh.rc, 3, { kind: 'issue', id: '../x', action: 'delete' })).rejects.toThrow()
  })
  it('a reply can resolve the GitLab thread too', async () => {
    const gl = fake('gitlab', { 'POST merge_requests/5/discussions/abc/notes': { id: 4, author: { username: 'chico' }, body: 'ok', created_at: 't' }, 'PUT merge_requests/5/discussions/abc': {} })
    await reply(gl.rc, 5, 'abc', 'ok', true)
    expect(gl.calls.map((c) => `${c.method} ${c.subpath}`)).toEqual(['POST merge_requests/5/discussions/abc/notes', 'PUT merge_requests/5/discussions/abc'])
  })
})

describe('update', () => {
  it('GitLab: one PUT; draft is the title prefix (read when only draft changes); empty people and milestone clear them', async () => {
    const gl = fake('gitlab', { 'GET merge_requests/5': { title: 'Draft: Corrige login' }, 'GET members/all': [{ id: 9, username: 'ana' }], 'PUT merge_requests/5': {} })
    await update(gl.rc, 5, { draft: false })
    expect(gl.calls.at(-1)).toMatchObject({ method: 'PUT', subpath: 'merge_requests/5', body: { title: 'Corrige login' } })
    await update(gl.rc, 5, { title: 'Novo', draft: true, assignees: ['ana'], reviewers: [], milestone: null, labels: ['ui'], squash: true, state: 'close' })
    expect(gl.calls.at(-1)!.body).toEqual({ title: 'Draft: Novo', assignee_ids: [9], reviewer_ids: [0], milestone_id: 0, labels: 'ui', squash: true, state_event: 'close' })
    await update(gl.rc, 5, { title: 'Só o título' })
    expect(gl.calls.at(-1)!.body).toEqual({ title: 'Draft: Só o título' })
  })
  it('GitHub: closes through the pull and refuses draft', async () => {
    const gh = fake('github', { 'PATCH pulls/3': {} })
    await update(gh.rc, 3, { state: 'close' })
    expect(gh.calls[0]).toMatchObject({ method: 'PATCH', subpath: 'pulls/3', body: { state: 'closed' } })
    await expect(update(gh.rc, 3, { draft: true })).rejects.toThrow()
  })
})

describe('listPage', () => {
  it('asks the page and says there is more only when the raw page came full', async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({ ...ghPull, number: i + 1, state: 'closed', merged_at: i % 2 ? 'd' : null }))
    const gh = fake('github', { 'GET pulls?state=closed': full })
    const merged = await listPage(gh.rc, 'merged', 3)
    expect(gh.calls[0]!.subpath).toContain('per_page=50&page=3')
    expect(merged.prs).toHaveLength(25); expect(merged.more).toBe(true)
    const gl = fake('gitlab', { 'GET merge_requests?': [{ iid: 7, title: 'x', web_url: 'u', source_branch: 'a', target_branch: 'b', created_at: 'c', updated_at: 'up', state: 'merged' }] })
    const last = await listPage(gl.rc, 'merged', 2)
    expect(gl.calls[0]!.subpath).toContain('per_page=50&page=2'); expect(last.more).toBe(false)
  })
})

describe('listByState', () => {
  it('GitHub: merged = closed with merged_at, closed = closed without it', async () => {
    const raw = [{ ...ghPull, number: 1, state: 'closed', merged_at: '2026-01-01' }, { ...ghPull, number: 2, state: 'closed', merged_at: null }]
    const merged = await listByState(fake('github', { 'GET pulls?state=closed': raw }).rc, 'merged')
    const closed = await listByState(fake('github', { 'GET pulls?state=closed': raw }).rc, 'closed')
    expect(merged.map((p) => [p.number, p.state])).toEqual([[1, 'MERGED']])
    expect(closed.map((p) => [p.number, p.state])).toEqual([[2, 'CLOSED']])
  })
  it('GitLab: asks the state and maps opened to OPEN', async () => {
    const { rc, calls } = fake('gitlab', { 'GET merge_requests?state=opened': [{ iid: 7, title: 'x', web_url: 'u', source_branch: 'a', target_branch: 'b', created_at: 'c', updated_at: 'up', state: 'opened', reviewers: [{ username: 'chico' }] }] })
    const prs = await listByState(rc, 'open')
    expect(calls[0]!.subpath).toContain('state=opened')
    expect(prs[0]).toMatchObject({ number: 7, state: 'OPEN', createdAt: 'c', reviewRequested: true })
  })
})

describe('view', () => {
  it('GitHub: SHAs, files with status, grouped threads, reactions and pipeline', async () => {
    const { rc } = fake('github', {
      'GET pulls/3/files': [{ filename: 'a.ts', previous_filename: 'old.ts', status: 'renamed', additions: 1, deletions: 1, patch: '@@' }, { filename: 'n.ts', status: 'added', additions: 2, deletions: 0 }],
      'GET pulls/3/comments': [
        { id: 10, user: { login: 'ana' }, body: 'raiz', created_at: 't1', path: 'a.ts', line: 4, side: 'RIGHT' },
        { id: 11, user: { login: 'bia' }, body: 'resposta', created_at: 't2', path: 'a.ts', line: 4, side: 'RIGHT', in_reply_to_id: 10 }
      ],
      'GET pulls/3/reviews': [{ user: { login: 'ana' }, state: 'APPROVED', body: '' }],
      'GET pulls/3': ghPull,
      'GET issues/3/comments': [],
      'GET issues/3/reactions': [{ content: '+1', user: { login: 'chico' } }, { content: '-1', user: { login: 'ana' } }, { content: 'heart', user: { login: 'x' } }],
      'GET commits/h1/check-runs': { check_runs: [{ status: 'completed', conclusion: 'success' }] }
    })
    const d = await view(rc, 3)
    expect(d).toMatchObject({ headSha: 'h1', baseSha: 'b1', startSha: null, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', pipeline: 'success', canDeleteSource: true, state: 'OPEN' })
    expect(d.files).toEqual([{ path: 'a.ts', oldPath: 'old.ts', status: 'renamed', additions: 1, deletions: 1 }, { path: 'n.ts', oldPath: 'n.ts', status: 'added', additions: 2, deletions: 0 }])
    expect(d.threads).toHaveLength(1)
    expect(d.threads[0]).toMatchObject({ id: '10', path: 'a.ts', oldPath: 'old.ts', side: 'new', line: 4 })
    expect(d.threads[0]!.comments.map((c) => c.body)).toEqual(['raiz', 'resposta'])
    expect(d.reactions).toEqual({ up: 1, down: 1, mineUp: true, mineDown: false })
  })
  it('GitHub: a fork source cannot be deleted', async () => {
    const { rc } = fake('github', { 'GET pulls/3/files': [], 'GET pulls/3/reviews': [], 'GET pulls/3/comments': [], 'GET issues/3': [], 'GET commits': { check_runs: [] }, 'GET pulls/3':{ ...ghPull, head: { ...ghPull.head, repo: { full_name: 'fork/r' } } } })
    expect((await view(rc, 3)).canDeleteSource).toBe(false)
  })
  it('GitLab: diff_refs, DiffNote threads, awards and head pipeline', async () => {
    const { rc } = fake('gitlab', {
      'GET merge_requests/5/notes': [{ id: 1, author: { username: 'ana' }, body: 'geral', created_at: 't' }],
      'GET merge_requests/5/changes': { changes: [{ new_path: 'b.ts', old_path: 'b.ts', new_file: true, diff: '+a\n+b' }] },
      'GET merge_requests/5/approvals': { approved_by: [] },
      'GET merge_requests/5/discussions': [
        { id: 'abc', notes: [{ id: 9, type: 'DiffNote', author: { username: 'ana' }, body: 'x', created_at: 't', position: { new_path: 'b.ts', old_path: 'b.ts', new_line: 2, line_range: { start: { new_line: 1 } } } }, { id: 10, author: { username: 'bia' }, body: 'r', created_at: 't2' }] },
        { id: 'zz', notes: [{ id: 11, type: null, body: 'geral', created_at: 't' }] }
      ],
      'GET merge_requests/5/award_emoji': [{ name: 'thumbsup', user: { username: 'chico' } }],
      'GET merge_requests/5': { iid: 5, title: 'M', description: 'd', web_url: 'u', state: 'opened', source_branch: 's', target_branch: 't', created_at: 'c', updated_at: 'u', has_conflicts: false, source_project_id: 1, target_project_id: 1, diff_refs: { base_sha: 'b', head_sha: 'h', start_sha: 's' }, head_pipeline: { status: 'failed' }, author: { username: 'ana' } }
    })
    const d = await view(rc, 5)
    expect(d).toMatchObject({ state: 'OPEN', headSha: 'h', baseSha: 'b', startSha: 's', pipeline: 'failed', canDeleteSource: true, additions: 2 })
    expect(d.files[0]).toMatchObject({ path: 'b.ts', status: 'added' })
    const note = { kind: 'note', reactions: { up: 0, down: 0, mineUp: false, mineDown: false } }
    expect(d.threads).toEqual([{ id: 'abc', path: 'b.ts', oldPath: 'b.ts', side: 'new', line: 2, startLine: 1, comments: [{ id: '9', author: 'ana', body: 'x', at: 't', url: 'u#note_9', ...note }, { id: '10', author: 'bia', body: 'r', at: 't2', url: 'u#note_10', ...note }], resolvable: false, resolved: false }])
    expect(d.comments).toEqual([{ id: '1', author: 'ana', body: 'geral', at: 't', url: 'u#note_1', ...note }])
    expect(d.reactions).toMatchObject({ up: 1, mineUp: true })
  })
})

describe('line comments and replies', () => {
  const point = { oldLine: null, newLine: 4, oldPos: 3, newPos: 4 }
  const input = { body: 'oi', path: 'a.ts', oldPath: 'a.ts', headSha: 'h', baseSha: 'b', startSha: null, start: point, end: point }
  it('GitHub posts to pulls/{n}/comments and returns the thread', async () => {
    const { rc, calls } = fake('github', { 'POST pulls/3/comments': { id: 50, user: { login: 'chico' }, body: 'oi', created_at: 't' } })
    const t = await lineComment(rc, 3, input)
    expect(calls[0]).toMatchObject({ method: 'POST', subpath: 'pulls/3/comments', body: { commit_id: 'h', line: 4, side: 'RIGHT' } })
    expect(t).toMatchObject({ id: '50', side: 'new', line: 4, startLine: null })
  })
  it('GitLab posts a discussion with position', async () => {
    const { rc, calls } = fake('gitlab', { 'POST merge_requests/5/discussions': { id: 'd1', notes: [{ id: 1, author: { username: 'chico' }, body: 'oi', created_at: 't' }] } })
    const t = await lineComment(rc, 5, { ...input, startSha: 's' })
    expect((calls[0]!.body as { position: { new_line: number } }).position.new_line).toBe(4)
    expect(t.id).toBe('d1')
  })
  it('replies in the same thread and rejects odd ids', async () => {
    const gh = fake('github', { 'POST pulls/3/comments/50/replies': { id: 51, user: { login: 'c' }, body: 'r', created_at: 't' } })
    expect((await reply(gh.rc, 3, '50', 'r')).id).toBe('51')
    const gl = fake('gitlab', { 'POST merge_requests/5/discussions/d1/notes': { id: 2, author: { username: 'c' }, body: 'r', created_at: 't' } })
    expect((await reply(gl.rc, 5, 'd1', 'r')).id).toBe('2')
    await expect(reply(gl.rc, 5, '../x', 'r')).rejects.toThrow()
  })
})

describe('react', () => {
  it('GitHub adds when not mine', async () => {
    const { rc, calls } = fake('github', { 'GET issues/3/reactions': [], 'POST issues/3/reactions': {} })
    await react(rc, 3, 'up')
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ content: '+1' })
  })
  it('GitHub removes when mine', async () => {
    const { rc, calls } = fake('github', { 'GET issues/3/reactions': [{ id: 77, content: '-1', user: { login: 'chico' } }], 'DELETE issues/3/reactions/77': undefined })
    await react(rc, 3, 'down')
    expect(calls.some((c) => c.method === 'DELETE' && c.subpath === 'issues/3/reactions/77')).toBe(true)
  })
  it('GitLab uses award_emoji names', async () => {
    const { rc, calls } = fake('gitlab', { 'GET merge_requests/5/award_emoji': [], 'POST merge_requests/5/award_emoji': {} })
    await react(rc, 5, 'down')
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'thumbsdown' })
  })
  it('needs to know who the viewer is', async () => {
    await expect(react(fake('github', {}, null).rc, 3, 'up')).rejects.toThrow()
  })
})

describe('merge', () => {
  it('GitHub: squash with title/message, then deletes the source ref when asked and allowed', async () => {
    const { rc, calls } = fake('github', { 'GET pulls/3': ghPull, 'PUT pulls/3/merge': { merged: true }, 'DELETE git/refs/heads/feat/x': undefined })
    const out = await merge(rc, 3, { method: 'squash', deleteSourceBranch: true, message: 'Título\n\nCorpo' })
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ merge_method: 'squash', commit_title: 'Título', commit_message: 'Corpo' })
    expect(out).toEqual({ merged: true, branchDeleted: true, warning: null })
  })
  it('GitHub: never deletes when not asked or when the source is a fork', async () => {
    const a = fake('github', { 'GET pulls/3': ghPull, 'PUT pulls/3/merge': { merged: true } })
    expect((await merge(a.rc, 3, { method: 'merge', deleteSourceBranch: false, message: null })).branchDeleted).toBe(false)
    expect(a.calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(a.calls.find((c) => c.method === 'PUT')?.body).toEqual({ merge_method: 'merge' })
    const b = fake('github', { 'GET pulls/3': { ...ghPull, head: { ...ghPull.head, repo: { full_name: 'fork/r' } } }, 'PUT pulls/3/merge': { merged: true } })
    await merge(b.rc, 3, { method: 'merge', deleteSourceBranch: true, message: null })
    expect(b.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })
  it('GitHub: a failed ref delete becomes a warning, not an error', async () => {
    const { rc } = fake('github', { 'GET pulls/3': ghPull, 'PUT pulls/3/merge': { merged: true }, 'DELETE git/refs/heads/feat/x': new Error('protegida') })
    const out = await merge(rc, 3, { method: 'merge', deleteSourceBranch: true, message: null })
    expect(out.merged).toBe(true)
    expect(out.branchDeleted).toBe(false)
    expect(out.warning).toContain('protegida')
  })
  it('GitHub: a refused merge is an error', async () => {
    const { rc } = fake('github', { 'GET pulls/3': ghPull, 'PUT pulls/3/merge': new Error('sem permissão') })
    await expect(merge(rc, 3, { method: 'merge', deleteSourceBranch: false, message: null })).rejects.toThrow('sem permissão')
  })
  it('GitLab: removes the source branch only for the same project', async () => {
    const mr = { iid: 5, source_project_id: 1, target_project_id: 1 }
    const a = fake('gitlab', { 'GET merge_requests/5': mr, 'PUT merge_requests/5/merge': {} })
    const out = await merge(a.rc, 5, { method: 'squash', deleteSourceBranch: true, message: 'msg' })
    expect(a.calls.find((c) => c.method === 'PUT')?.body).toEqual({ squash: true, should_remove_source_branch: true, squash_commit_message: 'msg' })
    expect(out.branchDeleted).toBe(true)
    const b = fake('gitlab', { 'GET merge_requests/5': { ...mr, source_project_id: 2 }, 'PUT merge_requests/5/merge': {} })
    await merge(b.rc, 5, { method: 'merge', deleteSourceBranch: true, message: null })
    expect(b.calls.find((c) => c.method === 'PUT')?.body).toEqual({ squash: false, should_remove_source_branch: false })
  })
  it('rebase leaves no merge commit: GitHub rebase-merges with no message', async () => {
    const { rc, calls } = fake('github', { 'GET pulls/3': ghPull, 'PUT pulls/3/merge': { merged: true } })
    await merge(rc, 3, { method: 'rebase', deleteSourceBranch: false, message: 'ignorada' })
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ merge_method: 'rebase' })
  })
  it('GitLab rebase: rebases a diverged MR first, waits for it, then merges without squash', async () => {
    setRebaseWait(async () => undefined)
    const mr = { iid: 5, source_project_id: 1, target_project_id: 1 }
    const { rc, calls } = fake('gitlab', { 'GET merge_requests/5': mr, 'GET merge_requests/5?include_diverged_commits_count': { diverged_commits_count: 2 }, 'PUT merge_requests/5/rebase': {}, 'GET merge_requests/5?include_rebase_in_progress': { rebase_in_progress: false }, 'PUT merge_requests/5/merge': {} })
    await merge(rc, 5, { method: 'rebase', deleteSourceBranch: false, message: 'ignorada' })
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.subpath)).toEqual(['merge_requests/5/rebase', 'merge_requests/5/merge'])
    expect(calls.at(-1)!.body).toEqual({ squash: false, should_remove_source_branch: false })
    const fresh = fake('gitlab', { 'GET merge_requests/5': mr, 'GET merge_requests/5?include_diverged_commits_count': { diverged_commits_count: 0 }, 'PUT merge_requests/5/merge': {} })
    await merge(fresh.rc, 5, { method: 'rebase', deleteSourceBranch: false, message: null })
    expect(fresh.calls.some((c) => c.subpath.endsWith('/rebase'))).toBe(false)
    const broken = fake('gitlab', { 'GET merge_requests/5': mr, 'GET merge_requests/5?include_diverged_commits_count': { diverged_commits_count: 1 }, 'PUT merge_requests/5/rebase': {}, 'GET merge_requests/5?include_rebase_in_progress': { rebase_in_progress: false, merge_error: 'conflito' }, 'PUT merge_requests/5/merge': {} })
    await expect(merge(broken.rc, 5, { method: 'rebase', deleteSourceBranch: false, message: null })).rejects.toThrow('conflito')
  })
  it('merge methods the host accepts', () => {
    expect(githubMethods({})).toEqual(['merge', 'squash', 'rebase'])
    expect(githubMethods({ allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true })).toEqual(['squash', 'rebase'])
    expect(gitlabMethods({ merge_method: 'ff', squash_option: 'default_off' })).toEqual(['rebase', 'squash'])
    expect(gitlabMethods({ merge_method: 'merge', squash_option: 'never' })).toEqual(['merge'])
    expect(gitlabMethods({ merge_method: 'rebase_merge', squash_option: 'always' })).toEqual(['squash'])
  })
})

describe('checks', () => {
  it('summarizes GitHub check runs', () => {
    expect(summarizeChecks([])).toBe('none')
    expect(summarizeChecks([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }])).toBe('failed')
    expect(summarizeChecks([{ status: 'in_progress' }, { status: 'completed', conclusion: 'success' }])).toBe('running')
    expect(summarizeChecks([{ status: 'queued' }])).toBe('pending')
    expect(summarizeChecks([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }])).toBe('success')
  })
  it('reads each PR and degrades to none on error', async () => {
    const gh = fake('github', { 'GET pulls/1': ghPull, 'GET commits/h1/check-runs': { check_runs: [{ status: 'completed', conclusion: 'success' }] }, 'GET pulls/2': new Error('x') })
    expect(await checks(gh.rc, [1, 2])).toEqual([{ number: 1, status: 'success', approvals: null }, { number: 2, status: 'none', approvals: null }])
    const gl = fake('gitlab', { 'GET merge_requests/4': { head_pipeline: { status: 'running' } } })
    expect(await checks(gl.rc, [4])).toEqual([{ number: 4, status: 'running', approvals: 0 }])
  })
})

describe('detail extras', () => {
  it('GitHub: labels, people, approvals by latest review and timeline events', async () => {
    const { rc, calls } = fake('github', {
      'GET pulls/3/files': [], 'GET pulls/3/comments': [], 'GET issues/3/comments': [], 'GET issues/3/reactions': [], 'GET commits': { check_runs: [] },
      'GET pulls/3/reviews': [{ user: { login: 'ana' }, state: 'APPROVED' }, { user: { login: 'chico' }, state: 'APPROVED' }, { user: { login: 'chico' }, state: 'COMMENTED' }, { user: { login: 'bia' }, state: 'APPROVED' }, { user: { login: 'bia' }, state: 'DISMISSED' }],
      'GET issues/3/timeline': [
        { event: 'labeled', actor: { login: 'ana' }, label: { name: 'bug' }, created_at: 't1' },
        { event: 'committed', sha: 'abcdef1234567', message: 'Primeiro\n\ncorpo', author: { name: 'Ana', date: 'd1' }, committer: { date: 'd1' } },
        { event: 'committed', sha: 'bbbbbbbb999', message: 'Segundo', author: { name: 'Ana', date: 'd2' }, committer: { date: 'd2' } },
        { event: 'review_requested', actor: { login: 'ana' }, requested_reviewer: { login: 'chico' }, created_at: 't2' },
        { event: 'subscribed', actor: { login: 'x' }, created_at: 't3' },
        { event: 'merged', actor: { login: 'ana' }, created_at: 't4' }
      ],
      'GET pulls/3': { ...ghPull, labels: [{ name: 'bug', color: 'd73a4a' }], assignees: [{ login: 'ana' }], requested_reviewers: [{ login: 'chico' }] }
    })
    const d = await view(rc, 3)
    expect(calls.some((c) => c.subpath.startsWith('issues/3/timeline?per_page=100&page=1'))).toBe(true)
    expect(d.labels).toEqual([{ name: 'bug', color: '#d73a4a' }])
    expect(d.assignees).toEqual([{ login: 'ana', name: 'ana' }])
    expect(d.reviewers).toEqual([{ login: 'chico', name: 'chico' }])
    expect(d.approvedBy).toEqual(['ana', 'chico'])
    expect(d).toMatchObject({ approvedByMe: true, canUnapprove: false })
    expect(d.events.map((e) => e.author)).toEqual(['ana', 'Ana', 'ana', 'ana'])
    expect(d.events[1]!.body).toMatch(/2/)
    expect(d.events[1]!.at).toBe('d2')
    expect(d.events[0]!.body).toContain('bug')
  })
  it('GitHub: a single commit names its short sha and title', () => {
    const [e] = ghEvents([{ event: 'committed', sha: 'abcdef1234567', message: 'Primeiro\ncorpo', author: { name: 'Ana', date: 'd1' } }])
    expect(e!.body).toContain('abcdef12')
    expect(e!.body).toContain('Primeiro')
    expect(e!.body).not.toContain('corpo')
  })
  it('GitLab: labels with details, people, approvals, system notes and resolvable threads', async () => {
    const { rc, calls } = fake('gitlab', {
      'GET merge_requests/5/notes': [{ id: 1, author: { username: 'ana' }, body: 'geral', created_at: 't1' }, { id: 2, system: true, author: { username: 'ana' }, body: 'added 2 commits', created_at: 't2' }],
      'GET merge_requests/5/changes': { changes: [] },
      'GET merge_requests/5/approvals': { approved_by: [{ user: { username: 'chico' } }] },
      'GET merge_requests/5/discussions': [{ id: 'abc', notes: [{ id: 9, type: 'DiffNote', resolvable: true, resolved: true, author: { username: 'ana' }, body: 'x', created_at: 't', position: { new_path: 'b.ts', old_path: 'b.ts', new_line: 2 } }] }],
      'GET merge_requests/5/award_emoji': [],
      'GET merge_requests/5': { iid: 5, title: 'M', web_url: 'u', state: 'opened', source_branch: 's', target_branch: 't', created_at: 'c', updated_at: 'u', labels: [{ name: 'bug', color: '#ff0000' }], assignees: [{ username: 'ana', name: 'Ana' }], reviewers: [{ username: 'chico', name: 'Chico' }] }
    })
    const d = await view(rc, 5)
    expect(calls[0]!.subpath).toBe('merge_requests/5?with_labels_details=true')
    expect(d.labels).toEqual([{ name: 'bug', color: '#ff0000' }])
    expect(d.assignees).toEqual([{ login: 'ana', name: 'Ana' }])
    expect(d.reviewers).toEqual([{ login: 'chico', name: 'Chico' }])
    expect(d).toMatchObject({ approvedBy: ['chico'], approvedByMe: true, canUnapprove: true })
    expect(d.events).toEqual([{ author: 'ana', body: 'added 2 commits', at: 't2' }])
    expect(d.comments).toHaveLength(1)
    expect(d.threads[0]).toMatchObject({ resolvable: true, resolved: true })
  })
  it('colors plain label names from the project labels, read once', async () => {
    const { rc, calls } = fake('gitlab', { 'GET labels': [{ name: 'bug', color: '#ff0000' }] })
    expect(await colorLabels(rc, [['bug', 'nova'], ['bug']])).toEqual([[{ name: 'bug', color: '#ff0000' }, { name: 'nova', color: '#888888' }], [{ name: 'bug', color: '#ff0000' }]])
    expect(calls).toHaveLength(1)
    expect(await colorLabels(fake('github', {}).rc, [[{ name: 'x', color: '00ff00' }], undefined])).toEqual([[{ name: 'x', color: '#00ff00' }], []])
  })
  it('lists fill labels on both providers', async () => {
    const gh = fake('github', { 'GET pulls?state=open': [{ ...ghPull, labels: [{ name: 'ui', color: 'aabbcc' }] }] })
    expect((await listByState(gh.rc, 'open'))[0]!.labels).toEqual([{ name: 'ui', color: '#aabbcc' }])
    const gl = fake('gitlab', { 'GET merge_requests?': [{ iid: 7, title: 'x', web_url: 'u', source_branch: 'a', target_branch: 'b', created_at: 'c', updated_at: 'up', state: 'opened', labels: [{ name: 'ui', color: '#123456' }] }] })
    expect((await listByState(gl.rc, 'open'))[0]!.labels).toEqual([{ name: 'ui', color: '#123456' }])
    expect(gl.calls[0]!.subpath).toContain('with_labels_details=true')
  })
})

describe('checks approvals', () => {
  it('counts approvals on both providers', async () => {
    expect(ghApprovers([{ user: { login: 'a' }, state: 'APPROVED' }, { user: { login: 'a' }, state: 'CHANGES_REQUESTED' }, { user: { login: 'b' }, state: 'APPROVED' }])).toEqual(['b'])
    const gh = fake('github', { 'GET pulls/1/reviews': [{ user: { login: 'b' }, state: 'APPROVED' }], 'GET pulls/1': ghPull, 'GET commits': { check_runs: [] } })
    expect(await checks(gh.rc, [1])).toEqual([{ number: 1, status: 'none', approvals: 1 }])
    const gl = fake('gitlab', { 'GET merge_requests/4/approvals': { approved_by: [{}, {}] }, 'GET merge_requests/4': { head_pipeline: { status: 'success' } } })
    expect(await checks(gl.rc, [4])).toEqual([{ number: 4, status: 'success', approvals: 2 }])
  })
})

describe('commits', () => {
  it('GitHub: paged pulls/n/commits, login over name, first line', async () => {
    const { rc, calls } = fake('github', { 'GET pulls/3/commits': [{ sha: '0123456789abcdef', commit: { message: 'Título\n\ncorpo', author: { name: 'Ana Souza', date: 'd1' } }, author: { login: 'ana' } }, { sha: 'fedcba9876543210', commit: { message: 'Outro', author: { name: 'Sem Login', date: 'd2' } }, author: null }] })
    expect(await commits(rc, 3)).toEqual([{ sha: '0123456789abcdef', shortSha: '01234567', title: 'Título', author: 'ana', at: 'd1', email: '' }, { sha: 'fedcba9876543210', shortSha: 'fedcba98', title: 'Outro', author: 'Sem Login', at: 'd2', email: '' }])
    expect(calls[0]!.subpath).toBe('pulls/3/commits?per_page=100&page=1')
  })
  it('GitLab: merge_requests/n/commits, oldest first', async () => {
    const { rc, calls } = fake('gitlab', { 'GET merge_requests/5/commits': [{ id: 'bbbbbbbbbb', title: 'Novo', author_name: 'Ana', authored_date: 'd2' }, { id: 'aaaaaaaaaa', title: 'Velho', author_name: 'Bia', authored_date: 'd1' }] })
    expect((await commits(rc, 5)).map((c) => [c.shortSha, c.title, c.author, c.at])).toEqual([['aaaaaaaa', 'Velho', 'Bia', 'd1'], ['bbbbbbbb', 'Novo', 'Ana', 'd2']])
    expect(calls[0]!.subpath).toBe('merge_requests/5/commits?per_page=100&page=1')
  })
})

describe('pipelines', () => {
  it('maps statuses', () => {
    expect(['created', 'waiting_for_resource', 'preparing', 'scheduled', 'pending', 'canceling', 'canceled', 'skipped', 'manual', 'running', 'success', 'failed'].map(gitlabRunStatus))
      .toEqual(['pending', 'pending', 'pending', 'pending', 'pending', 'canceled', 'canceled', 'skipped', 'manual', 'running', 'success', 'failed'])
    expect([['queued', null], ['waiting', null], ['in_progress', null], ['completed', 'success'], ['completed', 'failure'], ['completed', 'timed_out'], ['completed', 'startup_failure'], ['completed', 'cancelled'], ['completed', 'skipped'], ['completed', 'neutral'], ['completed', 'action_required']].map(([s, c]) => githubRunStatus(s, c)))
      .toEqual(['pending', 'pending', 'running', 'success', 'failed', 'failed', 'failed', 'canceled', 'skipped', 'skipped', 'manual'])
  })
  it('GitLab: groups jobs into stages by first appearance in id order', () => {
    const stages = glStages([{ id: 5, name: 'deploy', stage: 'deploy', status: 'manual' }, { id: 2, name: 'unit', stage: 'test', status: 'success', duration: 12.5, started_at: 's', web_url: 'w' }, { id: 1, name: 'build', stage: 'build', status: 'success' }, { id: 3, name: 'lint', stage: 'test', status: 'failed' }])
    expect(stages.map((s) => [s.name, s.jobs.map((j) => j.name)])).toEqual([['build', ['build']], ['test', ['unit', 'lint']], ['deploy', ['deploy']]])
    expect(stages[1]!.jobs[0]).toEqual({ id: '2', name: 'unit', status: 'success', duration: 12.5, startedAt: 's', url: 'w' })
  })
  it('GitLab: newest first, details and jobs only for the 5 newest', async () => {
    const list = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, sha: `s${i + 1}`, ref: 'feat', status: 'success', web_url: `https://g/p/-/pipelines/${i + 1}` }))
    const { rc, calls } = fake('gitlab', {
      'GET merge_requests/5/pipelines': list,
      'GET pipelines/7/jobs': [{ id: 70, name: 'build', stage: 'build', status: 'running' }],
      'GET pipelines/': { duration: 30, created_at: 'c', source: 'merge_request_event' }
    })
    const out = await pipelines(rc, 5)
    expect(out.canAct).toBe(true)
    expect(out.pipelines.map((p) => p.id)).toEqual(['7', '6', '5', '4', '3', '2', '1'])
    expect(out.pipelines[0]).toMatchObject({ sha: 's7', ref: 'feat', source: 'merge_request_event', duration: 30, createdAt: 'c', url: 'https://g/p/-/pipelines/7', status: 'success' })
    expect(out.pipelines[0]!.stages[0]!.jobs[0]!.status).toBe('running')
    expect(calls.some((c) => c.subpath === 'pipelines/7/jobs?per_page=100&include_retried=false')).toBe(true)
    expect(calls.some((c) => c.subpath.startsWith('pipelines/2'))).toBe(false)
    expect(out.pipelines[6]!.stages).toEqual([])
  })
  it('GitHub: each workflow run of the head sha is a pipeline with one stage', async () => {
    const { rc, calls } = fake('github', {
      'GET pulls/3': ghPull,
      'GET actions/runs?': { workflow_runs: [{ id: 11, name: 'CI', head_sha: 'h1', head_branch: 'feat/x', event: 'pull_request', status: 'completed', conclusion: 'failure', created_at: 'c', run_started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:01:30Z', html_url: 'https://github.com/o/r/actions/runs/11' }] },
      'GET actions/runs/11/jobs': { jobs: [{ id: 99, name: 'test', status: 'completed', conclusion: 'failure', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:10Z', html_url: 'https://github.com/o/r/actions/runs/11/job/99' }] }
    })
    const out = await pipelines(rc, 3)
    expect(calls.find((c) => c.subpath.startsWith('actions/runs?'))!.subpath).toBe('actions/runs?head_sha=h1&per_page=10')
    expect(out).toEqual({ canAct: true, pipelines: [{ id: '11', sha: 'h1', ref: 'feat/x', source: 'pull_request', status: 'failed', createdAt: 'c', duration: 90, url: 'https://github.com/o/r/actions/runs/11', stages: [{ name: 'CI', jobs: [{ id: '99', name: 'test', status: 'failed', duration: 10, startedAt: '2026-01-01T00:00:00Z', url: 'https://github.com/o/r/actions/runs/11/job/99' }] }] }] })
  })
  it('GitHub: without Actions runs, check runs become one "Checks" pipeline', async () => {
    const { rc } = fake('github', { 'GET pulls/3': ghPull, 'GET actions/runs?': { workflow_runs: [] }, 'GET commits/h1/check-runs': { check_runs: [{ id: 1, name: 'ext', status: 'completed', conclusion: 'success', check_suite: { id: 77 }, html_url: 'https://github.com/o/r/runs/1' }, { id: 2, name: 'ext2', status: 'in_progress' }] } })
    const out = await pipelines(rc, 3)
    expect(out.canAct).toBe(false)
    expect(out.pipelines[0]).toMatchObject({ id: '77', source: 'checks', status: 'running', stages: [{ name: 'Checks' }] })
    expect(out.pipelines[0]!.stages[0]!.jobs.map((j) => j.status)).toEqual(['success', 'running'])
  })
})

describe('job logs', () => {
  it('cleans ANSI codes and GitLab section markers and normalizes line ends', () => {
    const raw = 'section_start:1700000000:prepare[collapsed=true]\r\x1b[0K\x1b[36;1mPreparing\x1b[0;m\r\nok\r\nsection_end:1700000000:prepare\r\x1b[0K\x1b]8;;http://x\x07link\x1b]8;;\x07\nfim'
    expect(cleanLog(raw)).toEqual({ text: 'Preparing\nok\nlink\nfim', truncated: false })
  })
  it('keeps only the tail when the log is too big, from a whole line', () => {
    const out = cleanLog('aaaa\nbbbb\ncccc\ndddd', 12)
    expect(out.truncated).toBe(true)
    expect(out.text).toBe('cccc\ndddd')
  })
  it('asks the trace/logs as text on each provider and validates the id', async () => {
    const gl = fake('gitlab', { 'GET jobs/4/trace': '\x1b[32mok\x1b[0m\r\n' })
    expect(await jobLog(gl.rc, '4')).toEqual({ text: 'ok\n', truncated: false })
    expect(gl.calls[0]).toMatchObject({ method: 'GET', subpath: 'jobs/4/trace', text: true })
    const gh = fake('github', { 'GET actions/jobs/9/logs': 'linha' })
    expect((await jobLog(gh.rc, '9')).text).toBe('linha')
    expect(gh.calls[0]).toMatchObject({ subpath: 'actions/jobs/9/logs', text: true })
    await expect(jobLog(gh.rc, '../1')).rejects.toThrow()
    // GitHub has no log while the job runs (404): a note instead of the error; a finished job's 404 stays an error.
    const running = fake('github', { 'GET actions/jobs/9/logs': new Error('404'), 'GET actions/jobs/9': { status: 'in_progress' } })
    expect((await jobLog(running.rc, '9')).text).toMatch(/GitHub/)
    const done = fake('github', { 'GET actions/jobs/9/logs': new Error('404'), 'GET actions/jobs/9': { status: 'completed' } })
    await expect(jobLog(done.rc, '9')).rejects.toThrow('404')
  })
})

describe('pipeline and job actions', () => {
  it('GitLab: POST pipelines/:id and jobs/:id cancel|retry', async () => {
    const { rc, calls } = fake('gitlab', { 'POST ': {} })
    await pipelineAction(rc, '10', 'cancel'); await pipelineAction(rc, '10', 'retry'); await jobAction(rc, '20', 'cancel'); await jobAction(rc, '20', 'retry')
    expect(calls.map((c) => `${c.method} ${c.subpath}`)).toEqual(['POST pipelines/10/cancel', 'POST pipelines/10/retry', 'POST jobs/20/cancel', 'POST jobs/20/retry'])
  })
  it('GitHub: runs cancel/rerun, job rerun, and a clear error to cancel one job', async () => {
    const { rc, calls } = fake('github', { 'POST ': {} })
    await pipelineAction(rc, '10', 'cancel'); await pipelineAction(rc, '10', 'retry'); await jobAction(rc, '20', 'retry')
    expect(calls.map((c) => `${c.method} ${c.subpath}`)).toEqual(['POST actions/runs/10/cancel', 'POST actions/runs/10/rerun', 'POST actions/jobs/20/rerun'])
    await expect(jobAction(rc, '20', 'cancel')).rejects.toThrow(/workflow/)
    await expect(pipelineAction(rc, 'x', 'cancel')).rejects.toThrow()
  })
})

describe('versions', () => {
  it('GitLab: newest first with SHAs', async () => {
    const { rc, calls } = fake('gitlab', { 'GET merge_requests/5/versions': [{ id: 1, head_commit_sha: 'h1', base_commit_sha: 'b', start_commit_sha: 's', created_at: 'c1' }, { id: 2, head_commit_sha: 'h2', created_at: 'c2' }] })
    expect(await versions(rc, 5)).toEqual([{ id: '2', headSha: 'h2', baseSha: null, startSha: null, createdAt: 'c2' }, { id: '1', headSha: 'h1', baseSha: 'b', startSha: 's', createdAt: 'c1' }])
    expect(calls[0]!.subpath).toBe('merge_requests/5/versions?per_page=100')
  })
  it('GitLab: the diff of one version like the detail builds it', async () => {
    const { rc } = fake('gitlab', { 'GET merge_requests/5/versions/2': { head_commit_sha: 'h', base_commit_sha: 'b', start_commit_sha: 's', diffs: [{ new_path: 'n.ts', old_path: 'o.ts', renamed_file: true, diff: '@@ -1 +1 @@\n-a\n+b' }] } })
    expect(await versionDiff(rc, 5, '2')).toEqual({ diff: 'diff --git a/o.ts b/n.ts\n@@ -1 +1 @@\n-a\n+b', files: [{ path: 'n.ts', oldPath: 'o.ts', status: 'renamed', additions: 1, deletions: 1 }], headSha: 'h', baseSha: 'b', startSha: 's' })
  })
  it('GitHub: no versions; asking a version diff is an error', async () => {
    const { rc, calls } = fake('github', {})
    expect(await versions(rc, 3)).toEqual([])
    await expect(versionDiff(rc, 3, '1')).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe('unapprove and resolve', () => {
  it('GitLab: POST unapprove and PUT the discussion with resolved', async () => {
    const { rc, calls } = fake('gitlab', { 'POST ': {}, 'PUT ': {} })
    await unapprove(rc, 5)
    await resolve(rc, 5, 'abc123', true)
    expect(calls).toEqual([{ method: 'POST', subpath: 'merge_requests/5/unapprove', body: {}, text: undefined }, { method: 'PUT', subpath: 'merge_requests/5/discussions/abc123', body: { resolved: true }, text: undefined }])
    await expect(resolve(rc, 5, '../x', false)).rejects.toThrow()
  })
  it('GitHub: both are clear errors', async () => {
    const { rc, calls } = fake('github', {})
    await expect(unapprove(rc, 3)).rejects.toThrow()
    await expect(resolve(rc, 3, '1', true)).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe('createOptions', () => {
  it('GitLab: active members, active milestones, labels; uploads only with the token door', async () => {
    const answers = { 'GET members/all': [{ id: 1, username: 'ana', name: 'Ana', state: 'active' }, { id: 2, username: 'velho', name: 'V', state: 'blocked' }], 'GET milestones': [{ id: 9, title: 'v1', due_date: '2026-12-01' }], 'GET labels': [{ name: 'bug', color: '#f00000' }] }
    const { rc, calls } = fake('gitlab', answers)
    const out = await createOptions(rc)
    expect(calls.map((c) => c.subpath)).toEqual(['members/all?per_page=100', 'milestones?state=active&per_page=100', 'labels?per_page=100'])
    expect(out).toEqual({ viewer: 'chico', members: [{ login: 'ana', name: 'Ana' }], milestones: [{ id: '9', title: 'v1', due: '2026-12-01' }], labels: [{ name: 'bug', color: '#f00000' }], supports: { assignees: true, reviewers: true, milestone: true, labels: true, deleteSource: true, squash: true, uploads: false } })
    const withUpload = fake('gitlab', answers).rc
    withUpload.upload = async () => ({})
    expect((await createOptions(withUpload)).supports.uploads).toBe(true)
  })
  it('GitHub: assignees, open milestones by number, labels with #; a failing list is empty', async () => {
    const { rc, calls } = fake('github', { 'GET assignees': [{ login: 'ana' }], 'GET milestones': new Error('403'), 'GET labels': [{ name: 'ui', color: 'aabbcc' }] })
    const out = await createOptions(rc)
    expect(calls.map((c) => c.subpath)).toEqual(['assignees?per_page=100', 'milestones?state=open&per_page=100', 'labels?per_page=100'])
    expect(out).toEqual({ viewer: 'chico', members: [{ login: 'ana', name: 'ana' }], milestones: [], labels: [{ name: 'ui', color: '#aabbcc' }], supports: { assignees: true, reviewers: true, milestone: true, labels: true, deleteSource: false, squash: false, uploads: false } })
  })
})

describe('create', () => {
  const input = { head: 'feat', base: 'main', title: 'T', body: 'B', draft: false, squash: true, assignees: ['ana', 'ninguem'], reviewers: ['bia'], milestone: '9', labels: ['bug', 'ui'], deleteSourceBranch: true }
  it('GitLab: one POST merge_requests with ids resolved from members; unknown names become a warning', async () => {
    const { rc, calls } = fake('gitlab', { 'GET members/all': [{ id: 1, username: 'ana' }, { id: 2, username: 'bia' }], 'POST merge_requests': { web_url: 'https://g/p/-/merge_requests/8', iid: 8 } })
    const out = await create(rc, input)
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ subpath: 'merge_requests', body: { source_branch: 'feat', target_branch: 'main', title: 'T', description: 'B', squash: true, remove_source_branch: true, assignee_ids: [1], reviewer_ids: [2], milestone_id: 9, labels: 'bug,ui' } })
    expect(out.url).toBe('https://g/p/-/merge_requests/8')
    expect(out.number).toBe(8)
    expect(out.warning).toContain('ninguem')
  })
  it('GitLab: draft prefix and no member lookup without people', async () => {
    const { rc, calls } = fake('gitlab', { 'POST merge_requests': { web_url: 'u', iid: 1 } })
    await create(rc, { head: 'a', base: 'b', title: 'T', body: '', draft: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toEqual({ source_branch: 'a', target_branch: 'b', title: 'Draft: T', description: '' })
  })
  it('GitHub: POST pulls then assignees, labels, PATCH milestone and reviewers (never the viewer)', async () => {
    const { rc, calls } = fake('github', { 'POST pulls/12/requested_reviewers': {}, 'POST pulls': { html_url: 'https://github.com/o/r/pull/12', number: 12 }, 'POST issues/12': {}, 'PATCH issues/12': {} })
    const out = await create(rc, { ...input, reviewers: ['bia', 'chico'] })
    expect(calls.map((c) => [c.method, c.subpath, c.body])).toEqual([
      ['POST', 'pulls', { title: 'T', head: 'feat', base: 'main', body: 'B', draft: false }],
      ['POST', 'issues/12/assignees', { assignees: ['ana', 'ninguem'] }],
      ['POST', 'issues/12/labels', { labels: ['bug', 'ui'] }],
      ['PATCH', 'issues/12', { milestone: 9 }],
      ['POST', 'pulls/12/requested_reviewers', { reviewers: ['bia'] }]
    ])
    expect(out).toEqual({ url: 'https://github.com/o/r/pull/12', number: 12, warning: null })
  })
  it('GitHub: a failed follow-up keeps the PR and becomes a warning', async () => {
    const { rc } = fake('github', { 'POST pulls': { html_url: 'u', number: 2 }, 'POST issues/2/labels': new Error('sem permissão'), 'POST issues/2': {} })
    const out = await create(rc, { head: 'a', base: 'b', title: 'T', body: '', draft: false, assignees: ['ana'], labels: ['x'] })
    expect(out.number).toBe(2)
    expect(out.warning).toContain('sem permissão')
  })
})

describe('upload', () => {
  it('GitLab with the token door: posts to uploads and returns the markdown', async () => {
    const { rc } = fake('gitlab', {})
    let seen: { subpath: string; name: string; size: number } | null = null
    rc.upload = async (subpath, name, data) => { seen = { subpath, name, size: data.length }; return { markdown: '![a](/uploads/a.png)' } }
    expect(await upload(rc, 'a.png', Buffer.from('abc').toString('base64'))).toEqual({ markdown: '![a](/uploads/a.png)' })
    expect(seen).toEqual({ subpath: 'uploads', name: 'a.png', size: 3 })
  })
  it('refuses GitHub, the CLI door and files over 10 MB', async () => {
    await expect(upload(fake('github', {}).rc, 'a.png', 'YQ==')).rejects.toThrow()
    await expect(upload(fake('gitlab', {}).rc, 'a.png', 'YQ==')).rejects.toThrow()
    const { rc } = fake('gitlab', {})
    rc.upload = async () => ({ markdown: 'x' })
    await expect(upload(rc, 'big.bin', Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'))).rejects.toThrow(/10/)
  })
})

describe('compare parsing', () => {
  it('parses log lines and -z diff outputs', () => {
    expect(parseLog('a\x1fa1\x1fT\x1fAna\x1f2026\x1fana@x.com\r\n\n')).toEqual([{ sha: 'a', shortSha: 'a1', title: 'T', author: 'Ana', at: '2026', email: 'ana@x.com' }])
    expect(parseDiffFiles('1\t2\tx.ts\0', 'M\0x.ts\0')).toEqual([{ path: 'x.ts', oldPath: 'x.ts', status: 'modified', additions: 1, deletions: 2 }])
  })
})