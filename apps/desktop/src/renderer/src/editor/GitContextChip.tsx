import React from 'react'
import { BranchIcon, TreeIcon } from '../icons'
import { useT } from '../i18n'

/** Label with the branch (or worktree) of a file's root. */
export function GitContextChip({ root, title }: { root: { branch?: string | null; worktree?: boolean }; title?: string }): React.JSX.Element {
  const t = useT().git.editor
  const label = root.branch || (root.worktree ? t.worktree : t.mainFolder)
  return <small className={`wf-branchchip ${root.worktree ? 'worktree' : ''}`} data-tip={title ?? `${root.worktree ? t.worktree : t.branch}: ${label}`}>{root.worktree ? <TreeIcon /> : root.branch ? <BranchIcon /> : null}<span>{label}</span></small>
}
