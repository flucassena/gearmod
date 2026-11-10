import type { PrCommit, PrCreateOptions, PrFile, PrJob, PrLabel, PrMergeMethod, PrPerson, PrPipeline, PrVersion, PullRequestDetail, PullRequestSummary } from '@gearmod/contracts'
import { tm } from './i18n'
import { githubLineBody, gitlabLineBody, type LineCommentInput } from './pr-positions'

export type PrProvider = 'github' | 'gitlab'
export type PrState = 'open' | 'merged' | 'closed' | 'all'
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type Pipeline = PullRequestDetail['pipeline']
type Thread = PullRequestDetail['threads'][number]
type ThreadComment = Thread['comments'][number]
type Reactions = PullRequestDetail['reactions']
type PrEvent = PullRequestDetail['events'][number]
type RunStatus = PrPipeline['status']

/** One REST door into the repository, the same for the token (HostApi) and for the CLIs (`gh api`/`glab api`). `subpath` is relative to the repository (`pulls/3`, `merge_requests/3/notes`). */
export interface RepoCall {
  provider: PrProvider
  /** Login of whoever is acting (token owner or CLI user); null when unknown. */
  viewer: string | null
  /** `text: true` returns the answer as it came (job logs) instead of parsing JSON. */
  call<T = unknown>(method: HttpMethod, subpath: string, body?: unknown, options?: { text?: boolean }): Promise<T>
  /** Multipart file upload (`file` field) to `subpath`; only the token door has it. */
  upload?(subpath: string, name: string, data: Uint8Array): Promise<unknown>
}

const MAX_DIFF = 300_000
const MAX_FILE_PAGES = 10
const MAX_LOG = 200 * 1024
const MAX_UPLOAD = 10 * 1024 * 1024
const NEUTRAL_COLOR = '#888888'
const cutDiff = (diff: string): string => diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… diff cortado (muito grande); abra o PR no navegador para ver tudo.` : diff
const countDiff = (diff: string): { additions: number; deletions: number } => {
  let additions = 0, deletions = 0
  for (const line of diff.split('\n')) { if (line.startsWith('+') && !line.startsWith('+++')) additions++; else if (line.startsWith('-') && !line.startsWith('---')) deletions++ }
  return { additions, deletions }
}
const safeId = (id: string): string => { if (!/^[\w.-]+$/.test(id)) throw new Error(tm().pullRequests.invalidThread); return id }
const numId = (id: string): string => { if (!/^\d{1,20}$/.test(id)) throw new Error(tm().pullRequests.invalidId); return id }
const refPath = (branch: string): string => branch.split('/').map(encodeURIComponent).join('/')
const empty = async <T>(promise: Promise<T>, fallback: T): Promise<T> => promise.catch(() => fallback)
const firstLine = (text: string | null | undefined): string => (text ?? '').split(/\r?\n/)[0] ?? ''
const hexColor = (color: string | null | undefined): string => !color ? NEUTRAL_COLOR : color.startsWith('#') ? color : `#${color}`
const seconds = (start: string | null | undefined, end: string | null | undefined): number | null => {
  if (!start || !end) return null
  const value = (Date.parse(end) - Date.parse(start)) / 1000
  return Number.isFinite(value) ? Math.max(0, value) : null
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Pipeline status from GitHub check runs: any failure fails, anything unfinished is running/pending. */
export function summarizeChecks(runs: Array<{ status?: string; conclusion?: string | null }>): Pipeline {
  if (!runs.length) return 'none'
  if (runs.some((run) => run.status === 'completed' && ['failure', 'timed_out', 'startup_failure', 'action_required'].includes(run.conclusion ?? ''))) return 'failed'
  if (runs.some((run) => run.status === 'in_progress')) return 'running'
  if (runs.some((run) => run.status !== 'completed')) return 'pending'
  if (runs.every((run) => ['cancelled', 'canceled'].includes(run.conclusion ?? ''))) return 'canceled'
  return 'success'
}
export function gitlabPipeline(status: string | null | undefined): Pipeline {
  switch (status) {
    case 'success': return 'success'
    case 'failed': return 'failed'
    case 'running': return 'running'
    case 'canceled': case 'canceling': return 'canceled'
    case 'pending': case 'created': case 'waiting_for_resource': case 'preparing': case 'scheduled': case 'manual': return 'pending'
    default: return 'none'
  }
}
/** Status of a GitLab pipeline or job, with `skipped` and `manual` kept apart. */
export function gitlabRunStatus(status: string | null | undefined): RunStatus {
  switch (status) {
    case 'success': return 'success'
    case 'failed': return 'failed'
    case 'running': return 'running'
    case 'skipped': return 'skipped'
    case 'manual': return 'manual'
    case 'canceled': case 'canceling': return 'canceled'
    default: return 'pending'
  }
}
/** Status of a GitHub workflow run, job or check run (`status` + `conclusion`). */
export function githubRunStatus(status: string | null | undefined, conclusion: string | null | undefined): RunStatus {
  if (status !== 'completed') return status === 'in_progress' ? 'running' : 'pending'
  switch (conclusion) {
    case 'success': return 'success'
    case 'failure': case 'timed_out': case 'startup_failure': return 'failed'
    case 'cancelled': case 'canceled': return 'canceled'
    case 'action_required': return 'manual'
    default: return 'skipped'
  }
}
const gitlabState = (state: string): 'OPEN' | 'MERGED' | 'CLOSED' => state === 'merged' ? 'MERGED' : state === 'opened' ? 'OPEN' : 'CLOSED'

interface GhUser { login?: string; avatar_url?: string }
/** Reaction counts GitHub puts on each comment. */
interface GhReactionSummary { '+1'?: number; '-1'?: number }
interface GhLabel { name?: string; color?: string | null }
interface GhPull {
  number: number; title: string; body?: string | null; html_url: string; state: string; merged?: boolean; merged_at?: string | null; draft?: boolean; created_at: string; updated_at: string
  head: { ref: string; sha: string; repo?: { full_name?: string } | null }; base: { ref: string; sha: string; repo?: { full_name?: string } | null }
  user?: GhUser | null; additions?: number; deletions?: number; mergeable_state?: string | null; requested_reviewers?: GhUser[]; assignees?: GhUser[]; labels?: GhLabel[]; milestone?: { number?: number; title?: string } | null
}
interface GhReview { user?: GhUser | null; body?: string; state: string; submitted_at?: string }
interface GhReviewComment { id: number; user?: GhUser | null; body: string; created_at: string; html_url?: string; reactions?: GhReactionSummary | null; path: string; line?: number | null; original_line?: number | null; side?: string | null; start_line?: number | null; in_reply_to_id?: number | null }
interface GhCheckRun { id?: number; name?: string; status?: string; conclusion?: string | null; started_at?: string | null; completed_at?: string | null; html_url?: string | null; check_suite?: { id?: number } | null }
interface GhRun { id: number; name?: string | null; head_sha?: string; head_branch?: string | null; event?: string; status?: string; conclusion?: string | null; created_at?: string; run_started_at?: string | null; updated_at?: string; html_url?: string | null }
interface GhJob { id: number; name?: string; status?: string; conclusion?: string | null; started_at?: string | null; completed_at?: string | null; html_url?: string | null }
/** One item of `issues/:n/timeline` (only the fields the history uses). */
export interface GhTimelineItem {
  event?: string; actor?: GhUser | null; created_at?: string; assignee?: GhUser | null; label?: { name?: string } | null; requested_reviewer?: GhUser | null; requested_team?: { name?: string } | null
  rename?: { from?: string; to?: string } | null; milestone?: { title?: string } | null; sha?: string; message?: string; author?: { name?: string; date?: string } | null; committer?: { date?: string } | null
}
type RawLabel = string | { name?: string; color?: string | null }
interface GlNote { id: number; author?: GlUser; body: string; created_at: string; system?: boolean; type?: string | null; position?: GlPosition | null; resolvable?: boolean; resolved?: boolean }
interface GlPosition { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null; line_range?: { start?: { new_line?: number | null; old_line?: number | null } } | null }
interface GlDiscussion { id: string; notes: GlNote[] }
interface GlUser { id?: number; username?: string; name?: string; state?: string; avatar_url?: string | null; public_email?: string | null }
interface GlMr {
  iid: number; title: string; description?: string | null; web_url: string; state: string; draft?: boolean; work_in_progress?: boolean; source_branch: string; target_branch: string; created_at: string; updated_at: string
  has_conflicts?: boolean; author?: GlUser | null; reviewers?: GlUser[]; assignees?: GlUser[]; labels?: RawLabel[]; user_notes_count?: number; source_project_id?: number; target_project_id?: number
  diff_refs?: { base_sha?: string; head_sha?: string; start_sha?: string } | null; head_pipeline?: { status?: string } | null
  milestone?: { id?: number; title?: string } | null; squash?: boolean; force_remove_source_branch?: boolean | null
}
interface GlChange { new_path: string; old_path?: string; new_file?: boolean; deleted_file?: boolean; renamed_file?: boolean; diff: string }
interface GlPipelineRef { id: number; sha?: string; ref?: string; status?: string; source?: string; created_at?: string; duration?: number | null; web_url?: string | null }
interface GlJob { id: number; name?: string; stage?: string; status?: string; duration?: number | null; started_at?: string | null; web_url?: string | null }

const NO_REACTIONS = { up: 0, down: 0, mineUp: false, mineDown: false }
const ghSummary = (summary: GhReactionSummary | null | undefined): Reactions => ({ up: summary?.['+1'] ?? 0, down: summary?.['-1'] ?? 0, mineUp: false, mineDown: false })
const ghThreadComment = (c: GhReviewComment): ThreadComment => ({ id: String(c.id), author: c.user?.login ?? '', body: c.body, at: c.created_at, url: c.html_url ?? '', kind: 'review', reactions: ghSummary(c.reactions) })
/** A GitLab note; `web` is the MR page (the note's link is its `#note_<id>` anchor). */
const glThreadComment = (n: GlNote, web = ''): ThreadComment => ({ id: String(n.id), author: n.author?.username ?? '', body: n.body, at: n.created_at, url: web ? `${web}#note_${n.id}` : '', kind: 'note', reactions: NO_REACTIONS })
/** login → photo URL, from every person object the host returned (the first one seen wins). */
function avatarMap(people: Array<{ login?: string; username?: string; avatar_url?: string | null } | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const person of people) { const login = person?.login ?? person?.username, url = person?.avatar_url; if (login && url && /^https?:\/\//.test(url) && !(login in out)) out[login] = url }
  return out
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** E-mail of a host user when the host lets it show: the public e-mail, or a display name that is itself an e-mail (common on company GitLabs). */
export const personEmail = (person: { name?: string | null; public_email?: string | null; email?: string | null } | null | undefined): string => {
  const found = [person?.public_email, person?.email, person?.name].find((value) => value && EMAIL.test(value.trim()))
  return found ? found.trim().toLowerCase() : ''
}
function emailMap(people: Array<{ login?: string; username?: string; name?: string | null; public_email?: string | null; email?: string | null } | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const person of people) { const login = person?.login ?? person?.username, email = personEmail(person); if (login && email && !(login in out)) out[login] = email }
  return out
}
const ghPerson = (user: GhUser): PrPerson => ({ login: user.login ?? '', name: user.login ?? '' })
const glPerson = (user: GlUser): PrPerson => ({ login: user.username ?? '', name: user.name || user.username || '' })

function ghThreads(comments: GhReviewComment[], oldPaths: Map<string, string>): Thread[] {
  const replies = new Map<number, GhReviewComment[]>()
  for (const c of comments) if (c.in_reply_to_id) replies.set(c.in_reply_to_id, [...(replies.get(c.in_reply_to_id) ?? []), c])
  const threads: Thread[] = []
  for (const root of comments.filter((c) => !c.in_reply_to_id)) {
    const line = root.line ?? root.original_line
    if (!line) continue
    threads.push({ id: String(root.id), path: root.path, oldPath: oldPaths.get(root.path) ?? root.path, side: root.side === 'LEFT' ? 'old' : 'new', line, startLine: root.start_line ?? null, comments: [root, ...(replies.get(root.id) ?? [])].map(ghThreadComment), resolvable: false, resolved: false })
  }
  return threads
}

/** A discussion is resolvable when any of its notes is; resolved when every resolvable note is. */
function glResolution(notes: GlNote[]): { resolvable: boolean; resolved: boolean } {
  const resolvable = notes.filter((n) => n.resolvable)
  return { resolvable: resolvable.length > 0, resolved: resolvable.length > 0 && resolvable.every((n) => n.resolved) }
}

function glThreads(discussions: GlDiscussion[], web = ''): Thread[] {
  const threads: Thread[] = []
  for (const d of discussions) {
    const first = d.notes[0], pos = first?.position
    if (!first || first.type !== 'DiffNote' || !pos) continue
    const line = pos.new_line ?? pos.old_line
    if (!line) continue
    const start = pos.line_range?.start, startLine = start ? (start.new_line ?? start.old_line ?? null) : null
    threads.push({ id: d.id, path: pos.new_path ?? pos.old_path ?? '', oldPath: pos.old_path ?? pos.new_path ?? '', side: pos.new_line ? 'new' : 'old', line, startLine: startLine !== null && startLine !== line ? startLine : null, comments: d.notes.filter((n) => !n.system).map((n) => glThreadComment(n, web)), ...glResolution(d.notes) })
  }
  return threads
}

function countReactions(items: Array<{ who: string; kind: 'up' | 'down' | null }>, viewer: string | null): Reactions {
  const up = items.filter((i) => i.kind === 'up'), down = items.filter((i) => i.kind === 'down')
  return { up: up.length, down: down.length, mineUp: Boolean(viewer && up.some((i) => i.who === viewer)), mineDown: Boolean(viewer && down.some((i) => i.who === viewer)) }
}
const ghKind = (content: string): 'up' | 'down' | null => content === '+1' ? 'up' : content === '-1' ? 'down' : null
const glKind = (name: string): 'up' | 'down' | null => name === 'thumbsup' ? 'up' : name === 'thumbsdown' ? 'down' : null

/** GitHub: who approved, by each user's latest deciding review (a later comment does not undo an approval; a dismissal or change request does). */
export function ghApprovers(reviews: GhReview[]): string[] {
  const latest = new Map<string, string>()
  for (const review of reviews) {
    const who = review.user?.login
    if (who && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(who, review.state)
  }
  return [...latest].filter(([, state]) => state === 'APPROVED').map(([who]) => who)
}

/** Labels with their color: objects already carry it (GitHub without `#`); plain names (GitLab without details) are colored from the project's labels, read once. */
export async function colorLabels(rc: RepoCall, lists: Array<RawLabel[] | undefined>): Promise<PrLabel[][]> {
  const colors = new Map<string, string>()
  if (lists.some((list) => list?.some((item) => typeof item === 'string'))) {
    for (const label of await empty(rc.call<GhLabel[]>('GET', 'labels?per_page=100'), [])) if (label.name) colors.set(label.name, hexColor(label.color))
  }
  return lists.map((list) => (list ?? []).map((item) => typeof item === 'string' ? { name: item, color: colors.get(item) ?? NEUTRAL_COLOR } : { name: item.name ?? '', color: hexColor(item.color) }))
}

async function pages<T>(rc: RepoCall, subpath: string, max: number): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; page <= max; page++) {
    const batch = await rc.call<T[]>('GET', `${subpath}${subpath.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    all.push(...batch)
    if (batch.length < 100) break
  }
  return all
}

/** Lists up to 50 PRs/MRs of a state (the first page). */
export async function listByState(rc: RepoCall, state: PrState): Promise<PullRequestSummary[]> { return (await listPage(rc, state, 1)).prs }

/** Assignees of a list row: the login and the host's photo, people without a login dropped. */
export const listAssignees = (people: Array<{ login?: string | null; avatar?: string | null; email?: string }>): Array<{ login: string; avatar: string; email: string }> =>
  people.flatMap((person) => person.login ? [{ login: person.login, avatar: person.avatar ?? '', email: person.email ?? '' }] : [])
/** Size of a page of the PR list; a full page means there may be more (`more`). */
export const PR_PAGE = 50
/** One page (from 1) of the PRs/MRs of a state, most recently updated first. GitHub "merged" is a closed PR with `merged_at` (so a page may come shorter; `more` reads the raw page). */
export async function listPage(rc: RepoCall, state: PrState, page: number): Promise<{ prs: PullRequestSummary[]; more: boolean }> {
  const viewer = rc.viewer
  if (rc.provider === 'github') {
    const got = await rc.call<GhPull[]>('GET', `pulls?state=${state === 'open' ? 'open' : state === 'all' ? 'all' : 'closed'}&per_page=${PR_PAGE}&page=${page}&sort=updated&direction=desc`)
    const raw = got.filter((pr) => state === 'merged' ? Boolean(pr.merged_at) : state === 'closed' ? !pr.merged_at : true)
    const labels = await colorLabels(rc, raw.map((pr) => pr.labels))
    return { more: got.length >= PR_PAGE, prs: raw.map((pr, index) => ({
      number: pr.number, title: pr.title, url: pr.html_url, draft: Boolean(pr.draft), head: pr.head.ref, base: pr.base.ref, updatedAt: pr.updated_at, createdAt: pr.created_at,
      state: pr.merged_at ? 'MERGED' as const : pr.state === 'open' ? 'OPEN' as const : 'CLOSED' as const, reviewDecision: null, author: pr.user?.login ?? '', comments: 0,
      reviewRequested: Boolean(viewer && pr.requested_reviewers?.some((item) => item.login === viewer)), labels: labels[index] ?? [], assignees: listAssignees((pr.assignees ?? []).map((item) => ({ login: item.login, avatar: item.avatar_url })))
    })) }
  }
  const glState = state === 'open' ? 'opened' : state
  const raw = await rc.call<GlMr[]>('GET', `merge_requests?state=${glState}&per_page=${PR_PAGE}&page=${page}&order_by=updated_at&with_labels_details=true`)
  const labels = await colorLabels(rc, raw.map((mr) => mr.labels))
  return { more: raw.length >= PR_PAGE, prs: raw.map((mr, index) => ({
    number: mr.iid, title: mr.title, url: mr.web_url, draft: Boolean(mr.draft ?? mr.work_in_progress), head: mr.source_branch, base: mr.target_branch, updatedAt: mr.updated_at, createdAt: mr.created_at,
    state: gitlabState(mr.state), reviewDecision: null, author: mr.author?.username ?? '', comments: mr.user_notes_count ?? 0,
    reviewRequested: Boolean(viewer && mr.reviewers?.some((item) => item.username === viewer)), labels: labels[index] ?? [], assignees: listAssignees((mr.assignees ?? []).map((item) => ({ login: item.username, avatar: item.avatar_url, email: personEmail(item) })))
  })) }
}

/** Pipeline status and approval count of up to 20 PRs/MRs. A failure to read one becomes `none`/`null`, never an error for the whole list. */
export async function checks(rc: RepoCall, numbers: number[]): Promise<Array<{ number: number; status: Pipeline; approvals: number | null }>> {
  return Promise.all(numbers.map(async (number) => {
    if (rc.provider === 'github') {
      const [status, approvals] = await Promise.all([
        (async () => {
          const pr = await rc.call<GhPull>('GET', `pulls/${number}`)
          const runs = await rc.call<{ check_runs?: GhCheckRun[] }>('GET', `commits/${pr.head.sha}/check-runs?per_page=100`)
          return summarizeChecks(runs.check_runs ?? [])
        })().catch(() => 'none' as const),
        rc.call<GhReview[]>('GET', `pulls/${number}/reviews?per_page=100`).then((reviews) => ghApprovers(reviews).length).catch(() => null)
      ])
      return { number, status, approvals }
    }
    const [status, approvals] = await Promise.all([
      rc.call<GlMr>('GET', `merge_requests/${number}`).then((mr) => gitlabPipeline(mr.head_pipeline?.status)).catch(() => 'none' as const),
      rc.call<{ approved_by?: unknown[] }>('GET', `merge_requests/${number}/approvals`).then((a) => (a.approved_by ?? []).length).catch(() => null)
    ])
    return { number, status, approvals }
  }))
}

export async function view(rc: RepoCall, number: number): Promise<PullRequestDetail> {
  return rc.provider === 'github' ? viewGithub(rc, number) : viewGitlab(rc, number)
}

/** GitHub timeline events as readable lines; consecutive commits by the same author become one line. */
export function ghEvents(items: GhTimelineItem[]): PrEvent[] {
  const e = tm().pullRequests.events
  const out: PrEvent[] = []
  let commits: GhTimelineItem[] = []
  const flush = (): void => {
    const first = commits[0], last = commits.at(-1)
    if (!first || !last) return
    out.push({ author: first.author?.name ?? '', body: commits.length === 1 ? e.commit((first.sha ?? '').slice(0, 8), firstLine(first.message)) : e.commits(commits.length), at: last.committer?.date ?? last.author?.date ?? '' })
    commits = []
  }
  for (const item of items) {
    if (item.event === 'committed') {
      if (commits[0] && commits[0].author?.name !== item.author?.name) flush()
      commits.push(item)
      continue
    }
    flush()
    const who = (user: GhUser | null | undefined): string => user?.login ?? ''
    let body: string | null = null
    switch (item.event) {
      case 'assigned': body = e.assigned(who(item.assignee)); break
      case 'unassigned': body = e.unassigned(who(item.assignee)); break
      case 'labeled': body = e.labeled(item.label?.name ?? ''); break
      case 'unlabeled': body = e.unlabeled(item.label?.name ?? ''); break
      case 'review_requested': body = e.reviewRequested(item.requested_reviewer?.login ?? item.requested_team?.name ?? ''); break
      case 'review_request_removed': body = e.reviewRequestRemoved(item.requested_reviewer?.login ?? item.requested_team?.name ?? ''); break
      case 'ready_for_review': body = e.readyForReview; break
      case 'convert_to_draft': body = e.convertToDraft; break
      case 'head_ref_force_pushed': body = e.forcePushed; break
      case 'head_ref_deleted': body = e.branchDeleted; break
      case 'renamed': body = e.renamed(item.rename?.from ?? '', item.rename?.to ?? ''); break
      case 'milestoned': body = e.milestoned(item.milestone?.title ?? ''); break
      case 'demilestoned': body = e.demilestoned(item.milestone?.title ?? ''); break
      case 'closed': body = e.closed; break
      case 'reopened': body = e.reopened; break
      case 'merged': body = e.merged; break
    }
    if (body !== null) out.push({ author: who(item.actor), body, at: item.created_at ?? '' })
  }
  flush()
  return out.slice(-500)
}

/** What the repository accepts (GitHub hides the flags from who can't push: then all three). */
export const githubMethods = (repo: { allow_merge_commit?: boolean; allow_squash_merge?: boolean; allow_rebase_merge?: boolean }): PrMergeMethod[] => {
  const out: PrMergeMethod[] = []
  if (repo.allow_merge_commit !== false) out.push('merge')
  if (repo.allow_squash_merge !== false) out.push('squash')
  if (repo.allow_rebase_merge !== false) out.push('rebase')
  return out.length ? out : ['merge']
}
/** GitLab sets the method per project: fast-forward (`ff`) leaves no merge commit, the others always make one; squash follows `squash_option`. */
export const gitlabMethods = (project: { merge_method?: string; squash_option?: string }): PrMergeMethod[] => {
  if (project.squash_option === 'always') return ['squash']
  const out: PrMergeMethod[] = [project.merge_method === 'ff' ? 'rebase' : 'merge']
  if (project.squash_option !== 'never') out.push('squash')
  return out
}

async function viewGithub(rc: RepoCall, number: number): Promise<PullRequestDetail> {
  const base = `pulls/${number}`
  const pr = await rc.call<GhPull>('GET', base)
  const [files, comments, reviews, reviewComments, reactions, runs, timeline, repo] = await Promise.all([
    empty(pages<{ filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string }>(rc, `${base}/files`, MAX_FILE_PAGES), []),
    empty(rc.call<Array<{ id: number; user?: GhUser | null; body: string; created_at: string; html_url?: string; reactions?: GhReactionSummary | null }>>('GET', `issues/${number}/comments?per_page=100`), []),
    empty(rc.call<GhReview[]>('GET', `${base}/reviews?per_page=100`), []),
    empty(pages<GhReviewComment>(rc, `${base}/comments`, 5), []),
    empty(rc.call<Array<{ content: string; user?: GhUser | null }>>('GET', `issues/${number}/reactions?per_page=100`), []),
    empty(rc.call<{ check_runs?: GhCheckRun[] }>('GET', `commits/${pr.head.sha}/check-runs?per_page=100`), { check_runs: [] }),
    empty(pages<GhTimelineItem>(rc, `issues/${number}/timeline`, 3), []),
    empty(rc.call<{ allow_merge_commit?: boolean; allow_squash_merge?: boolean; allow_rebase_merge?: boolean }>('GET', ''), {})
  ])
  const decided = reviews.filter((item) => item.state === 'APPROVED' || item.state === 'CHANGES_REQUESTED').at(-1)
  const diff = files.map((file) => `diff --git a/${file.previous_filename ?? file.filename} b/${file.filename}\n--- a/${file.previous_filename ?? file.filename}\n+++ b/${file.filename}\n${file.patch ?? ''}`).join('\n')
  const oldPaths = new Map(files.map((file) => [file.filename, file.previous_filename ?? file.filename]))
  const approvedBy = ghApprovers(reviews)
  const [labels] = await colorLabels(rc, [pr.labels])
  return {
    number: pr.number, title: pr.title, body: pr.body ?? '', url: pr.html_url, state: pr.merged ? 'MERGED' : pr.state.toUpperCase(), draft: Boolean(pr.draft), head: pr.head.ref, base: pr.base.ref,
    reviewDecision: decided ? (decided.state === 'APPROVED' ? 'APPROVED' : 'CHANGES_REQUESTED') : null, author: pr.user?.login ?? '', additions: pr.additions ?? 0, deletions: pr.deletions ?? 0,
    mergeable: pr.mergeable_state === 'dirty' ? 'CONFLICTING' : pr.mergeable_state && pr.mergeable_state !== 'unknown' ? 'MERGEABLE' : null,
    files: files.map((file) => ({ path: file.filename, oldPath: file.previous_filename ?? file.filename, status: file.status === 'added' ? 'added' as const : file.status === 'removed' ? 'removed' as const : file.status === 'renamed' ? 'renamed' as const : 'modified' as const, additions: file.additions, deletions: file.deletions })),
    comments: comments.map((item) => ({ id: String(item.id), author: item.user?.login ?? '', body: item.body, at: item.created_at, url: item.html_url ?? '', kind: 'issue' as const, reactions: ghSummary(item.reactions) })),
    reviews: reviews.filter((item) => item.state !== 'PENDING').map((item) => ({ author: item.user?.login ?? '', body: item.body ?? '', state: item.state, at: item.submitted_at ?? '' })),
    diff: cutDiff(diff),
    headSha: pr.head.sha, baseSha: pr.base.sha, startSha: null, createdAt: pr.created_at, pipeline: summarizeChecks(runs.check_runs ?? []),
    canDeleteSource: Boolean(pr.head.repo?.full_name && pr.head.repo.full_name === pr.base.repo?.full_name),
    mergeMethods: githubMethods(repo), mergeDefault: 'merge',
    threads: ghThreads(reviewComments, oldPaths).slice(0, 500),
    reactions: countReactions(reactions.map((item) => ({ who: item.user?.login ?? '', kind: ghKind(item.content) })), rc.viewer),
    labels: labels ?? [], assignees: (pr.assignees ?? []).map(ghPerson), reviewers: (pr.requested_reviewers ?? []).map(ghPerson),
    approvedBy, approvedByMe: Boolean(rc.viewer && approvedBy.includes(rc.viewer)), canUnapprove: false,
    avatars: avatarMap([pr.user, ...(pr.assignees ?? []), ...(pr.requested_reviewers ?? []), ...comments.map((item) => item.user), ...reviews.map((item) => item.user), ...reviewComments.map((item) => item.user), ...timeline.map((item) => item.actor)]),
    viewer: rc.viewer, emails: {},
    events: ghEvents(timeline), milestone: pr.milestone?.number !== undefined ? String(pr.milestone.number) : null, milestoneTitle: pr.milestone?.title ?? null, squashOnMerge: null, removeSourceOnMerge: null
  }
}

/** The unified diff and file list from GitLab `changes`/`diffs` entries (MR detail and MR versions). */
export function glDiffParts(list: GlChange[]): { files: PrFile[]; diff: string } {
  const files = list.map((item) => ({ path: item.new_path, oldPath: item.old_path ?? item.new_path, status: item.new_file ? 'added' as const : item.deleted_file ? 'removed' as const : item.renamed_file ? 'renamed' as const : 'modified' as const, ...countDiff(item.diff) }))
  const diff = list.map((item) => `diff --git a/${item.old_path ?? item.new_path} b/${item.new_path}\n${item.diff}`).join('\n')
  return { files, diff: cutDiff(diff) }
}

async function viewGitlab(rc: RepoCall, number: number): Promise<PullRequestDetail> {
  const base = `merge_requests/${number}`
  const mr = await rc.call<GlMr>('GET', `${base}?with_labels_details=true`)
  const [notes, changes, approvals, discussions, awards, project] = await Promise.all([
    empty(rc.call<GlNote[]>('GET', `${base}/notes?per_page=100&sort=asc`), []),
    empty(rc.call<{ changes?: GlChange[] }>('GET', `${base}/changes`), { changes: [] }),
    empty(rc.call<{ approved_by?: Array<{ user?: GlUser }> }>('GET', `${base}/approvals`), { approved_by: [] }),
    empty(rc.call<GlDiscussion[]>('GET', `${base}/discussions?per_page=100`), []),
    empty(rc.call<Array<{ name: string; user?: { username?: string } }>>('GET', `${base}/award_emoji?per_page=100`), []),
    empty(rc.call<{ merge_method?: string; squash_option?: string }>('GET', ''), {})
  ])
  const { files, diff } = glDiffParts(changes.changes ?? [])
  const approved = approvals.approved_by ?? []
  const approvedBy = approved.map((item) => item.user?.username ?? '').filter(Boolean)
  const approvedByMe = Boolean(rc.viewer && approvedBy.includes(rc.viewer))
  const [labels] = await colorLabels(rc, [mr.labels])
  // Comments with their link; the reactions of each (the last 40 notes) come in one parallel round.
  const comments = notes.filter((note) => !note.system && note.type !== 'DiffNote').map((note) => glThreadComment(note, mr.web_url))
  const threads = glThreads(discussions, mr.web_url).slice(0, 500)
  const counted = await glNoteReactions(rc, number, [...comments, ...threads.flatMap((thread) => thread.comments)].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((comment) => comment.id))
  const withReactions = (comment: ThreadComment): ThreadComment => ({ ...comment, reactions: counted.get(comment.id) ?? comment.reactions })
  const glPeople = [mr.author, ...(mr.assignees ?? []), ...(mr.reviewers ?? []), ...approved.map((item) => item.user), ...notes.map((note) => note.author), ...discussions.flatMap((d) => d.notes.map((note) => note.author))]
  return {
    number: mr.iid, title: mr.title, body: mr.description ?? '', url: mr.web_url, state: gitlabState(mr.state), draft: Boolean(mr.draft ?? mr.work_in_progress), head: mr.source_branch, base: mr.target_branch,
    reviewDecision: approved.length ? 'APPROVED' : null, author: mr.author?.username ?? '', additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    mergeable: mr.has_conflicts ? 'CONFLICTING' : null, files,
    comments: comments.map(withReactions),
    reviews: approved.map((item) => ({ author: item.user?.username ?? '', body: '', state: 'APPROVED', at: '' })),
    diff,
    headSha: mr.diff_refs?.head_sha ?? null, baseSha: mr.diff_refs?.base_sha ?? null, startSha: mr.diff_refs?.start_sha ?? null, createdAt: mr.created_at, pipeline: gitlabPipeline(mr.head_pipeline?.status),
    canDeleteSource: mr.source_project_id !== undefined && mr.source_project_id === mr.target_project_id,
    mergeMethods: gitlabMethods(project), mergeDefault: 'merge',
    threads: threads.map((thread) => ({ ...thread, comments: thread.comments.map(withReactions) })),
    reactions: countReactions(awards.map((item) => ({ who: item.user?.username ?? '', kind: glKind(item.name) })), rc.viewer),
    labels: labels ?? [], assignees: (mr.assignees ?? []).map(glPerson), reviewers: (mr.reviewers ?? []).map(glPerson),
    approvedBy, approvedByMe, canUnapprove: approvedByMe,
    milestone: mr.milestone?.id !== undefined ? String(mr.milestone.id) : null, milestoneTitle: mr.milestone?.title ?? null, squashOnMerge: mr.squash ?? null, removeSourceOnMerge: mr.force_remove_source_branch ?? null,
    avatars: avatarMap(glPeople),
    emails: emailMap(glPeople),
    viewer: rc.viewer,
    events: notes.filter((note) => note.system).map((note) => ({ author: note.author?.username ?? '', body: note.body, at: note.created_at })).slice(-500)
  }
}

/** Sends a comment pinned to a line or range of the diff the user is looking at (same SHAs as the detail on screen). */
export async function lineComment(rc: RepoCall, number: number, input: LineCommentInput): Promise<Thread> {
  const end = input.end, startLine = input.start.newLine ?? input.start.oldLine, endLine = (end.newLine ?? end.oldLine) as number
  const side = end.newLine !== null ? 'new' as const : 'old' as const
  const pinned = { path: input.path, oldPath: input.oldPath, side, line: endLine, startLine: startLine !== null && startLine !== endLine ? startLine : null }
  if (rc.provider === 'github') {
    const c = await rc.call<GhReviewComment>('POST', `pulls/${number}/comments`, githubLineBody(input))
    return { id: String(c.id), ...pinned, comments: [ghThreadComment(c)], resolvable: false, resolved: false }
  }
  const d = await rc.call<GlDiscussion>('POST', `merge_requests/${number}/discussions`, gitlabLineBody(input))
  return { id: d.id, ...pinned, comments: d.notes.filter((n) => !n.system).map((n) => glThreadComment(n)), ...glResolution(d.notes) }
}

/** Replies to a thread; with `resolveToo` (GitLab, "Resolver thread" ticked) the thread is resolved right after. */
export async function reply(rc: RepoCall, number: number, threadId: string, body: string, resolveToo = false): Promise<ThreadComment> {
  const id = safeId(threadId)
  if (rc.provider === 'github') return ghThreadComment(await rc.call<GhReviewComment>('POST', `pulls/${number}/comments/${id}/replies`, { body }))
  const note = glThreadComment(await rc.call<GlNote>('POST', `merge_requests/${number}/discussions/${id}/notes`, { body }))
  if (resolveToo) await resolve(rc, number, threadId, true)
  return note
}

/** Toggles 👍/👎: removes the viewer's reaction when it exists, adds it otherwise, and returns the new counts. */
export async function react(rc: RepoCall, number: number, kind: 'up' | 'down'): Promise<Reactions> {
  return toggleReaction(rc, rc.provider === 'github' ? `issues/${number}/reactions` : `merge_requests/${number}/award_emoji`, kind)
}

/** Where a comment lives on the host, by its kind: a GitLab note, a GitHub review comment (on a line) or issue comment (general). */
function notePath(rc: RepoCall, number: number, kind: 'note' | 'review' | 'issue', id: string): { base: string; reactions: string } {
  if (!/^\d{1,20}$/.test(id)) throw new Error(tm().pullRequests.invalidThread)
  if (rc.provider === 'gitlab') { const base = `merge_requests/${number}/notes/${id}`; return { base, reactions: `${base}/award_emoji` } }
  const base = kind === 'issue' ? `issues/comments/${id}` : `pulls/comments/${id}`
  return { base, reactions: `${base}/reactions` }
}

/** Edits, deletes or toggles a 👍/👎 on one comment. The host decides who may (author, maintainers); its refusal comes back as the error. */
export async function noteAction(rc: RepoCall, number: number, input: { kind: 'note' | 'review' | 'issue'; id: string; action: 'edit' | 'delete' | 'react'; body?: string; reaction?: 'up' | 'down' }): Promise<{ body?: string; reactions?: Reactions }> {
  const path = notePath(rc, number, input.kind, input.id)
  if (input.action === 'react') return { reactions: await toggleReaction(rc, path.reactions, input.reaction ?? 'up') }
  if (input.action === 'delete') { await rc.call('DELETE', path.base); return {} }
  const body = input.body ?? ''
  const saved = await rc.call<{ body?: string }>(rc.provider === 'gitlab' ? 'PUT' : 'PATCH', path.base, { body })
  return { body: saved?.body ?? body }
}

/** Reactions of a list of GitLab notes (one call each, at most the last 40: older ones keep no counts). */
async function glNoteReactions(rc: RepoCall, number: number, ids: string[]): Promise<Map<string, Reactions>> {
  const out = new Map<string, Reactions>()
  await Promise.all(ids.slice(-40).map(async (id) => {
    const raw = await empty(rc.call<Array<{ name?: string; user?: { username?: string } | null }>>('GET', `merge_requests/${number}/notes/${id}/award_emoji?per_page=100`), [])
    out.set(id, countReactions(raw.map((item) => ({ who: item.user?.username ?? '', kind: glKind(item.name ?? '') })), rc.viewer))
  }))
  return out
}

/** Toggles the viewer's 👍/👎 in a reactions list (a PR/MR or one comment) and returns the new counts. */
async function toggleReaction(rc: RepoCall, listPath: string, kind: 'up' | 'down'): Promise<Reactions> {
  if (!rc.viewer) throw new Error(tm().pullRequests.unknownViewer)
  const gh = rc.provider === 'github'
  const read = async (): Promise<Array<{ id: number; who: string; kind: 'up' | 'down' | null }>> => {
    const raw = await rc.call<Array<{ id: number; content?: string; name?: string; user?: { login?: string; username?: string } | null }>>('GET', `${listPath}?per_page=100`)
    return raw.map((item) => ({ id: item.id, who: item.user?.login ?? item.user?.username ?? '', kind: gh ? ghKind(item.content ?? '') : glKind(item.name ?? '') }))
  }
  const mine = (await read()).find((item) => item.who === rc.viewer && item.kind === kind)
  if (mine) await rc.call('DELETE', `${listPath}/${mine.id}`)
  else await rc.call('POST', listPath, gh ? { content: kind === 'up' ? '+1' : '-1' } : { name: kind === 'up' ? 'thumbsup' : 'thumbsdown' })
  return countReactions(await read(), rc.viewer)
}

/** Merges on the server only; never touches local branches or the working folder. A failed source-branch delete is a warning, not an error. */
/** Pause between looks while GitLab rebases (tests make it instant). */
let rebaseWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
export function setRebaseWait(next: (ms: number) => Promise<void>): void { rebaseWait = next }

/**
 * Merges on the server only; never touches local branches or the working folder. A failed source-branch delete is a warning, not an error.
 * `rebase` leaves no merge commit: GitHub's "rebase and merge"; on GitLab the MR is rebased first when it is behind (fast-forward projects).
 */
export async function merge(rc: RepoCall, number: number, options: { method: PrMergeMethod; deleteSourceBranch: boolean; message: string | null }): Promise<{ merged: true; branchDeleted: boolean; warning: string | null }> {
  // A rebase makes no commit of its own: there is no message to give.
  const message = options.method !== 'rebase' && options.message?.trim() ? options.message : null
  if (rc.provider === 'github') {
    const pr = await rc.call<GhPull>('GET', `pulls/${number}`)
    const newline = message?.indexOf('\n') ?? -1
    const body: Record<string, unknown> = { merge_method: options.method }
    if (message) { body.commit_title = newline < 0 ? message.trim() : message.slice(0, newline).trim(); if (newline >= 0) body.commit_message = message.slice(newline + 1).trim() }
    const result = await rc.call<{ merged?: boolean; message?: string }>('PUT', `pulls/${number}/merge`, body)
    if (result.merged === false) throw new Error(tm().pullRequests.mergeRefused(result.message ?? ''))
    const sameRepo = Boolean(pr.head.repo?.full_name && pr.head.repo.full_name === pr.base.repo?.full_name)
    if (!options.deleteSourceBranch || !sameRepo) return { merged: true, branchDeleted: false, warning: null }
    try { await rc.call('DELETE', `git/refs/heads/${refPath(pr.head.ref)}`); return { merged: true, branchDeleted: true, warning: null } } catch (error) {
      return { merged: true, branchDeleted: false, warning: tm().pullRequests.branchNotDeleted((error as Error).message) }
    }
  }
  const mr = await rc.call<GlMr>('GET', `merge_requests/${number}`)
  const sameProject = mr.source_project_id !== undefined && mr.source_project_id === mr.target_project_id
  const remove = options.deleteSourceBranch && sameProject
  if (options.method === 'rebase') await rebaseGitlab(rc, number)
  const body: Record<string, unknown> = { squash: options.method === 'squash', should_remove_source_branch: remove }
  if (message) body[options.method === 'squash' ? 'squash_commit_message' : 'merge_commit_message'] = message
  await rc.call('PUT', `merge_requests/${number}/merge`, body)
  return { merged: true, branchDeleted: remove, warning: null }
}

/** Rebases the MR on its target when it is behind, waiting (up to ~2 min) for GitLab to finish. */
async function rebaseGitlab(rc: RepoCall, number: number): Promise<void> {
  const base = `merge_requests/${number}`
  const now = await rc.call<{ diverged_commits_count?: number }>('GET', `${base}?include_diverged_commits_count=true`)
  if (!now.diverged_commits_count) return
  await rc.call('PUT', `${base}/rebase`, {})
  for (let round = 0; round < 120; round++) {
    await rebaseWait(1000)
    const state = await rc.call<{ rebase_in_progress?: boolean; merge_error?: string | null }>('GET', `${base}?include_rebase_in_progress=true`)
    if (state.rebase_in_progress) continue
    if (state.merge_error) throw new Error(tm().pullRequests.rebaseFailed(state.merge_error))
    return
  }
  throw new Error(tm().pullRequests.rebaseFailed(tm().pullRequests.rebaseSlow))
}

/** Commits of the PR/MR, oldest first (GitHub lists them that way; GitLab newest first, so it is reversed). At most 250. */
export async function commits(rc: RepoCall, number: number): Promise<PrCommit[]> {
  if (rc.provider === 'github') {
    const raw = await pages<{ sha: string; commit: { message?: string; author?: { name?: string; email?: string; date?: string } | null; committer?: { date?: string } | null }; author?: GhUser | null }>(rc, `pulls/${number}/commits`, 3)
    return raw.slice(0, 250).map((c) => ({ sha: c.sha, shortSha: c.sha.slice(0, 8), title: firstLine(c.commit.message), author: c.author?.login || c.commit.author?.name || '', at: c.commit.author?.date ?? c.commit.committer?.date ?? '', email: c.commit.author?.email ?? '' }))
  }
  const raw = await pages<{ id: string; title?: string; message?: string; author_name?: string; author_email?: string; authored_date?: string; created_at?: string; committed_date?: string }>(rc, `merge_requests/${number}/commits`, 3)
  return raw.slice(0, 250).reverse().map((c) => ({ sha: c.id, shortSha: c.id.slice(0, 8), title: c.title ?? firstLine(c.message), author: c.author_name ?? '', at: c.authored_date ?? c.committed_date ?? c.created_at ?? '', email: c.author_email ?? '' }))
}

/** GitLab jobs grouped into stages, in the order the stages first appear when the jobs are sorted by id. */
export function glStages(jobs: GlJob[]): PrPipeline['stages'] {
  const stages = new Map<string, PrJob[]>()
  for (const job of (Array.isArray(jobs) ? [...jobs] : []).sort((a, b) => a.id - b.id)) {
    const name = job.stage ?? ''
    if (!stages.has(name)) stages.set(name, [])
    stages.get(name)!.push({ id: String(job.id), name: job.name ?? '', status: gitlabRunStatus(job.status), duration: typeof job.duration === 'number' ? Math.max(0, job.duration) : null, startedAt: job.started_at ?? null, url: job.web_url ?? null })
  }
  return [...stages].map(([name, list]) => ({ name, jobs: list }))
}
const glPipelineOf = (p: GlPipelineRef, jobs: GlJob[]): PrPipeline => ({ id: String(p.id), sha: p.sha ?? '', ref: p.ref ?? '', source: p.source ?? '', status: gitlabRunStatus(p.status), createdAt: p.created_at ?? '', duration: typeof p.duration === 'number' ? Math.max(0, p.duration) : null, url: p.web_url ?? null, stages: glStages(jobs) })
const ghJob = (job: GhJob | GhCheckRun): PrJob => ({ id: String(job.id ?? ''), name: job.name ?? '', status: githubRunStatus(job.status, job.conclusion), duration: job.status === 'completed' ? seconds(job.started_at, job.completed_at) : null, startedAt: job.started_at ?? null, url: job.html_url ?? null })
/** A GitHub workflow run as a pipeline with one stage named after the workflow. */
export function ghRunPipeline(run: GhRun, jobs: GhJob[]): PrPipeline {
  const status = githubRunStatus(run.status, run.conclusion)
  return {
    id: String(run.id), sha: run.head_sha ?? '', ref: run.head_branch ?? '', source: run.event ?? '', status, createdAt: run.created_at ?? '',
    duration: run.status === 'completed' ? seconds(run.run_started_at ?? run.created_at, run.updated_at) : null, url: run.html_url ?? null,
    stages: [{ name: run.name ?? '', jobs: jobs.map(ghJob) }]
  }
}
/** The overall status of a set of jobs (check runs without Actions). */
function overall(statuses: RunStatus[]): RunStatus {
  for (const status of ['failed', 'running', 'pending', 'manual'] as const) if (statuses.includes(status)) return status
  if (statuses.length && statuses.every((s) => s === 'canceled')) return 'canceled'
  if (statuses.length && statuses.every((s) => s === 'skipped')) return 'skipped'
  return 'success'
}

/** The latest pipelines (newest first, at most 10). GitLab: stages and jobs of the 5 newest. GitHub: the workflow runs of the head commit, or its check runs when there are no runs. */
export async function pipelines(rc: RepoCall, number: number): Promise<{ pipelines: PrPipeline[]; canAct: boolean }> {
  if (rc.provider === 'gitlab') {
    const list = (await rc.call<GlPipelineRef[]>('GET', `merge_requests/${number}/pipelines?per_page=10`)).sort((a, b) => b.id - a.id).slice(0, 10)
    return {
      canAct: true,
      pipelines: await Promise.all(list.map(async (ref, index) => {
        if (index >= 5) return glPipelineOf(ref, [])
        const [full, jobs] = await Promise.all([
          empty(rc.call<GlPipelineRef>('GET', `pipelines/${ref.id}`), ref),
          empty(rc.call<GlJob[]>('GET', `pipelines/${ref.id}/jobs?per_page=100&include_retried=false`), [])
        ])
        return glPipelineOf({ ...ref, ...full }, jobs)
      }))
    }
  }
  const pr = await rc.call<GhPull>('GET', `pulls/${number}`)
  const runs = (await empty(rc.call<{ workflow_runs?: GhRun[] }>('GET', `actions/runs?head_sha=${pr.head.sha}&per_page=10`), { workflow_runs: [] })).workflow_runs ?? []
  if (runs.length) {
    return {
      canAct: true,
      pipelines: await Promise.all(runs.slice(0, 10).map(async (run) => ghRunPipeline(run, (await empty(rc.call<{ jobs?: GhJob[] }>('GET', `actions/runs/${run.id}/jobs?per_page=100`), { jobs: [] })).jobs ?? [])))
    }
  }
  const checkRuns = (await empty(rc.call<{ check_runs?: GhCheckRun[] }>('GET', `commits/${pr.head.sha}/check-runs?per_page=100`), { check_runs: [] })).check_runs ?? []
  if (!checkRuns.length) return { pipelines: [], canAct: true }
  const jobs = checkRuns.map(ghJob)
  const starts = checkRuns.map((run) => run.started_at).filter((at): at is string => Boolean(at)).sort()
  return {
    canAct: false,
    pipelines: [{ id: String(checkRuns[0]?.check_suite?.id ?? 0), sha: pr.head.sha, ref: pr.head.ref, source: 'checks', status: overall(jobs.map((job) => job.status)), createdAt: starts[0] ?? '', duration: null, url: null, stages: [{ name: 'Checks', jobs }] }]
  }
}

/** Job log ready to read: no ANSI colors nor GitLab section markers, `\n` line ends, only the last 200 KB. */
export function cleanLog(raw: string, max: number = MAX_LOG): { text: string; truncated: boolean } {
  let text = raw
    // eslint-disable-next-line no-control-regex
    .replace(/section_(?:start|end):\d+:[^\r\n]*?\r\x1b\[0K/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
  const truncated = text.length > max
  if (truncated) { text = text.slice(-max); const newline = text.indexOf('\n'); if (newline >= 0) text = text.slice(newline + 1) }
  return { text, truncated }
}

export async function jobLog(rc: RepoCall, jobId: string): Promise<{ text: string; truncated: boolean }> {
  const id = numId(jobId)
  try {
    const raw = await rc.call<string | undefined>('GET', rc.provider === 'gitlab' ? `jobs/${id}/trace` : `actions/jobs/${id}/logs`, undefined, { text: true })
    return cleanLog(typeof raw === 'string' ? raw : '')
  } catch (error) {
    // GitHub answers 404 while the job runs: its log only exists once the job ends.
    if (rc.provider !== 'github') throw error
    const job = await empty(rc.call<{ status?: string }>('GET', `actions/jobs/${id}`), {} as { status?: string })
    if (job.status && job.status !== 'completed') return { text: tm().pullRequests.githubLogPending, truncated: false }
    throw error
  }
}

export async function pipelineAction(rc: RepoCall, pipelineId: string, action: 'cancel' | 'retry'): Promise<void> {
  const id = numId(pipelineId)
  if (rc.provider === 'gitlab') await rc.call('POST', `pipelines/${id}/${action}`, {})
  else await rc.call('POST', `actions/runs/${id}/${action === 'cancel' ? 'cancel' : 'rerun'}`, {})
}

export async function jobAction(rc: RepoCall, jobId: string, action: 'cancel' | 'retry'): Promise<void> {
  const id = numId(jobId)
  if (rc.provider === 'gitlab') { await rc.call('POST', `jobs/${id}/${action}`, {}); return }
  if (action === 'cancel') throw new Error(tm().pullRequests.githubNoJobCancel)
  await rc.call('POST', `actions/jobs/${id}/rerun`, {})
}

/** MR versions (each push), newest first. GitHub has no such thing: empty. */
export async function versions(rc: RepoCall, number: number): Promise<PrVersion[]> {
  if (rc.provider === 'github') return []
  const raw = await rc.call<Array<{ id: number; head_commit_sha: string; base_commit_sha?: string | null; start_commit_sha?: string | null; created_at: string }>>('GET', `merge_requests/${number}/versions?per_page=100`)
  return [...raw].sort((a, b) => b.id - a.id).slice(0, 100).map((v) => ({ id: String(v.id), headSha: v.head_commit_sha, baseSha: v.base_commit_sha ?? null, startSha: v.start_commit_sha ?? null, createdAt: v.created_at }))
}

export async function versionDiff(rc: RepoCall, number: number, versionId: string): Promise<{ diff: string; files: PrFile[]; headSha: string | null; baseSha: string | null; startSha: string | null }> {
  if (rc.provider === 'github') throw new Error(tm().pullRequests.githubNoVersions)
  const v = await rc.call<{ head_commit_sha?: string | null; base_commit_sha?: string | null; start_commit_sha?: string | null; diffs?: GlChange[] }>('GET', `merge_requests/${number}/versions/${numId(versionId)}`)
  return { ...glDiffParts(v.diffs ?? []), headSha: v.head_commit_sha ?? null, baseSha: v.base_commit_sha ?? null, startSha: v.start_commit_sha ?? null }
}

export async function unapprove(rc: RepoCall, number: number): Promise<void> {
  if (rc.provider === 'github') throw new Error(tm().pullRequests.githubNoUnapprove)
  await rc.call('POST', `merge_requests/${number}/unapprove`, {})
}

export async function resolve(rc: RepoCall, number: number, threadId: string, resolved: boolean): Promise<void> {
  if (rc.provider === 'github') throw new Error(tm().pullRequests.githubNoResolve)
  await rc.call('PUT', `merge_requests/${number}/discussions/${safeId(threadId)}`, { resolved })
}

/** What the "new PR/MR" form can offer. Each list that fails becomes empty. */
export async function createOptions(rc: RepoCall): Promise<PrCreateOptions> {
  if (rc.provider === 'gitlab') {
    const [members, milestones, labels] = await Promise.all([
      empty(rc.call<GlUser[]>('GET', 'members/all?per_page=100'), []),
      empty(rc.call<Array<{ id: number; title: string; due_date?: string | null }>>('GET', 'milestones?state=active&per_page=100'), []),
      empty(rc.call<GhLabel[]>('GET', 'labels?per_page=100'), [])
    ])
    return {
      viewer: rc.viewer,
      members: members.filter((m) => m.username && (!m.state || m.state === 'active')).map(glPerson),
      milestones: milestones.map((m) => ({ id: String(m.id), title: m.title, due: m.due_date ?? null })),
      labels: labels.filter((l) => l.name).map((l) => ({ name: l.name!, color: hexColor(l.color) })),
      supports: { assignees: true, reviewers: true, milestone: true, labels: true, deleteSource: true, squash: true, uploads: Boolean(rc.upload) }
    }
  }
  const [members, milestones, labels] = await Promise.all([
    empty(rc.call<GhUser[]>('GET', 'assignees?per_page=100'), []),
    empty(rc.call<Array<{ number: number; title: string; due_on?: string | null }>>('GET', 'milestones?state=open&per_page=100'), []),
    empty(rc.call<GhLabel[]>('GET', 'labels?per_page=100'), [])
  ])
  return {
    viewer: rc.viewer,
    members: members.filter((m) => m.login).map(ghPerson),
    milestones: milestones.map((m) => ({ id: String(m.number), title: m.title, due: m.due_on ?? null })),
    labels: labels.filter((l) => l.name).map((l) => ({ name: l.name!, color: hexColor(l.color) })),
    supports: { assignees: true, reviewers: true, milestone: true, labels: true, deleteSource: false, squash: false, uploads: false }
  }
}

export interface CreateInput { head: string; base: string; title: string; body: string; draft: boolean; squash?: boolean; assignees?: string[]; reviewers?: string[]; milestone?: string | null; labels?: string[]; deleteSourceBranch?: boolean }

/** Opens the PR/MR with its metadata. GitLab takes everything in one call; GitHub needs follow-up calls, and a failed one becomes a warning (the PR exists). */
export async function create(rc: RepoCall, input: CreateInput): Promise<{ url: string; number: number | null; warning: string | null }> {
  const p = tm().pullRequests, problems: string[] = []
  const milestone = input.milestone && /^\d{1,20}$/.test(input.milestone) ? Number(input.milestone) : null
  if (rc.provider === 'gitlab') {
    const body: Record<string, unknown> = { source_branch: input.head, target_branch: input.base, title: input.draft && !/^draft:/i.test(input.title) ? `Draft: ${input.title}` : input.title, description: input.body }
    if (input.squash !== undefined) body.squash = input.squash
    if (input.deleteSourceBranch !== undefined) body.remove_source_branch = input.deleteSourceBranch
    const people = [...(input.assignees ?? []), ...(input.reviewers ?? [])]
    if (people.length) {
      try {
        const ids = new Map((await pages<GlUser>(rc, 'members/all', 3)).filter((m) => m.username && m.id !== undefined).map((m) => [m.username!, m.id!]))
        const resolveIds = (names: string[] | undefined): number[] => (names ?? []).map((name) => ids.get(name)).filter((id): id is number => id !== undefined)
        const unknown = people.filter((name) => !ids.has(name))
        if (unknown.length) problems.push(p.membersNotFound([...new Set(unknown)].join(', ')))
        const assignees = resolveIds(input.assignees), reviewers = resolveIds(input.reviewers)
        if (assignees.length) body.assignee_ids = assignees
        if (reviewers.length) body.reviewer_ids = reviewers
      } catch (error) { problems.push(p.membersNotRead(errorText(error))) }
    }
    if (milestone !== null) body.milestone_id = milestone
    if (input.labels?.length) body.labels = input.labels.join(',')
    const mr = await rc.call<{ web_url: string; iid?: number }>('POST', 'merge_requests', body)
    return { url: mr.web_url, number: mr.iid ?? null, warning: problems.length ? p.createdWithWarning(problems.join(' · ')) : null }
  }
  const pr = await rc.call<{ html_url: string; number: number }>('POST', 'pulls', { title: input.title, head: input.head, base: input.base, body: input.body, draft: input.draft })
  const step = async (run: () => Promise<unknown>): Promise<void> => { try { await run() } catch (error) { problems.push(errorText(error)) } }
  if (input.assignees?.length) await step(() => rc.call('POST', `issues/${pr.number}/assignees`, { assignees: input.assignees }))
  if (input.labels?.length) await step(() => rc.call('POST', `issues/${pr.number}/labels`, { labels: input.labels }))
  if (milestone !== null) await step(() => rc.call('PATCH', `issues/${pr.number}`, { milestone }))
  const reviewers = (input.reviewers ?? []).filter((login) => login !== rc.viewer)
  if (reviewers.length) await step(() => rc.call('POST', `pulls/${pr.number}/requested_reviewers`, { reviewers }))
  return { url: pr.html_url, number: pr.number ?? null, warning: problems.length ? p.createdWithWarning(problems.join(' · ')) : null }
}

/** What can change on an open PR/MR. Only the fields given are sent; `state` closes or reopens it. */
export interface UpdateInput { title?: string; body?: string; base?: string; draft?: boolean; assignees?: string[]; reviewers?: string[]; milestone?: string | null; labels?: string[]; squash?: boolean; deleteSourceBranch?: boolean; state?: 'close' | 'reopen' }
const DRAFT_PREFIX = /^\s*(\[draft\]|\(draft\)|draft:|wip:|\[wip\])\s*/i
const stripDraft = (title: string): string => title.replace(DRAFT_PREFIX, '')
const isDraftTitle = (title: string): boolean => DRAFT_PREFIX.test(title)

/**
 * Edits the PR/MR (the "Editar" screen, "Marcar como rascunho" and "Fechar" of the ⋮ menu). GitLab takes everything in one PATCH
 * (draft is the "Draft: " title prefix). GitHub splits it: the pull (title, body, base, state), the issue (assignees, labels, milestone)
 * and the requested reviewers; a failed follow-up becomes a warning, and draft cannot be changed through its REST API.
 */
export async function update(rc: RepoCall, number: number, input: UpdateInput): Promise<{ warning: string | null }> {
  const p = tm().pullRequests, problems: string[] = []
  const milestone = input.milestone === undefined ? undefined : input.milestone && /^\d{1,20}$/.test(input.milestone) ? Number(input.milestone) : null
  if (rc.provider === 'gitlab') {
    const body: Record<string, unknown> = {}
    if (input.title !== undefined || input.draft !== undefined) {
      // The title carries the draft: what is not given (the other half) comes from the MR as it is now.
      const current = input.title === undefined || input.draft === undefined ? (await rc.call<{ title: string }>('GET', `merge_requests/${number}`)).title : ''
      const title = input.title ?? current, draft = input.draft ?? isDraftTitle(current)
      body.title = draft ? `Draft: ${stripDraft(title)}` : stripDraft(title)
    }
    if (input.body !== undefined) body.description = input.body
    if (input.base !== undefined) body.target_branch = input.base
    if (input.squash !== undefined) body.squash = input.squash
    if (input.deleteSourceBranch !== undefined) body.remove_source_branch = input.deleteSourceBranch
    if (input.state) body.state_event = input.state
    if (input.assignees !== undefined || input.reviewers !== undefined) {
      try {
        const people = [...(input.assignees ?? []), ...(input.reviewers ?? [])]
        const ids = people.length ? new Map((await pages<GlUser>(rc, 'members/all', 3)).filter((m) => m.username && m.id !== undefined).map((m) => [m.username!, m.id!])) : new Map<string, number>()
        const unknown = people.filter((name) => !ids.has(name))
        if (unknown.length) problems.push(p.membersNotFound([...new Set(unknown)].join(', ')))
        const resolveIds = (names: string[]): number[] => names.map((name) => ids.get(name)).filter((id): id is number => id !== undefined)
        // An empty list clears them (GitLab: 0 unassigns everyone).
        if (input.assignees !== undefined) body.assignee_ids = input.assignees.length ? resolveIds(input.assignees) : [0]
        if (input.reviewers !== undefined) body.reviewer_ids = input.reviewers.length ? resolveIds(input.reviewers) : [0]
      } catch (error) { problems.push(p.membersNotRead(errorText(error))) }
    }
    if (milestone !== undefined) body.milestone_id = milestone ?? 0
    if (input.labels !== undefined) body.labels = input.labels.join(',')
    await rc.call('PUT', `merge_requests/${number}`, body)
    return { warning: problems.length ? p.updatedWithWarning(problems.join(' · ')) : null }
  }
  if (input.draft !== undefined) throw new Error(p.githubNoDraftChange)
  const pull: Record<string, unknown> = {}
  if (input.title !== undefined) pull.title = input.title
  if (input.body !== undefined) pull.body = input.body
  if (input.base !== undefined) pull.base = input.base
  if (input.state) pull.state = input.state === 'close' ? 'closed' : 'open'
  if (Object.keys(pull).length) await rc.call('PATCH', `pulls/${number}`, pull)
  const step = async (run: () => Promise<unknown>): Promise<void> => { try { await run() } catch (error) { problems.push(errorText(error)) } }
  const issue: Record<string, unknown> = {}
  if (input.assignees !== undefined) issue.assignees = input.assignees
  if (input.labels !== undefined) issue.labels = input.labels
  if (milestone !== undefined) issue.milestone = milestone
  if (Object.keys(issue).length) await step(() => rc.call('PATCH', `issues/${number}`, issue))
  if (input.reviewers !== undefined) {
    const wanted = input.reviewers.filter((login) => login !== rc.viewer)
    await step(async () => {
      const current = ((await rc.call<{ requested_reviewers?: GhUser[] }>('GET', `pulls/${number}`)).requested_reviewers ?? []).map((user) => user.login ?? '').filter(Boolean)
      const added = wanted.filter((login) => !current.includes(login)), removed = current.filter((login) => !wanted.includes(login))
      if (added.length) await rc.call('POST', `pulls/${number}/requested_reviewers`, { reviewers: added })
      if (removed.length) await rc.call('DELETE', `pulls/${number}/requested_reviewers`, { reviewers: removed })
    })
  }
  return { warning: problems.length ? p.updatedWithWarning(problems.join(' · ')) : null }
}

/** Uploads a file to the GitLab project (token only) and returns the Markdown that shows/links it. */
export async function upload(rc: RepoCall, name: string, dataBase64: string): Promise<{ markdown: string }> {
  if (rc.provider !== 'gitlab' || !rc.upload) throw new Error(tm().pullRequests.uploadsUnsupported)
  if (/[\\/]/.test(name)) throw new Error(tm().pullRequests.invalidId)
  const data = Buffer.from(dataBase64, 'base64')
  if (data.length > MAX_UPLOAD) throw new Error(tm().pullRequests.uploadTooBig(MAX_UPLOAD / 1024 / 1024))
  const result = await rc.upload('uploads', name, new Uint8Array(data)) as { markdown?: string } | undefined
  if (!result?.markdown) throw new Error(tm().pullRequests.uploadNoMarkdown)
  return { markdown: result.markdown }
}

/** `git log --format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%ae` lines → commits (newest first, as git prints them). */
export function parseLog(stdout: string): PrCommit[] {
  return stdout.split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean).map((line) => {
    const [sha = '', shortSha = '', title = '', author = '', at = '', email = ''] = line.split('\x1f')
    return { sha, shortSha, title, author, at, email }
  }).filter((c) => c.sha)
}

/** `git diff --numstat -z -M` + `git diff --name-status -z -M` → files with status and counts (binary `-` counts as 0). */
export function parseDiffFiles(numstat: string, nameStatus: string): PrFile[] {
  const statuses = new Map<string, { status: PrFile['status']; oldPath: string }>()
  const ns = nameStatus.split('\0')
  for (let i = 0; i < ns.length;) {
    const code = ns[i++] ?? ''
    if (!code) continue
    const letter = code[0]
    if (letter === 'R' || letter === 'C') {
      const oldPath = ns[i++] ?? '', path = ns[i++] ?? ''
      statuses.set(path, { status: letter === 'R' ? 'renamed' : 'added', oldPath: letter === 'R' ? oldPath : path })
    } else {
      const path = ns[i++] ?? ''
      statuses.set(path, { status: letter === 'A' ? 'added' : letter === 'D' ? 'removed' : 'modified', oldPath: path })
    }
  }
  const files: PrFile[] = []
  const parts = numstat.split('\0')
  const count = (value: string | undefined): number => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0 }
  for (let i = 0; i < parts.length;) {
    const head = parts[i++] ?? ''
    if (!head) continue
    const [add, del, inline = ''] = head.split('\t')
    let path = inline, oldPath = inline
    if (!inline) { oldPath = parts[i++] ?? ''; path = parts[i++] ?? '' }
    const known = statuses.get(path)
    files.push({ path, oldPath: known?.oldPath ?? oldPath, status: known?.status ?? (oldPath !== path ? 'renamed' : 'modified'), additions: count(add), deletions: count(del) })
  }
  return files
}
