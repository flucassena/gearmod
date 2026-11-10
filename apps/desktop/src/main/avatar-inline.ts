import type { PullRequestDetail, PullRequestList } from '@gearmod/contracts'

/**
 * People's photos as the host gives them (GitLab's own server, GitHub's avatars host) can't load in the window: its CSP lets images
 * come only from the app and Gravatar. So the main process downloads each photo once and hands it over as a `data:` URL; a photo that
 * fails (private, too big, not an image) is dropped and the initials stay.
 */
const MAX_BYTES = 256 * 1024
const MAX_CACHED = 500
const cache = new Map<string, Promise<string>>()

type Fetcher = (url: string, init: { signal: AbortSignal; redirect: 'follow' }) => Promise<Response>
let fetcher: Fetcher = (url, init) => fetch(url, init)
/** For tests. */
export function setAvatarFetcher(next: Fetcher): void { fetcher = next; cache.clear() }

async function download(url: string): Promise<string> {
  if (url.startsWith('data:')) return url
  if (!/^https?:\/\//i.test(url)) return ''
  try {
    const sized = /[?&](s|size|width)=\d+/.test(url) ? url : `${url}${url.includes('?') ? '&' : '?'}${url.includes('gravatar') ? 's' : 'width'}=64`
    const response = await fetcher(sized, { signal: AbortSignal.timeout(6000), redirect: 'follow' })
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (!response.ok || !/^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(type)) return ''
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length === 0 || data.length > MAX_BYTES) return ''
    return `data:${type};base64,${data.toString('base64')}`
  } catch { return '' }
}

export function inlineAvatar(url: string): Promise<string> {
  if (!url) return Promise.resolve('')
  let found = cache.get(url)
  if (!found) {
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!)
    found = download(url)
    cache.set(url, found)
    // A failure is not kept for good: the next look tries again.
    void found.then((value) => { if (!value) setTimeout(() => cache.delete(url), 60_000) })
  }
  return found
}

/**
 * The detail's login → photo map with the photos inlined. People whose e-mail is known get their photo from Gravatar in the window,
 * so theirs is not downloaded; the ones that failed are left out.
 */
export async function inlineDetailAvatars(detail: PullRequestDetail): Promise<PullRequestDetail> {
  const entries = await Promise.all(Object.entries(detail.avatars).filter(([login]) => !detail.emails[login]).map(async ([login, url]) => [login, await inlineAvatar(url)] as const))
  return { ...detail, avatars: Object.fromEntries(entries.filter(([, url]) => url)) }
}

/** The list rows' assignee photos inlined (Gravatar covers the ones with an e-mail). */
export async function inlineListAvatars(list: PullRequestList): Promise<PullRequestList> {
  if (!list.prs.some((pr) => pr.assignees.some((person) => person.avatar && !person.email))) return list
  const prs = await Promise.all(list.prs.map(async (pr) => pr.assignees.length === 0 ? pr
    : { ...pr, assignees: await Promise.all(pr.assignees.map(async (person) => person.email ? { ...person, avatar: '' } : { ...person, avatar: await inlineAvatar(person.avatar) })) }))
  return { ...list, prs }
}
