import React, { useState } from 'react'
import type { GitWorktreeInfo } from '@gearmod/contracts'
import { ConfirmDialog } from './ConfirmDialog'
import { plainError } from './NoticeDialog'
import { useT } from './i18n'
import { DeleteProgress, runWorktreeDelete, useWorktreeDeleting } from './WorktreeDelete'

/**
 * After a card goes to Done: asks whether to delete its worktree and branch. When something was not sent
 * (commits outside the base, files without commit), a second dialog warns and offers to delete anyway or look at it in Git.
 */
export function DoneCleanupDialog({ cardId, projectId, title, close, openGit }: { cardId: string; projectId: string; title: string; close(): void; openGit(): void }): React.JSX.Element {
  const t = useT().git.doneCleanup, td = useT().git.worktreeDelete
  const [risk, setRisk] = useState<GitWorktreeInfo>(), [checking, setChecking] = useState(false), [removing, setRemoving] = useState(false), [error, setError] = useState('')
  const deleting = useWorktreeDeleting(cardId) || removing, busy = checking || deleting
  const remove = async (force: boolean): Promise<void> => {
    setRemoving(true); setError('')
    try { await runWorktreeDelete({ projectId, cardId, deleteBranch: true, force, title }); close() } catch (reason) { setError(plainError(reason)); setRemoving(false) }
  }
  const check = async (): Promise<void> => {
    setChecking(true); setError('')
    try {
      const info = await window.gearmod.invoke('git:worktree-info', { projectId, cardId })
      setChecking(false)
      if (info.repos.some((repo) => repo.unpushed > 0 || repo.files > 0)) { setRisk(info); return }
      await remove(false)
    } catch (reason) { setError(plainError(reason)); setChecking(false) }
  }
  const failure = <>{deleting && <DeleteProgress />}{error && <p className="error" role="alert">{error}</p>}</>
  const background = deleting ? { label: td.background, run: close } : undefined
  if (!risk) return <ConfirmDialog eyebrow={t.eyebrow} title={t.title(title)} text={t.text} ok={busy ? td.deleting : t.ok} okDisabled={busy} extra={failure} secondary={background} cancel={close} confirm={() => void check()} />
  const lines = risk.repos.filter((repo) => repo.unpushed > 0 || repo.files > 0)
  const extra = <div>
    <ul className="cleanup-risk">{lines.map((repo) => <li key={repo.name}>{risk.repos.length > 1 && <b>{repo.name}: </b>}{[repo.unpushed > 0 && td.unpushed(repo.unpushed), repo.files > 0 && td.uncommitted(repo.files)].filter(Boolean).join(' · ')}</li>)}</ul>
    {failure}
  </div>
  return <ConfirmDialog eyebrow={t.eyebrow} title={t.riskTitle} text={t.riskText} ok={busy ? td.deleting : t.deleteAnyway} danger okDisabled={busy} extra={extra} secondary={background ?? { label: t.viewInGit, run: () => { close(); openGit() } }} cancel={close} confirm={() => void remove(true)} />
}
