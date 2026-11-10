import React, { useState } from 'react'
import type { GitWorktreeInfo } from '@gearmod/contracts'
import { ConfirmDialog } from './ConfirmDialog'
import { plainError } from './NoticeDialog'
import { useT } from './i18n'
import { toast } from './toasts'

/**
 * After a card goes to Done: asks whether to delete its worktree and branch. When something was not sent
 * (commits outside the base, files without commit), a second dialog warns and offers to delete anyway or look at it in Git.
 */
export function DoneCleanupDialog({ cardId, projectId, title, close, openGit }: { cardId: string; projectId: string; title: string; close(): void; openGit(): void }): React.JSX.Element {
  const t = useT().git.doneCleanup, td = useT().git.worktreeDelete
  const [risk, setRisk] = useState<GitWorktreeInfo>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const remove = async (force: boolean): Promise<void> => {
    setBusy(true); setError('')
    try {
      const out = await window.gearmod.invoke('git:worktree-delete', { projectId, cardId, deleteBranch: true, force })
      if (out.keptBranches.length) toast.warning(td.done, td.keptBranches(out.keptBranches)); else toast.success(td.done, out.output)
      close()
    } catch (reason) { setError(plainError(reason)); setBusy(false) }
  }
  const check = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      const info = await window.gearmod.invoke('git:worktree-info', { projectId, cardId })
      if (info.repos.some((repo) => repo.unpushed > 0 || repo.files > 0)) { setRisk(info); setBusy(false); return }
      await remove(false)
    } catch (reason) { setError(plainError(reason)); setBusy(false) }
  }
  const failure = error ? <p className="error" role="alert">{error}</p> : null
  if (!risk) return <ConfirmDialog eyebrow={t.eyebrow} title={t.title(title)} text={t.text} ok={busy ? td.deleting : t.ok} okDisabled={busy} extra={failure} cancel={close} confirm={() => void check()} />
  const lines = risk.repos.filter((repo) => repo.unpushed > 0 || repo.files > 0)
  const extra = <div>
    <ul className="cleanup-risk">{lines.map((repo) => <li key={repo.name}>{risk.repos.length > 1 && <b>{repo.name}: </b>}{[repo.unpushed > 0 && td.unpushed(repo.unpushed), repo.files > 0 && td.uncommitted(repo.files)].filter(Boolean).join(' · ')}</li>)}</ul>
    {failure}
  </div>
  return <ConfirmDialog eyebrow={t.eyebrow} title={t.riskTitle} text={t.riskText} ok={busy ? td.deleting : t.deleteAnyway} danger okDisabled={busy} extra={extra} secondary={{ label: t.viewInGit, run: () => { close(); openGit() } }} cancel={close} confirm={() => void remove(true)} />
}
