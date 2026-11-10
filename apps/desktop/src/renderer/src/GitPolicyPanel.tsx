import React, { useEffect, useState } from 'react'
import type { GitPolicy, GitRepo, GitRule } from '@gearmod/contracts'
import { Select } from './Select'
import { plainError } from './NoticeDialog'
import { ruleLabel } from './gitView'
import { ConfirmDialog } from './ConfirmDialog'
import { TrashIcon, Chevron } from './icons'
import { GitEmpty, gitChangedEvent } from './GitSetup'
import { toast } from './toasts'
import { cachedGit, refreshGit, rememberGit } from './gitConfigCache'
import { useT } from './i18n'

/** Collapsible section; when closed, shows a summary next to the title. */
function Fold({ title, summary, closed = false, children }: { title: string; summary: string; closed?: boolean; children: React.ReactNode }): React.JSX.Element {
  const [shut, setShut] = useState(closed)
  return <div className="f"><span className="foldh" role="button" tabIndex={0} aria-expanded={!shut} onClick={() => setShut(!shut)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShut(!shut) } }}><Chevron open={!shut} />{title}{shut && <small>{summary}</small>}</span>{!shut && children}</div>
}

/** Configure project Git tab: who commits (project default) and per-branch exceptions. Repositories appear in the Git accounts. Saves on change. */
export function GitPolicyPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const { common, git: { policy: t } } = useT()
  const warm = cachedGit(projectId)
  const [policy, setPolicy] = useState<GitPolicy | undefined>(warm.policy), [repos, setRepos] = useState<GitRepo[]>(warm.repos ?? []), [reposLoaded, setReposLoaded] = useState(Boolean(warm.repos)), [error, setError] = useState(''), [askRemove, setAskRemove] = useState<number | null>(null)
  useEffect(() => {
    // Already has what was loaded when the project was opened: shows it right away and checks again in the background.
    const now = cachedGit(projectId)
    setPolicy(now.policy); setRepos(now.repos ?? []); setReposLoaded(Boolean(now.repos))
    let alive = true
    void refreshGit(projectId).then((changed) => {
      if (changed) window.dispatchEvent(new Event(gitChangedEvent))
      if (!alive) return
      const fresh = cachedGit(projectId)
      // The rule the user is editing is not swapped from under them.
      setPolicy((current) => current ?? fresh.policy); setRepos(fresh.repos ?? []); setReposLoaded(true)
    }).catch((reason: unknown) => { if (alive) { setError(plainError(reason)); setReposLoaded(true) } })
    return () => { alive = false }
  }, [projectId])
  if (!policy || !reposLoaded) return <div className="stack">{error ? <p className="error">{error}</p> : <small className="hint">{common.loading}</small>}</div>
  if (!repos.length) return <GitEmpty projectId={projectId} done={(items) => { rememberGit(projectId, { repos: items }); setRepos(items) }} />
  const save = async (next: GitPolicy): Promise<void> => {
    try { setError(''); setPolicy(next); rememberGit(projectId, { policy: next }); const stored = await window.gearmod.invoke('git:policy-set', { projectId, policy: next }); rememberGit(projectId, { policy: stored }); setPolicy((current) => current && current.rules.length === stored.rules.length ? current : stored); toast.success(t.ruleSaved) } catch (reason) { setError(plainError(reason)) }
  }
  const rules = policy.rules
  // Only saves what really changed: focusing a field and leaving it, or clicking the option already chosen, saves nothing.
  const saveIfChanged = (next: GitPolicy): void => { if (JSON.stringify(next) !== JSON.stringify(cachedGit(projectId).policy)) void save(next) }
  const setRule = (index: number, patch: Partial<GitPolicy['rules'][number]>, persist = true): void => {
    const next = { ...policy, rules: rules.map((item, i) => i === index ? { ...item, ...patch } : item) }
    if (persist) saveIfChanged(next); else setPolicy(next)
  }
  return <div className="stack gpolcfg">
    <Fold title={t.agentCommitTitle} summary={ruleLabel(policy.def)}><div className="stack" style={{ gap: 6 }}><Select label={t.agentCommitTitle} value={policy.def} options={(['ask', 'auto', 'never'] as const).map((value) => ({ value, label: t.defaultNotes[value].title, sub: t.defaultNotes[value].note }))} onChange={(value) => void save({ ...policy, def: value as GitRule })} /><small className="hint">{t.defaultNotes[policy.def].note}</small></div></Fold>
    <Fold title={t.mergeMethodTitle} summary={t.mergeNotes[policy.mergeMethod].title}><div className="stack" style={{ gap: 6 }}><Select label={t.mergeMethodTitle} value={policy.mergeMethod} options={(['merge', 'squash', 'rebase'] as const).map((value) => ({ value, label: t.mergeNotes[value].title, sub: t.mergeNotes[value].note }))} onChange={(value) => void save({ ...policy, mergeMethod: value as GitPolicy['mergeMethod'] })} /><small className="hint">{t.mergeMethodHint}</small></div></Fold>
    <Fold title={t.exceptionsTitle} summary={t.exceptionsCount(rules.length)}><small className="hint">{t.exceptionsHint}</small>
      <div className="stack" style={{ gap: 6 }}>{rules.map((item, index) => <div className="grule" key={index}><input className="in" value={item.pattern} spellCheck={false} placeholder={t.branchNamePlaceholder} aria-label={t.exceptionBranch} onChange={(e) => setRule(index, { pattern: e.target.value }, false)} onBlur={() => saveIfChanged(policy)} onKeyDown={(e) => { if (e.key === 'Enter') saveIfChanged(policy) }} />
        <div className="gseg">{(['auto', 'ask', 'never'] as const).map((value) => <button type="button" key={value} className={item.rule === value ? 'on' : ''} onClick={() => setRule(index, { rule: value })}>{ruleLabel(value)}</button>)}</div>
        <button type="button" className="trashbtn tip" data-tip={t.removeException} aria-label={t.removeException} onClick={() => setAskRemove(index)}><TrashIcon /></button></div>)}</div>
      <button type="button" className="mini secondary" style={{ justifySelf: 'start' }} onClick={() => setPolicy({ ...policy, rules: [...rules, { pattern: '', rule: 'auto' }] })}>{t.addException}</button></Fold>
    {askRemove !== null && rules[askRemove] && <ConfirmDialog eyebrow={t.exceptionEyebrow} title={t.removeExceptionTitle(rules[askRemove]!.pattern || t.unnamedBranch)} text={t.removeExceptionText} ok={common.remove} danger cancel={() => setAskRemove(null)} confirm={() => { const index = askRemove; setAskRemove(null); void save({ ...policy, rules: rules.filter((_, i) => i !== index) }) }} />}
    {error && <p className="error">{error}</p>}
  </div>
}
