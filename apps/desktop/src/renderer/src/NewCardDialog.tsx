import React, { useEffect, useState } from 'react'
import type { Project } from '@gearmod/contracts'
import { HandIcon, SparkIcon } from './icons'
import { Select } from './Select'
import { useEscape } from './useEscape'
import { useT } from './i18n'

/** What the user chose on the new-card dialog about where the work runs: a branch to start from, or a worktree to use instead of a new one. */
export interface StartChoice { baseBranch?: string; worktree?: { kind: 'card'; cardId: string } | { kind: 'external'; path: string } }

const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** New card: plan with an agent or create by hand, and, below, a new worktree (from a base branch) or one that already exists. */
export function NewCardDialog({ project, close, plan, manual }: { project: Project; close(): void; plan(choice: StartChoice): void; manual(choice: StartChoice): void }): React.JSX.Element {
  const { board: t, common } = useT(), tn = t.newCardDialog, ts = t.start
  const source = project.sources.find((item) => item.isGitRepository)
  const [options, setOptions] = useState<{ cards: Array<{ cardId: string; title: string; branch: string; path: string }>; external: Array<{ path: string; repoName: string; branch: string | null }> }>({ cards: [], external: [] })
  const [from, setFrom] = useState('new'), [branches, setBranches] = useState<string[]>([]), [branch, setBranch] = useState(source?.currentBranch ?? '')
  useEscape(close)
  useEffect(() => { void window.gearmod.invoke('worktrees:options', { projectId: project.id }).then(setOptions).catch(() => undefined) }, [project.id])
  useEffect(() => {
    if (!source) return
    void window.gearmod.invoke('projects:branches', { localPath: source.localPath }).then((list) => { setBranches(list); setBranch((current) => current || source.currentBranch || list[0] || '') }).catch(() => undefined)
  }, [source])
  // A worktree on a detached HEAD cannot be adopted (it has no branch to work on).
  const external = options.external.filter((item) => item.branch)
  const choice = (): StartChoice => {
    if (from.startsWith('card:')) return { worktree: { kind: 'card', cardId: from.slice(5) } }
    if (from.startsWith('ext:')) return { worktree: { kind: 'external', path: from.slice(4) } }
    // Only a different branch is a choice: without one, each repository starts from its current branch, as before.
    return branch && branch !== (source?.currentBranch ?? '') ? { baseBranch: branch } : {}
  }
  const hasAlternatives = options.cards.length + external.length > 0
  const hint = from === 'new' ? tn.hintNew : from.startsWith('card:') ? tn.hintCard : tn.hintExternal
  return <div className="overlay" role="dialog" aria-label={t.newCard} onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}><div className="modal" style={{ width: 'min(520px,100%)' }}><header><div><div className="eyebrow">{t.newCard}</div><h2>{tn.title}</h2></div><button className="x" onClick={close} aria-label={common.close}>×</button></header>
    <div className="choices"><button type="button" className="choice" onClick={() => plan(choice())}><span className="cico plan"><SparkIcon /></span><b>{tn.planWithAgent}</b><small>{tn.planWithAgentHint}</small></button>
    <button type="button" className="choice" onClick={() => manual(choice())}><span className="cico"><HandIcon /></span><b>{tn.createManually}</b><small>{tn.createManuallyHint}</small></button></div>
    {(hasAlternatives || branches.length > 1) && <div className="stack newcard-where">
      <div className="sectitle">{tn.whereTitle}</div>
      {hasAlternatives && <div className="f"><span>Worktree</span><Select label="Worktree" up options={[
        { value: 'new', label: ts.createNew, sub: ts.isolated },
        ...options.cards.map((item) => ({ value: `card:${item.cardId}`, label: ts.useOneOf(item.title), sub: item.branch })),
        ...external.map((item) => ({ value: `ext:${item.path}`, label: tn.useExisting(item.branch ?? ''), sub: folderName(item.path) }))
      ]} value={from} onChange={setFrom} /></div>}
      {from === 'new' && branches.length > 1 && <div className="f"><span>{ts.baseBranch}</span><Select label={ts.baseBranch} up options={branches.map((name) => ({ value: name, label: name, sub: name === source?.currentBranch ? ts.current : '' }))} value={branch} onChange={setBranch} /></div>}
      <small className="hint">{hint}</small>
    </div>}
  </div></div>
}
