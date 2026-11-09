import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PullRequestList, PullRequestSummary } from '@gearmod/contracts'
import { tr } from './i18n'

const pollMs = 120_000
const seenKey = (projectId: string): string => `gearmod.prSeen.${projectId}`
const loadSeen = (projectId: string): Record<string, string> | null => { try { const raw = localStorage.getItem(seenKey(projectId)); return raw ? JSON.parse(raw) as Record<string, string> : null } catch { return null } }
const saveSeen = (projectId: string, seen: Record<string, string>): void => { try { localStorage.setItem(seenKey(projectId), JSON.stringify(seen)) } catch { /* only valid for this session */ } }
const keyOf = (sourceId: string, number: number): string => `${sourceId}#${number}`

export interface PullRequestsState {
  lists: Record<string, PullRequestList>
  /** PRs from other people with news (new PR, updated, or with a review requested from you). Opening one does not clear it: the alert stays until the PR is closed or merged. */
  unread(sourceId: string): PullRequestSummary[]
  total: number
  isUnread(sourceId: string, pr: PullRequestSummary): boolean
  refresh(sourceId?: string): Promise<void>
}

/**
 * Lists the open PRs of each repository in the project (via gh) every 2 minutes and when returning to the window, and says which have news.
 * The first time the project is read everything counts as seen (otherwise every old PR would light the dot), except what asks for your review.
 * After that the alert is not cleared by opening the PR: it leaves only when the PR leaves the open list (closed or merged).
 */
export function usePullRequests(projectId: string): PullRequestsState {
  const [lists, setLists] = useState<Record<string, PullRequestList>>({})
  const [seen, setSeen] = useState<Record<string, string>>(() => loadSeen(projectId) ?? {})
  const seenRef = useRef(seen), listsRef = useRef(lists)
  seenRef.current = seen; listsRef.current = lists

  const refresh = useCallback(async (only?: string): Promise<void> => {
    let ids: string[]
    try { ids = only ? [only] : (await window.gearmod.invoke('git:repos', { projectId })).map((repo) => repo.sourceId) } catch { return }
    const results = await Promise.all(ids.map(async (sourceId) => [sourceId, await window.gearmod.invoke('prs:list', { sourceId }).catch((): PullRequestList => ({ supported: true, provider: null, error: tr().git.pr.queryFailed, viewer: null, prs: [] }))] as const))
    const next = { ...listsRef.current }
    for (const [sourceId, list] of results) next[sourceId] = list
    if (!only) for (const stale of Object.keys(next)) if (!ids.includes(stale)) delete next[stale]
    setLists(next)
    if (!loadSeen(projectId)) {
      const baseline: Record<string, string> = {}
      for (const [sourceId, list] of Object.entries(next)) for (const pr of list.prs) if (!pr.reviewRequested) baseline[keyOf(sourceId, pr.number)] = pr.updatedAt
      saveSeen(projectId, baseline); setSeen(baseline)
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, pollMs), onFocus = (): void => { void refresh() }
    window.addEventListener('focus', onFocus); window.addEventListener('gearmod:git-accounts-changed', onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); window.removeEventListener('gearmod:git-accounts-changed', onFocus) }
  }, [refresh])

  const isUnread = useCallback((sourceId: string, pr: PullRequestSummary): boolean => {
    const viewer = listsRef.current[sourceId]?.viewer
    return pr.author !== viewer && seen[keyOf(sourceId, pr.number)] !== pr.updatedAt
  }, [seen])
  const unread = useCallback((sourceId: string): PullRequestSummary[] => (lists[sourceId]?.prs ?? []).filter((pr) => isUnread(sourceId, pr)), [lists, isUnread])
  const total = useMemo(() => Object.keys(lists).reduce((sum, sourceId) => sum + unread(sourceId).length, 0), [lists, unread])
  return { lists, unread, total, isUnread, refresh }
}
