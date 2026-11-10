import React, { useCallback, useEffect, useState } from 'react'
import type { AgentConfig, AgentProfile, Project, RepoTestCommand } from '@gearmod/contracts'
import { AgentPickDialog } from './AgentPickDialog'
import { Switch } from './Switch'
import { plainError } from './NoticeDialog'
import { useT } from './i18n'
import { SparkIcon } from './icons'

type Draft = { command: string; name: string }

/**
 * Project settings > Tests: one automated-test command per repository (or "no tests"), and the button that opens the
 * project's automated-tests chat, where the agent sets them all up with the gearmod-test-command skill.
 */
export function TestSettings({ project, profiles, openChat }: { project: Project; profiles: AgentProfile[]; openChat(prompt: string, config: AgentConfig): void }): React.JSX.Element {
  const all = useT(), t = all.settings.projectTests
  const [repos, setRepos] = useState<RepoTestCommand[]>(), [drafts, setDrafts] = useState<Record<string, Draft>>({}), [error, setError] = useState(''), [saving, setSaving] = useState(''), [picking, setPicking] = useState(false)
  const apply = (list: RepoTestCommand[]): void => { setRepos(list); setDrafts(Object.fromEntries(list.map((repo) => [repo.sourceId, { command: repo.command, name: repo.name }]))) }
  const load = useCallback(() => { void window.gearmod.invoke('tests:repo-commands', { projectId: project.id }).then(apply, (reason: unknown) => setError(plainError(reason))) }, [project.id])
  useEffect(load, [load])
  const save = async (repo: RepoTestCommand, change: Partial<Draft & { applicable: boolean }>): Promise<void> => {
    const draft = drafts[repo.sourceId] ?? { command: repo.command, name: repo.name }
    const next = { command: change.command ?? draft.command, name: change.name ?? draft.name, applicable: change.applicable ?? repo.applicable }
    if (next.command.trim() === repo.command && next.name.trim() === repo.name && next.applicable === repo.applicable) return
    setSaving(repo.sourceId); setError('')
    try { apply(await window.gearmod.invoke('tests:set-repo-command', { projectId: project.id, sourceId: repo.sourceId, ...next })) } catch (reason) { setError(plainError(reason)) } finally { setSaving('') }
  }
  const edit = (sourceId: string, change: Partial<Draft>): void => setDrafts((current) => ({ ...current, [sourceId]: { ...(current[sourceId] ?? { command: '', name: '' }), ...change } }))
  const configured = repos?.filter((repo) => repo.applicable && repo.command.trim()).length ?? 0
  return <div className="stack">
    <section className="cx-wfcard tset-head">
      <span className="sectitle">{t.title}</span>
      <p className="hint">{t.intro}</p>
      <div className="tset-actions">
        <button type="button" className="secondary withicon" disabled={!profiles.length} onClick={() => setPicking(true)}><SparkIcon />{configured ? t.review : t.generate}</button>
        <span className="hint">{repos ? t.summary(configured, repos.filter((repo) => !repo.applicable).length, repos.length) : ''}</span>
      </div>
    </section>
    {picking && <AgentPickDialog eyebrow={t.title} title={configured ? t.review : t.generate} profiles={profiles} close={() => setPicking(false)} start={(config) => { setPicking(false); openChat(configured ? t.reviewPrompt : t.generatePrompt, config) }} />}
    {error && <p className="error">{error}</p>}
    <section className="cx-wfcard">
      <span className="sectitle">{t.repositories}</span>
      {!repos ? <p className="hint">{all.common.loading}</p> : !repos.length ? <p className="hint">{t.noRepos}</p>
        : <div className="tset-list">{repos.map((repo) => {
          const draft = drafts[repo.sourceId] ?? { command: repo.command, name: repo.name }
          const state = !repo.applicable ? 'skip' : repo.command.trim() ? 'ok' : 'missing'
          return <div className={`tset-repo ${state}`} key={repo.sourceId}>
            <div className="tset-top">
              <span className="tset-name" title={repo.path}>{repo.repo}</span>
              <span className={`tset-chip ${state}`}>{saving === repo.sourceId ? <span className="spin sm" /> : state === 'ok' ? t.stateOk : state === 'skip' ? t.stateSkip : t.stateMissing}</span>
              <Switch checked={repo.applicable} onChange={(value) => void save(repo, { applicable: value })} tip={t.hasTestsTip}>{t.hasTests}</Switch>
            </div>
            {repo.applicable && <div className="tset-fields">
              <label className="f tset-label">{t.name}<input className="in" value={draft.name} maxLength={60} placeholder={t.namePlaceholder} spellCheck={false} onChange={(event) => edit(repo.sourceId, { name: event.target.value })} onBlur={() => void save(repo, {})} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>
              <label className="f tset-command">{t.command}<input className="in mono" value={draft.command} placeholder={t.commandPlaceholder} spellCheck={false} onChange={(event) => edit(repo.sourceId, { command: event.target.value })} onBlur={() => void save(repo, {})} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>
            </div>}
          </div>
        })}</div>}
      <p className="hint">{t.howItRuns}</p>
    </section>
  </div>
}
