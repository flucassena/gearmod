import React, { useCallback, useEffect, useState } from 'react'
import { Chevron } from './icons'
import type { AgentProfile, SkillEntry, SkillScope } from '@gearmod/contracts'
import { ProviderLogo } from './AgentIcon'
import { ConfirmDialog } from './ConfirmDialog'
import { tasks } from './backgroundTasks'
import { plainError } from './NoticeDialog'
import { CatalogLinks } from './McpPanel'
import { Select } from './Select'
import { ImportSkillDialog } from './ImportSkillDialog'
import { useT } from './i18n'

const providerName = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' } as const
const skillCatalogs = [{ key: 'skillsSh', url: 'https://skills.sh' }, { key: 'anthropic', url: 'https://github.com/anthropics/skills' }] as const

/** Global skills (each agent's folder) or project ones (detected in the repository): import and convert to the other agent. */
export function SkillsPanel({ scope, projectId, profiles, globalCount }: { scope: SkillScope; projectId?: string; profiles: AgentProfile[]; globalCount?: number }): React.JSX.Element {
  const t = useT(), ts = t.settings.skills
  const [skills, setSkills] = useState<SkillEntry[]>([]), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [importing, setImporting] = useState(false), [converting, setConverting] = useState<{ name: string; to: 'claude' | 'codex' | 'gemini' }>()
  const [reviewer, setReviewer] = useState(''), [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'one' | 'folder'>('one'), [menu, setMenu] = useState(false), [open, setOpen] = useState<string>(), [deleting, setDeleting] = useState<SkillEntry>(), [notice, setNotice] = useState('')
  const load = useCallback(async () => { try { setSkills(await window.gearmod.invoke('skills:list', { scope, projectId })); setLoaded(true); setError('') } catch (reason) { setError(plainError(reason)) } }, [scope, projectId])
  useEffect(() => { void load() }, [load])
  useEffect(() => window.gearmod.onRunEvent((event) => { if (event.eventType.startsWith('skills/review-')) void load() }), [load])
  const guard = async (action: () => Promise<void>, process?: { title: string; detail: string }): Promise<void> => {
    setBusy(true); setError('')
    try { if (process) await tasks.track(process, action).promise; else await action() } catch (reason) { setError(plainError(reason)) } finally { setBusy(false) }
  }
  const running = skills.find((skill) => skill.providers.claude === 'converting' || skill.providers.codex === 'converting' || skill.providers.gemini === 'converting')
  return <>
    <div className="skhead"><span className="sk-count" data-tip={scope === 'project' ? ts.projectTip : ts.globalTip}>{loaded ? ts.found(skills.length) : error ? ts.cannotLoad : ts.loading}<span> · {scope === 'project' ? ts.scopeProject : ts.scopeGlobal}</span></span>{!importing && <span className="impmenu"><button type="button" className="mini" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>{ts.importMenu}</button>{menu && <div className="modemenu impdrop" role="menu"><button type="button" role="menuitem" className="modeopt" onClick={() => { setMenu(false); setMode('one'); setImporting(true) }}><span className="mo-t"><b>{ts.oneSkill}</b><small>{ts.oneSkillHint}</small></span></button><button type="button" role="menuitem" className="modeopt" onClick={() => { setMenu(false); setMode('folder'); setImporting(true) }}><span className="mo-t"><b>{ts.folderSkills}</b><small>{ts.folderSkillsHint}</small></span></button></div>}</span>}</div>
    <CatalogLinks label={ts.browse} links={skillCatalogs.map((item) => ({ label: ts.catalogs[item.key], url: item.url }))} />
    {importing && <ImportSkillDialog mode={mode} scope={scope} projectId={projectId} close={() => setImporting(false)} imported={(next, note) => { setSkills(next); if (note) setNotice(note) }} />}
    <div className="stack sklist" style={{ gap: 8 }}>{loaded && skills.length === 0 && !importing ? <div className="emptyBox">{scope === 'project' ? ts.emptyProject : ts.emptyGlobal}</div> : skills.map((skill) => {
      const from = skill.providers.claude === 'ready' ? 'claude' : skill.providers.codex === 'ready' ? 'codex' : 'gemini'
      const expanded = open === skill.id
      return <div className={`skill-row compact ${expanded ? 'open' : ''}`} key={skill.id}>
        <div className="skill-top" role="button" tabIndex={0} aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : skill.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(expanded ? undefined : skill.id) } }}>
          <Chevron open={expanded} />
          <div className="skname"><b>{skill.name}</b>{skill.origin && <small className="path">{skill.origin}{skill.detected ? ts.detectedInRepo : ''}</small>}</div>
          <div className="provs" onClick={(e) => e.stopPropagation()}>{(['claude', 'codex', 'gemini'] as const).map((provider) => {
            const state = skill.providers[provider]
            if (state === 'ready') return <span key={provider} className={`ptile on ${provider} tip`} data-tip={providerName[provider]}><ProviderLogo provider={provider} /></span>
            if (state === 'converting') return <span key={provider} className="ptile busy tip" data-tip={ts.convertingTo(providerName[provider])}><span className="spin" /></span>
            if (provider === 'gemini') return null
            return <button type="button" key={provider} className={`ptile off ${provider} tip`} data-tip={ts.addTo(providerName[provider])} aria-label={ts.addTo(providerName[provider])} onClick={() => { setConverting({ name: skill.name, to: provider }); setReviewer(profiles.find((item) => item.provider === provider)?.id ?? profiles[0]?.id ?? '') }}><ProviderLogo provider={provider} /></button>
          })}</div></div>
        {expanded && <div className="skdetail"><p>{skill.description || ts.noDescription}</p><div className="skactions"><button type="button" className="mini danger" onClick={() => setDeleting(skill)}>{ts.deleteSkill}</button></div></div>}
        {running?.name === skill.name && <div className="running"><div className="row"><span className="spin" /><b>{ts.convertingReviewing}</b></div><div className="bar"><i /></div><span style={{ fontSize: 11, color: 'var(--accent)' }}>{ts.agentChecks}</span></div>}
        {converting?.name === skill.name && <div className="convbox"><p>{ts.convertIntro()[0]}<b>{skill.name}</b>{ts.convertIntro()[1]}<b>{providerName[converting.to]}</b>{ts.convertIntro()[2]}</p>
          <div className="agentbar col2"><Select label={ts.reviewerAgent} value={reviewer} onChange={setReviewer} options={[{ value: '', label: ts.noReview }, ...profiles.map((item) => ({ value: item.id, label: `${item.label} · ${providerName[item.provider]}` }))]} /></div>
          <div className="actions" style={{ margin: 0 }}><button type="button" className="secondary" onClick={() => setConverting(undefined)}>{t.common.cancel}</button><button type="button" disabled={busy} onClick={() => void guard(async () => { await window.gearmod.invoke('skills:convert', { scope, projectId, name: skill.name, from, to: converting.to, reviewProfileId: reviewer || undefined }); setConverting(undefined); await load() }, { title: ts.convertTitle(skill.name), detail: ts.convertDetail(providerName[from], providerName[converting.to]) })}>{ts.convertAndReview}</button></div></div>}
      </div>
    })}</div>
    {scope === 'project' && globalCount !== undefined && <p className="foot">{ts.footGlobal}</p>}
    {notice && <p className="hint" role="status" style={{ marginTop: 10 }}>{notice}</p>}
    {error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}
    {deleting && <ConfirmDialog eyebrow={ts.deleteSkill} title={deleting.name} text={ts.deleteText(Object.values(deleting.providers).filter((state) => state === 'ready').length > 1, deleting.origin ?? '')} ok={t.common.delete} danger cancel={() => setDeleting(undefined)} confirm={() => { const target = deleting; setDeleting(undefined); void guard(async () => { try { setSkills(await window.gearmod.invoke('skills:delete', { scope, projectId, name: target.name })); setOpen(undefined) } catch (reason) { throw new Error(plainError(reason)) } }) }} />}
  </>
}
