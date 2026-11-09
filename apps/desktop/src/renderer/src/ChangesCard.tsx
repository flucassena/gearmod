import React, { useCallback, useEffect, useRef, useState } from 'react'
import { errorCodeOf, withoutErrorCode, type Review, type TestRun } from '@gearmod/contracts'
import { parseChanges, type FileChange } from './changes'
import { CheckIcon, DiffIcon, ExpandIcon, RefreshIcon } from './icons'
import { ConfirmDialog } from './ConfirmDialog'
import { plainError } from './NoticeDialog'
import { LinkWorktreeDialog } from './LinkWorktreeDialog'
import { useT } from './i18n'

// The command used to live only in this browser's localStorage; it now lives in the app (per project) so the agent can configure it too.
const legacyKey = (projectId: string): string => `gearmod.testCommand.${projectId}`
/** Project test command saved in the app; moves an old localStorage value over the first time. */
export async function loadTestCommand(projectId: string): Promise<string> {
  const { command } = await window.gearmod.invoke('tests:command', { projectId })
  if (command) return command
  let legacy = ''; try { legacy = localStorage.getItem(legacyKey(projectId))?.trim() ?? '' } catch { /* no storage */ }
  if (!legacy) return ''
  const saved = await window.gearmod.invoke('tests:set-command', { projectId, command: legacy })
  try { localStorage.removeItem(legacyKey(projectId)) } catch { /* no storage */ }
  return saved.command
}
const saveTestCommand = (projectId: string, command: string): Promise<string> => window.gearmod.invoke('tests:set-command', { projectId, command }).then((result) => result.command)

/**
 * Card changes (worktree): +/− of what the agent changed, files and the two steps that unlock Done (test and review).
 * Floats to the left of the chat; the two chips (Automated tests and Review) are the buttons and ask for confirmation.
 */
export function ChangesCard({ cardId, projectId, busy, shared }: { cardId: string; projectId: string; busy: boolean; shared?: string | null }): React.JSX.Element {
  const { board: tb, common } = useT(), t = tb.changesCard
  const [picking, setPicking] = useState(false), [noWorktree, setNoWorktree] = useState(false)
  const [files, setFiles] = useState<FileChange[]>(), [test, setTest] = useState<TestRun | null>(null), [review, setReview] = useState<Review | null>(null)
  const [command, setCommand] = useState(''), [draftCommand, setDraftCommand] = useState('')
  const [ask, setAsk] = useState<'' | 'test' | 'review'>(''), [configuring, setConfiguring] = useState<'' | 'save' | 'run'>(''), [working, setWorking] = useState<'' | 'refresh' | 'test' | 'review'>(''), [error, setError] = useState('')
  const [suggested, setSuggested] = useState('')
  const loading = useRef(false)
  // No command saved yet: asks the main process to guess it from the worktree (package.json, manage.py, Cargo.toml...).
  useEffect(() => {
    if (command.trim() || noWorktree) return
    let alive = true
    void window.gearmod.invoke('tests:detect-command', { cardId }).then((result) => { if (alive) setSuggested(result.command) }).catch(() => { /* suggestion only */ })
    return () => { alive = false }
  }, [cardId, command, noWorktree, files === undefined])
  // `silent`: automatic refresh; does not show the loading state nor override a read that is still in progress.
  const refresh = useCallback(async (silent = false) => {
    if (loading.current) return
    loading.current = true
    if (!silent) setWorking('refresh')
    try {
      // The command is re-read too: the agent can change it (gearmod_test_command) while the card is open.
      void loadTestCommand(projectId).then(setCommand).catch(() => undefined)
      const [snapshot, quality] = await Promise.all([window.gearmod.invoke('worktrees:snapshot', { cardId }), window.gearmod.invoke('quality:status', { cardId })])
      setFiles(snapshot.exists ? parseChanges(snapshot) : []); setTest(quality.test); setReview(quality.review); setError(''); setNoWorktree(false)
    } catch (reason) {
      // Card without a worktree (has not executed yet, or the work was done in another card's): not an error, just offers to link.
      if (errorCodeOf(plainError(reason)) === 'no-worktree') { setFiles([]); setNoWorktree(true); setError('') } else setError(withoutErrorCode(plainError(reason)))
    } finally { loading.current = false; if (!silent) setWorking('') }
  }, [cardId, projectId])
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

  const runTest = async (value = command): Promise<void> => {
    const nextCommand = value.trim(), parts = nextCommand.split(/\s+/).filter(Boolean)
    if (!parts.length) { setDraftCommand(suggested); setConfiguring('run'); return }
    setCommand(nextCommand); setDraftCommand(nextCommand)
    setWorking('test'); setError('')
    try { if (nextCommand !== command) await saveTestCommand(projectId, nextCommand) } catch (reason) { setError(plainError(reason)); setWorking(''); return }
    try { setTest(await window.gearmod.invoke('tests:run', { cardId, executable: parts[0]!, args: parts.slice(1) })) } catch (reason) { setError(plainError(reason)) } finally { setWorking('') }
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
  const passed = test?.status === 'passed', approved = review?.state === 'approved' || review?.state === 'merged'
  const configure = (action: 'save' | 'run'): void => { setDraftCommand(command || suggested); setConfiguring(action) }
  const saveConfiguredCommand = (): void => {
    const next = draftCommand.trim(); if (!next) return
    const action = configuring; setConfiguring('')
    if (action === 'run') { void runTest(next); return }
    void saveTestCommand(projectId, next).then(setCommand, (reason: unknown) => setError(plainError(reason)))
  }
  return <aside className="changes" aria-label={t.cardChanges}>
    <div className="ch-head">
      <span className="ch-title">{t.title}</span>
      <button type="button" className="ch-icon tip" data-tip={t.viewWide} aria-label={t.viewWide} disabled={!files?.length} onClick={showAll}><ExpandIcon /></button>
      <button type="button" className="ch-icon tip" data-tip={common.refresh} aria-label={t.refreshChanges} disabled={Boolean(working)} onClick={() => void refresh()}>{working === 'refresh' ? <span className="spin sm" /> : <RefreshIcon />}</button>
    </div>
    <button type="button" className="ch-row ch-rowbtn" disabled={!files?.length} data-tip={t.viewFiles} aria-label={t.viewFiles} onClick={showAll}>
      <DiffIcon />
      {files === undefined ? <span className="ch-muted">{common.loading}</span>
        : files.length ? <><span className="ch-add">+{added}</span><span className="ch-del">−{removed}</span><span className="ch-muted">{t.fileCount(files.length)}</span><span className="chev chev-box" aria-hidden="true"><svg className="chev-svg" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg></span></>
          : <span className="ch-muted">{t.noChangesYet}</span>}
    </button>
    {shared && <p className="ch-muted ch-shared">{t.usingWorktreeOf(shared)} · <button type="button" className="linklike" onClick={() => void window.gearmod.invoke('worktrees:link', { cardId, fromCardId: null }).then(() => { window.dispatchEvent(new Event('gearmod:board-changed')); void refresh() })}>{t.unlink}</button></p>}
    {!shared && noWorktree && <button type="button" className="mini secondary ch-link" onClick={() => setPicking(true)}>{t.useOtherWorktree}</button>}
    {picking && <LinkWorktreeDialog cardId={cardId} close={() => setPicking(false)} linked={() => { setPicking(false); void refresh() }} />}
    <div className="ch-steps">
      <button type="button" className={`ch-step ${passed ? 'ok' : test?.status === 'failed' ? 'bad' : ''}`} data-tip={t.autoTestsTip} disabled={Boolean(working) || busy} onClick={() => command.trim() ? setAsk('test') : configure('run')}>{working === 'test' ? <span className="spin sm" /> : passed ? '✓' : test?.status === 'failed' ? '✕' : '○'} {test?.status === 'failed' ? t.autoTestsFailed : passed ? t.autoTestsPassed : t.autoTests}</button>
      <button type="button" className={`ch-step ${approved ? 'ok' : ''}`} data-tip={t.reviewTip} disabled={Boolean(working) || busy || !passed || approved} onClick={() => setAsk('review')}>{working === 'review' ? <span className="spin sm" /> : approved ? '✓' : '○'} {approved ? t.reviewApproved : t.review}</button>
      <button type="button" className={`ch-step ch-command ${command.trim() ? '' : 'bad'}`} data-tip={command.trim() ? t.currentCommand(command) : suggested ? t.suggestedCommandTip(suggested) : t.defineCommandTip} onClick={() => configure('save')}>{command.trim() ? `⌘ ${command}` : suggested ? t.suggestedCommand(suggested) : t.configureCommand}</button>
      {passed && approved && <span className="ch-ready"><CheckIcon />{t.readyForDone}</span>}
    </div>
    {error && <p className="ch-error">{error}</p>}
    {ask === 'test' && <ConfirmDialog eyebrow={t.autoTests} title={test?.status === 'failed' ? t.runAgainTitle : t.runTestsTitle} text={command.trim() ? t.runTestsText(command.trim()) : t.runTestsNoCommand} ok={t.runTests} cancel={() => setAsk('')} confirm={() => { setAsk(''); void runTest() }} />}
    {ask === 'review' && <ConfirmDialog eyebrow={t.reviewEyebrow} title={t.approveTitle} text={t.approveText(files?.length ?? 0, added, removed)} ok={t.approve} cancel={() => setAsk('')} confirm={() => { setAsk(''); void approve() }} />}
    {configuring && <ConfirmDialog eyebrow={t.autoTests} title={t.commandTitle} text={t.commandText} ok={configuring === 'run' ? t.saveAndRun : t.saveCommand} okDisabled={!draftCommand.trim()} extra={<label className="ch-cmd">{t.command}<input className="in" autoFocus value={draftCommand} placeholder={t.commandPlaceholder} spellCheck={false} onChange={(event) => setDraftCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && draftCommand.trim()) saveConfiguredCommand() }} /></label>} cancel={() => setConfiguring('')} confirm={saveConfiguredCommand} />}
  </aside>
}
