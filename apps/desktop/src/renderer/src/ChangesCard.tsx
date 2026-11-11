import React, { useCallback, useEffect, useRef, useState } from 'react'
import { errorCodeOf, withoutErrorCode, type Review, type TestRun } from '@gearmod/contracts'
import { parseChanges, type FileChange } from './changes'
import { CheckIcon, DiffIcon, ExpandIcon, RefreshIcon } from './icons'
import { ConfirmDialog } from './ConfirmDialog'
import { plainError } from './NoticeDialog'
import { LinkWorktreeDialog } from './LinkWorktreeDialog'
import { useT } from './i18n'

type TestPlan = { repos: Array<{ name: string; label: string; command: string; changed: boolean }>; fallback: string }
/** The commands live in Project settings > Tests (one per repository); the panel only shows them and opens that tab. */
const openTestSettings = (): void => { window.dispatchEvent(new CustomEvent('gearmod:open-project-config', { detail: { tab: 'tests' } })) }

/**
 * Card changes (worktree): +/− of what the agent changed, files and the two steps that unlock Done (test and review).
 * Floats to the left of the chat; the two chips (Automated tests and Review) are the buttons and ask for confirmation.
 */
export function ChangesCard({ cardId, projectId, busy, shared }: { cardId: string; projectId: string; busy: boolean; shared?: string | null }): React.JSX.Element {
  const { board: tb, common } = useT(), t = tb.changesCard
  const [picking, setPicking] = useState(false), [noWorktree, setNoWorktree] = useState(false)
  const [files, setFiles] = useState<FileChange[]>(), [test, setTest] = useState<TestRun | null>(null), [review, setReview] = useState<Review | null>(null)
  const [plan, setPlan] = useState<TestPlan>({ repos: [], fallback: '' })
  const [ask, setAsk] = useState<'' | 'test' | 'review'>(''), [working, setWorking] = useState<'' | 'refresh' | 'test' | 'review'>(''), [error, setError] = useState('')
  const loading = useRef(false)
  // `silent`: automatic refresh; does not show the loading state nor override a read that is still in progress.
  const refresh = useCallback(async (silent = false) => {
    if (loading.current) return
    loading.current = true
    if (!silent) setWorking('refresh')
    try {
      // What would run is re-read too: the commands change in the project settings or through the agent while the card is open.
      void window.gearmod.invoke('tests:plan', { cardId }).then(setPlan).catch(() => undefined)
      const [snapshot, quality] = await Promise.all([window.gearmod.invoke('worktrees:snapshot', { cardId }), window.gearmod.invoke('quality:status', { cardId })])
      setFiles(snapshot.exists ? parseChanges(snapshot) : []); setTest(quality.test); setReview(quality.review); setError(''); setNoWorktree(false)
    } catch (reason) {
      // Card without a worktree (has not executed yet, or the work was done in another card's): not an error, just offers to link.
      if (errorCodeOf(plainError(reason)) === 'no-worktree') { setFiles([]); setNoWorktree(true); setError('') } else setError(withoutErrorCode(plainError(reason)))
    } finally { loading.current = false; if (!silent) setWorking('') }
  }, [cardId])
  // Reloads on open and when the agent finishes a turn (that is when the files change).
  useEffect(() => { if (!busy) void refresh() }, [busy, refresh])
  // Files also change from outside (another chat, you in the editor, the tester): refreshes on its own, silently, every few seconds,
  // when returning to the window and when the card or a tool signals that something changed.
  useEffect(() => {
    const again = (): void => { if (!document.hidden) void refresh(true) }
    const timer = window.setInterval(again, 6000)
    const off = window.gearmod.onRunEvent((event) => { if (['gearmod/card-updated', 'gearmod/run-completed'].includes(event.eventType)) again() })
    window.addEventListener('focus', again)
    return () => { window.clearInterval(timer); off(); window.removeEventListener('focus', again) }
  }, [refresh])

  const runTest = async (): Promise<void> => {
    setWorking('test'); setError('')
    try { setTest(await window.gearmod.invoke('tests:run-card', { cardId })) } catch (reason) { setError(plainError(reason)) } finally { setWorking('') }
  }
  const approve = async (): Promise<void> => {
    setWorking('review'); setError('')
    try {
      const prepared = review ?? await window.gearmod.invoke('reviews:prepare-local', { cardId })
      setReview(prepared.state === 'open' ? await window.gearmod.invoke('reviews:approve-local', { reviewId: prepared.id }) : prepared)
    } catch (reason) { setError(plainError(reason)) } finally { setWorking('') }
  }

  /** Opens the enlarged view in the main area, with only the changed files (in place of the chat). */
  const showAll = (): void => { if (files?.length) window.dispatchEvent(new CustomEvent('gearmod:open-changes', { detail: { projectId, cardId, files } })) }
  const added = files?.reduce((sum, item) => sum + item.added, 0) ?? 0, removed = files?.reduce((sum, item) => sum + item.removed, 0) ?? 0
  // Running here, or started earlier (another window, before the card was reopened): the last run is still `running`.
  const testing = working === 'test' || test?.status === 'running'
  const passed = test?.status === 'passed', approved = review?.state === 'approved' || review?.state === 'merged'
  const configured = plan.repos.length > 0 || Boolean(plan.fallback), toRun = plan.repos.filter((repo) => repo.changed)
  const chipText = !configured ? t.configureTests : plan.repos.length ? `⌘ ${toRun.length ? toRun.map((repo) => repo.label).join(' · ') : t.noRepoChanged}` : `⌘ ${plan.fallback}`
  const chipTip = !configured ? t.configureTestsTip : [...plan.repos.map((repo) => t.repoLine(repo.label, repo.command, repo.changed)), plan.fallback, t.editInSettings].filter(Boolean).join('\n')
  const runText = plan.repos.length ? (toRun.length ? t.runReposText(toRun.map((repo) => `${repo.label}: ${repo.command}`)) : t.runNothingText) : t.runTestsText(plan.fallback)
  const repoResults = test?.repos?.filter((repo) => repo.label) ?? []
  return <aside className="changes" aria-label={t.cardChanges}>
    <div className="ch-head">
      <span className="ch-title">{t.title}</span>
      <button type="button" className="ch-icon tip" data-tip={t.viewWide} aria-label={t.viewWide} disabled={!files?.length} onClick={showAll}><ExpandIcon /></button>
      <button type="button" className="ch-icon tip" data-tip={common.refresh} aria-label={t.refreshChanges} disabled={Boolean(working)} onClick={() => void refresh()}>{working === 'refresh' ? <span className="spin sm" /> : <RefreshIcon />}</button>
    </div>
    <button type="button" className="ch-row ch-rowbtn" disabled={!files?.length} data-tip={t.viewFiles} aria-label={t.viewFiles} onClick={showAll}>
      <DiffIcon />
      {files === undefined ? <span className="ch-muted">{common.loading}</span>
        : files.length ? <><span className="ch-add">+{added}</span><span className="ch-del">−{removed}</span><span className="ch-muted">{t.fileCount(files.length)}</span></>
          : <span className="ch-muted">{t.noChangesYet}</span>}
    </button>
    {shared && <p className="ch-muted ch-shared">{t.usingWorktreeOf(shared)} · <button type="button" className="linklike" onClick={() => void window.gearmod.invoke('worktrees:link', { cardId, fromCardId: null }).then(() => { window.dispatchEvent(new Event('gearmod:board-changed')); void refresh() })}>{t.unlink}</button></p>}
    {!shared && noWorktree && <button type="button" className="mini secondary ch-link" onClick={() => setPicking(true)}>{t.useOtherWorktree}</button>}
    {picking && <LinkWorktreeDialog cardId={cardId} close={() => setPicking(false)} linked={() => { setPicking(false); void refresh() }} />}
    <div className="ch-steps">
      <button type="button" className={`ch-step ${passed ? 'ok' : test?.status === 'failed' ? 'bad' : ''}`} data-tip={t.autoTestsTip} disabled={Boolean(working) || busy || testing} onClick={() => configured ? setAsk('test') : openTestSettings()}>{testing ? <span className="spin sm" /> : passed ? '✓' : test?.status === 'failed' ? '✕' : '○'} {testing ? t.autoTestsRunning : test?.status === 'failed' ? t.autoTestsFailed : passed ? t.autoTestsPassed : t.autoTests}</button>
      <button type="button" className={`ch-step ${approved ? 'ok' : ''}`} data-tip={t.reviewTip} disabled={Boolean(working) || busy || !passed || approved} onClick={() => setAsk('review')}>{working === 'review' ? <span className="spin sm" /> : approved ? '✓' : '○'} {approved ? t.reviewApproved : t.review}</button>
      <button type="button" className={`ch-step ch-command ${configured ? '' : 'bad'}`} data-tip={chipTip} aria-label={chipTip} onClick={openTestSettings}><span className="ch-command-text">{chipText}</span></button>
      {passed && approved && <span className="ch-ready"><CheckIcon />{t.readyForDone}</span>}
    </div>
    {repoResults.length > 0 && <div className="ch-repos" aria-label={t.repoResults}>{repoResults.map((repo) => <span key={repo.name} className={`ch-repo ${repo.status}`} data-tip={repo.status === 'skipped' ? t.repoSkipped : repo.command}>{repo.status === 'running' ? <span className="spin sm" /> : repo.status === 'passed' ? '✓' : repo.status === 'failed' ? '✕' : '–'} {repo.label}</span>)}</div>}
    {error && <p className="ch-error">{error}</p>}
    {ask === 'test' && <ConfirmDialog eyebrow={t.autoTests} title={test?.status === 'failed' ? t.runAgainTitle : t.runTestsTitle} text={runText} ok={t.runTests} secondary={{ label: t.editInSettings, run: () => { setAsk(''); openTestSettings() } }} cancel={() => setAsk('')} confirm={() => { setAsk(''); void runTest() }} />}
    {ask === 'review' && <ConfirmDialog eyebrow={t.reviewEyebrow} title={t.approveTitle} text={t.approveText(files?.length ?? 0, added, removed)} ok={t.approve} cancel={() => setAsk('')} confirm={() => { setAsk(''); void approve() }} />}
  </aside>
}
