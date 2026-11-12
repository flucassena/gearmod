import { providerLabels } from '@gearmod/contracts'
import { useAppUpdate } from './appUpdate'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAgentUpdatesPending } from './useAgentUpdates'
import { ProjectAvatar } from './ProjectIcon'
import { dismissVoiceInstall, useVoiceInstall } from './voiceStore'
import type { AgentProfile, AgentUsage, Project, UsageHistoryRow } from '@gearmod/contracts'
import { AgentIcon, ProviderLogo } from './AgentIcon'
import { ChatPlusIcon, ChevronLeftIcon, ChevronUpIcon, GearIcon, PlusIcon, TrashIcon } from './icons'
import { plainError } from './NoticeDialog'
import { useEscape } from './useEscape'
import { useAsk } from './useAsk'
import { dateLocale, tr, useT } from './i18n'
import { projectStatus } from './sidebarStatus'

const level = (percent: number): string => (percent >= 90 ? 'hi' : percent >= 70 ? 'mid' : 'ok')
function left(iso: string | null): string {
  if (!iso) return '—'
  const minutes = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000)), days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60)
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}min` : `${minutes}min`
}
const at = (iso: string | null): string => (iso ? new Date(iso).toLocaleString(dateLocale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '')
const Bar = ({ percent }: { percent: number }): React.JSX.Element => <div className="ubar"><i className={level(percent)} style={{ width: `${percent}%` }} /></div>

export function usageHistorySummary(rows: UsageHistoryRow[]): { input: number; cached: number; output: number; billed: number; equivalent: number; unknown: number } {
  return rows.reduce((total, row) => ({ input: total.input + row.input, cached: total.cached + row.cached, output: total.output + row.output, billed: total.billed + row.billedUsd, equivalent: total.equivalent + row.equivalentUsd, unknown: total.unknown + row.unknownUsd }), { input: 0, cached: 0, output: 0, billed: 0, equivalent: 0, unknown: 0 })
}
/** Usage summed per agent (the history comes grouped by agent id), from highest cost to lowest. */
export function usageByAgent(rows: UsageHistoryRow[]): Array<{ id: string; input: number; cached: number; output: number; billed: number; equivalent: number; unknown: number }> {
  const byId = new Map<string, { id: string; input: number; cached: number; output: number; billed: number; equivalent: number; unknown: number }>()
  for (const row of rows) {
    const item = byId.get(row.group) ?? { id: row.group, input: 0, cached: 0, output: 0, billed: 0, equivalent: 0, unknown: 0 }
    item.input += row.input; item.cached += row.cached; item.output += row.output; item.billed += row.billedUsd; item.equivalent += row.equivalentUsd; item.unknown += row.unknownUsd
    byId.set(row.group, item)
  }
  const cost = (item: { billed: number; equivalent: number; unknown: number }): number => item.billed + item.equivalent + item.unknown
  return [...byId.values()].sort((a, b) => cost(b) - cost(a) || b.input + b.output - (a.input + a.output))
}
const tokens = (value: number): string => new Intl.NumberFormat(dateLocale()).format(value)
const money = (value: number): string => new Intl.NumberFormat(dateLocale(), { style: 'currency', currency: 'USD' }).format(value)

/** Session usage: footer button with the providers, per-agent list (5 h) and, on click, the full panel with the week. */
/** Voice dictation installation: progress bar above the agents and a notice when it finishes; visible on any screen. */
function VoiceInstallCard(): React.JSX.Element | null {
  const t = useT(), voice = useVoiceInstall()
  if (!voice.installing && !voice.done && !voice.error) return null
  return <div className={`voicecard ${voice.error ? 'err' : ''}`} role="status">
    {voice.installing && <><div className="vrow"><span>{t.shell.sidebar.voiceInstalling(voice.item ?? '')}</span><b>{voice.percent === null ? `${voice.megabytes} MB` : `${voice.percent}%`}</b></div><div className="vbar"><i style={{ width: `${voice.percent ?? 8}%` }} /></div></>}
    {!voice.installing && voice.done && <div className="vrow"><span>{t.shell.sidebar.voiceInstalled}</span><button type="button" aria-label={t.shell.sidebar.closeNotice} onClick={dismissVoiceInstall}>×</button></div>}
    {!voice.installing && voice.error && <div className="vrow"><span>{t.shell.sidebar.voiceError(voice.error)}</span><button type="button" aria-label={t.shell.sidebar.closeNotice} onClick={dismissVoiceInstall}>×</button></div>}
  </div>
}

function UsedAgents({ profiles, rail }: { profiles: AgentProfile[]; rail: boolean }): React.JSX.Element {
  const t = useT(), [open, setOpen] = useState(false), [usage, setUsage] = useState<AgentUsage[]>([]), [detail, setDetail] = useState<string>(), [refreshing, setRefreshing] = useState(false)
  const hoverTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])
  useEffect(() => { window.clearTimeout(hoverTimer.current); setOpen(false) }, [rail])
  const hover = (inside: boolean): void => {
    if (!rail) return
    window.clearTimeout(hoverTimer.current)
    if (detail) return
    hoverTimer.current = window.setTimeout(() => setOpen(inside), inside ? 220 : 180)
  }
  const visible = open || Boolean(detail)
  const load = useCallback(async () => { try { setUsage(await window.gearmod.invoke('usage:list', undefined)) } catch { /* usage is informational */ } }, [])
  // Shows what is already known right away and updates behind the scenes (Claude only reports the limit when it runs).
  useEffect(() => {
    if (!visible) return
    let alive = true
    void load(); setRefreshing(true)
    void window.gearmod.invoke('usage:refresh', undefined).then((fresh) => { if (alive) setUsage(fresh) }).catch(() => undefined).finally(() => { if (alive) setRefreshing(false) })
    return () => { alive = false }
  }, [visible, load])
  useEffect(() => window.gearmod.onRunEvent((event) => { if ((open || detail) && event.eventType === 'gearmod/run-completed') void load() }), [open, detail, load])
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: Event): void => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  useEscape(() => setOpen(false), open)
  const shown = profiles.slice(0, 4), extra = profiles.length - shown.length
  const windowOf = (profileId: string, id: 'five_hour' | 'seven_day') => usage.find((item) => item.profileId === profileId)?.windows.find((window) => window.id === id)
  return <div className="used" ref={root} onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
    <button type="button" className="usedbtn tip" data-tip={t.shell.sidebar.usedTip} aria-expanded={open} aria-label={t.shell.sidebar.usedTip} onClick={() => { window.clearTimeout(hoverTimer.current); setOpen(!open) }}><span className="avstack">{shown.map((profile) => <span key={profile.id} className={`av ptl ${profile.provider}`} style={{ color: profile.color, background: `color-mix(in srgb, ${profile.color} 22%, var(--surface-2))` }}><ProviderLogo provider={profile.provider} /></span>)}{extra > 0 && <span className="av ptl more">+{extra}</span>}</span><ChevronUpIcon className={`uchev ${open ? 'open' : ''}`} /></button>
    {open && <div className="upop"><div className="sectitle">{t.shell.sidebar.sessionUsage}{refreshing && <span className="refreshing">{t.shell.sidebar.updating}</span>}</div>{profiles.length === 0 && <p className="hint">{t.shell.sidebar.noAgents}</p>}{profiles.map((profile) => {
      // Session (5 h) and week, one labeled bar each; the reset time of the session stays on one line under the name.
      const window = windowOf(profile.id, 'five_hour'), week = windowOf(profile.id, 'seven_day')
      return <button type="button" className="urow" key={profile.id} onClick={() => { globalThis.clearTimeout(hoverTimer.current); setDetail(profile.id); setOpen(false) }}><AgentIcon profile={profile} tip={false} /><span className="un"><b>{profile.label}</b>
        <small className="rs">{window ? <>{t.shell.sidebar.resetsIn} <span>{left(window.resetsAt)}</span></> : t.shell.sidebar.noDataYet}</small>
        {window && <span className="ulim" data-tip={t.shell.sidebar.resetsAt(left(window.resetsAt), at(window.resetsAt))}><small>{t.shell.sidebar.sessionShort}</small><Bar percent={window.usedPercent} /><em>{window.usedPercent}%</em></span>}
        {week && <span className="ulim" data-tip={t.shell.sidebar.resetsAt(left(week.resetsAt), at(week.resetsAt))}><small>{t.shell.sidebar.weekShort}</small><Bar percent={week.usedPercent} /><em>{week.usedPercent}%</em></span>}</span></button>
    })}</div>}
    {detail && <UsageModal profiles={profiles} usage={usage} current={detail} close={() => setDetail(undefined)} />}
  </div>
}

function UsageModal({ profiles: all, usage, current, close, only }: { profiles: AgentProfile[]; usage: AgentUsage[]; current: string; close(): void; only?: boolean }): React.JSX.Element {
  const t = useT(), profiles = only ? all.filter((profile) => profile.id === current) : all
  const [history, setHistory] = useState<UsageHistoryRow[]>([]), [historyError, setHistoryError] = useState(''), [historyLoading, setHistoryLoading] = useState(true)
  useEscape(close)
  const { ask, dialog: askDialog } = useAsk()
  useEffect(() => {
    let alive = true
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    void window.gearmod.invoke('usage:history', { granularity: 'month', tz, groupBy: 'profile' }).then((rows) => {
      if (!alive) return
      setHistory(only ? rows.filter((row) => row.group === current) : rows); setHistoryError('')
    }).catch(() => { if (alive) setHistoryError(tr().shell.sidebar.historyLoadFailed) }).finally(() => { if (alive) setHistoryLoading(false) })
    return () => { alive = false }
  }, [current, only])
  const totals = usageHistorySummary(history)
  const [retentionBusy, setRetentionBusy] = useState(false), [retentionMessage, setRetentionMessage] = useState('')
  const [usageTab, setUsageTab] = useState<'limits' | 'history'>('limits')
  const exportCsv = async (): Promise<void> => {
    setRetentionBusy(true); setRetentionMessage('')
    try {
      const { csv } = await window.gearmod.invoke('usage:export', {})
      const { saved } = await window.gearmod.invoke('usage:save-csv', { content: csv, defaultName: 'consumo-gearmod.csv' })
      setRetentionMessage(saved ? t.shell.sidebar.csvSaved : t.shell.sidebar.exportCancelled)
    } catch (reason) { setRetentionMessage(plainError(reason)) } finally { setRetentionBusy(false) }
  }
  // U14: deleting always exports first (approval_record kind usage-ledger-purge); without approval, nothing is deleted.
  const purgeAll = async (): Promise<void> => {
    if (!(await ask({ eyebrow: t.shell.sidebar.purgeEyebrow, title: t.shell.sidebar.purgeTitle, text: t.shell.sidebar.purgeText, ok: t.shell.sidebar.purgeOk, danger: true }))) return
    setRetentionBusy(true); setRetentionMessage('')
    try {
      const range = { to: new Date().toISOString() }
      const approval = await window.gearmod.invoke('usage:purge-request', range)
      await window.gearmod.invoke('approvals:decide', { id: approval.id, approve: true })
      const { deleted, csv } = await window.gearmod.invoke('usage:purge', { ...range, approvalId: approval.id })
      const { saved } = await window.gearmod.invoke('usage:save-csv', { content: csv, defaultName: 'consumo-antes-de-apagar.csv' })
      setRetentionMessage(t.shell.sidebar.purged(deleted, saved))
    } catch (reason) { setRetentionMessage(plainError(reason)) } finally { setRetentionBusy(false) }
  }
  return <div className="overlay top" role="dialog" aria-label={t.shell.sidebar.usageTitle}><div className="modal usage usage-history" style={{ width: 'min(620px,100%)' }}>{askDialog}<header><div><div className="eyebrow">{t.shell.sidebar.planUsage}</div><h2>{t.shell.sidebar.usageTitle}</h2></div><button className="x" onClick={close} aria-label={t.common.close}>×</button></header><div className="tabs" role="tablist">{([['limits', t.shell.sidebar.usageTabLimits], ['history', t.shell.sidebar.usageTabHistory]] as const).map(([value, label]) => <button type="button" key={value} role="tab" aria-selected={usageTab === value} className={`tab ${usageTab === value ? 'on' : ''}`} onClick={() => setUsageTab(value)}>{label}</button>)}</div>
    <div className="usage-body">{usageTab === 'limits' ? 
    <section className="usage-area" aria-labelledby="quota-title"><div className="usage-area-title"><b id="quota-title">{t.shell.sidebar.accountQuota}</b><small>{t.shell.sidebar.accountQuotaHint}</small></div><div className="ugrid">{profiles.map((profile) => { const item = usage.find((entry) => entry.profileId === profile.id); return <section className={`ucard ${profile.id === current ? 'here' : ''}`} key={profile.id}>
      <div className="uhead"><AgentIcon profile={profile} size="lg" tip={false} /><span><b>{profile.label}</b><small>{providerLabels[profile.provider]}</small></span></div>
      {item?.windows.length ? item.windows.map((window) => <div className="ublk" key={window.id}><div className="uh"><span>{window.label}</span>{window.resetsAt && <small>{t.shell.sidebar.resetsAt(left(window.resetsAt), at(window.resetsAt))}</small>}<b>{window.usedPercent}%</b></div><Bar percent={window.usedPercent} /></div>) : <div className="ublk"><small>{profile.provider === 'claude' ? t.shell.sidebar.claudeReportsUsage : profile.provider === 'gemini' ? t.shell.sidebar.noAntigravityUsage : t.shell.sidebar.noCodexSessions}</small></div>}
    </section> })}</div></section>
    : <>
    <section className="usage-area" aria-labelledby="tokens-title"><div className="usage-area-title"><b id="tokens-title">{t.shell.sidebar.assignedTokens}</b><small>{t.shell.sidebar.assignedTokensHint}</small></div>{historyLoading ? <p className="dim">{t.shell.sidebar.loadingHistory}</p> : history.length === 0 ? <p className="dim">{t.shell.sidebar.noTokensYet}</p> : <div className="history-grid"><div><small>{t.shell.sidebar.input}</small><b>{tokens(totals.input)}</b></div><div><small>{t.shell.sidebar.cache}</small><b>{tokens(totals.cached)}</b></div><div><small>{t.shell.sidebar.output}</small><b>{tokens(totals.output)}</b></div></div>}{historyError && <p className="error">{historyError}</p>}</section>
    <section className="usage-area" aria-labelledby="cost-title"><div className="usage-area-title"><b id="cost-title">{t.shell.sidebar.costsByType}</b><small>{t.shell.sidebar.costsHint}</small></div>{historyLoading ? <p className="dim">{t.shell.sidebar.loadingCosts}</p> : <div className="history-grid costs"><div><small>{t.shell.sidebar.billed}</small><b>{money(totals.billed)}</b></div><div><small>{t.shell.sidebar.apiEquivalent}</small><b>{money(totals.equivalent)}</b></div><div><small>{t.shell.sidebar.unknown}</small><b>{totals.unknown ? money(totals.unknown) : '—'}</b></div></div>}</section>
    {!only && !historyLoading && history.length > 0 && <section className="usage-area" aria-labelledby="byagent-title"><div className="usage-area-title"><b id="byagent-title">{t.shell.sidebar.byAgent}</b><small>{t.shell.sidebar.byAgentHint}</small></div>
      <table className="usage-agents"><thead><tr><th>{t.shell.sidebar.agentColumn}</th><th>{t.shell.sidebar.input}</th><th>{t.shell.sidebar.cache}</th><th>{t.shell.sidebar.output}</th><th>{t.shell.sidebar.costColumn}</th></tr></thead><tbody>{usageByAgent(history).map((item) => {
        const profile = all.find((entry) => entry.id === item.id)
        return <tr key={item.id}><td>{profile ? <span className="usage-agent">{<AgentIcon profile={profile} size="sm" tip={false} />}{profile.label}</span> : <span className="dim">{t.shell.sidebar.removedAgent}</span>}</td>
          <td className="num">{tokens(item.input)}</td><td className="num">{tokens(item.cached)}</td><td className="num">{tokens(item.output)}</td>
          <td className="num tip" data-tip={t.shell.sidebar.costBreakdown(money(item.billed), money(item.equivalent), money(item.unknown))}>{money(item.billed + item.equivalent + item.unknown)}</td></tr>
      })}</tbody></table></section>}
    <section className="usage-area" aria-labelledby="retention-title"><div className="usage-area-title"><b id="retention-title">{t.shell.sidebar.historyPrivacy}</b><small>{t.shell.sidebar.historyPrivacyHint}</small></div>
      <div className="actions" style={{ margin: 0 }}><button type="button" className="secondary" disabled={retentionBusy} onClick={() => void exportCsv()}>{t.shell.sidebar.exportCsv}</button><button type="button" className="danger" disabled={retentionBusy} onClick={() => void purgeAll()}>{t.shell.sidebar.purgeUntilToday}</button></div>
      {retentionMessage && <p className="hint" role="status">{retentionMessage}</p>}
    </section>
    </>}</div>
    </div></div>
}

/** The same usage panel as in settings, opened from outside the footer (composer rings): loads agents and usage on its own. */
export function UsageDialog({ current, close }: { current?: string; close(): void }): React.JSX.Element | null {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]), [usage, setUsage] = useState<AgentUsage[]>([])
  useEffect(() => {
    let alive = true
    void window.gearmod.invoke('profiles:list', undefined).then((list) => { if (alive) setProfiles(list) }).catch(() => undefined)
    void window.gearmod.invoke('usage:list', undefined).then((list) => { if (alive) setUsage(list) }).catch(() => undefined)
    void window.gearmod.invoke('usage:refresh', undefined).then((fresh) => { if (alive) setUsage(fresh) }).catch(() => undefined)
    return () => { alive = false }
  }, [])
  return <UsageModal profiles={profiles} usage={usage} current={current ?? ''} close={close} only={Boolean(current)} />
}

export function Sidebar({ projects, profiles, selected, collapsed, onSelect, onOpenCard, onNew, onSettings, onAddAgent, onProjectSettings, onNewChat, onToggle, onReorder, onDelete }: { projects: Project[]; profiles: AgentProfile[]; selected?: string; collapsed: boolean; onSelect(id: string): void; onOpenCard(projectId: string, cardId: string): void; onNew(): void; onAddAgent(): void; onSettings(): void; onProjectSettings(projectId: string): void; onNewChat(projectId: string): void; onToggle(): void; onReorder(projectIds: string[]): void; onDelete(project: Project): void }): React.JSX.Element {
  const t = useT(), agentUpdates = useAgentUpdatesPending(profiles), appUpdate = useAppUpdate()?.available === true
  // Dragging: while dragging, the list shows the project already in the new position; on drop, saves the order.
  const [drag, setDrag] = useState<{ id: string; over: number }>(), [menu, setMenu] = useState<{ project: Project; x: number; y: number }>()
  const projectMenu = useRef<HTMLDivElement>(null)
  // Hover menu of a project with its alerts card by card; a short delay lets the mouse move from the row into the menu.
  const [peek, setPeek] = useState<{ project: Project; x: number; y: number }>(), peekTimer = useRef<number | undefined>(undefined)
  const showPeek = (project: Project, row: HTMLElement): void => {
    window.clearTimeout(peekTimer.current)
    if ((!collapsed && !project.activity.alerts?.length) || drag) { setPeek(undefined); return }
    const box = row.getBoundingClientRect()
    peekTimer.current = window.setTimeout(() => setPeek({ project, x: box.right + 6, y: Math.min(box.top, window.innerHeight - 320) }), 220)
  }
  const hidePeek = (): void => { window.clearTimeout(peekTimer.current); peekTimer.current = window.setTimeout(() => setPeek(undefined), 180) }
  useEffect(() => () => window.clearTimeout(peekTimer.current), [])
  useEffect(() => { window.clearTimeout(peekTimer.current); setPeek(undefined) }, [collapsed])
  const statusText = (project: Project): string => {
    const { primary, extra } = projectStatus(project.activity)
    const text = primary === 'waiting' ? t.shell.sidebar.waitingCount(project.activity.waiting ?? 0) : primary === 'finished' ? t.shell.sidebar.finishedCount(project.activity.finished) : primary === 'running' ? t.shell.sidebar.running(project.activity.running) : undefined
    const git = project.sources.filter((source) => source.isGitRepository).length
    return text ? `${text}${extra ? ` +${extra}` : ''}` : git ? t.shell.sidebar.repositories(git) : t.shell.sidebar.folderWithoutGit
  }
  const ordered = drag ? (() => { const rest = projects.filter((item) => item.id !== drag.id), moving = projects.find((item) => item.id === drag.id)!; rest.splice(drag.over, 0, moving); return rest })() : projects
  const drop = (): void => { if (drag && ordered.some((item, index) => item.id !== projects[index]?.id)) onReorder(ordered.map((item) => item.id)); setDrag(undefined) }
  useEffect(() => {
    if (!menu) return
    projectMenu.current?.focus()
    const close = (): void => setMenu(undefined), key = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || (event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable="true"]'))) return
      const pressed = event.key.toLowerCase()
      if (pressed !== 'n' && pressed !== 'c' && pressed !== 'delete') return
      event.preventDefault(); event.stopPropagation(); close()
      if (pressed === 'n') onNewChat(menu.project.id); else if (pressed === 'c') onProjectSettings(menu.project.id); else onDelete(menu.project)
    }
    window.addEventListener('click', close); document.addEventListener('keydown', key)
    return () => { window.removeEventListener('click', close); document.removeEventListener('keydown', key) }
  }, [menu, onNewChat, onProjectSettings, onDelete])
  useEscape(() => setMenu(undefined), Boolean(menu))
  return <>
    <button type="button" className="side-toggle tip" data-tip={collapsed ? t.shell.sidebar.showSidebar : t.shell.sidebar.hideSidebar} aria-label={collapsed ? t.shell.sidebar.showSidebar : t.shell.sidebar.hideSidebar} onClick={onToggle}><ChevronLeftIcon /></button>
    <aside className={collapsed ? 'rail' : undefined}>
      <button className="secondary newproj" data-tip={collapsed ? t.shell.sidebar.newProjectTip : undefined} aria-label={t.shell.sidebar.newProjectTip} onClick={onNew}>{collapsed ? <PlusIcon /> : t.shell.sidebar.newProject}</button>
      <nav className="projs" onDragOver={(e) => { if (drag) e.preventDefault() }} onDrop={(e) => { e.preventDefault(); drop() }}>{ordered.map((project, index) => {
        const { running, finished } = project.activity, waiting = project.activity.waiting ?? 0, git = project.sources.filter((source) => source.isGitRepository).length
        // One status only, the most important (needs you > finished > running), so the row never overflows;
        // the full list is in the tooltip and in the alerts that open on hover.
        const parts = [waiting ? { kind: 'wait', text: t.shell.sidebar.waitingCount(waiting) } : null, finished ? { kind: 'fin', text: t.shell.sidebar.finishedCount(finished) } : null, running ? { kind: 'run', text: t.shell.sidebar.running(running) } : null].filter((part) => part !== null)
        const status = projectStatus(project.activity), top = parts.find((part) => part.kind === ({ waiting: 'wait', finished: 'fin', running: 'run' } as const)[status.primary ?? 'running']), more = status.extra
        const sub = top ? <small className="salerts" data-tip={parts.map((part) => part.text).join(' · ')}><span className={`s${top.kind}`}>{top.text}</span>{more > 0 && <span className="ssep"> +{more}</span>}</small> : <small>{git ? t.shell.sidebar.repositories(git) : t.shell.sidebar.folderWithoutGit}</small>
        return <div className={`projrow ${drag?.id === project.id ? 'dragging' : ''}`} key={project.id} draggable
          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setMenu(undefined); setDrag({ id: project.id, over: index }) }}
          onDragOver={(e) => {
            if (!drag) return
            e.preventDefault()
            if (drag.id === project.id) return
            // Position in the list without the dragged project; lower half of the row = goes after it.
            const box = e.currentTarget.getBoundingClientRect(), after = e.clientY > box.top + box.height / 2
            const over = (index > drag.over ? index - 1 : index) + (after ? 1 : 0)
            if (over !== drag.over) setDrag({ ...drag, over })
          }}
          onDragEnd={() => setDrag(undefined)}
          onContextMenu={(e) => { e.preventDefault(); setPeek(undefined); setMenu({ project, x: e.clientX, y: e.clientY }) }}
          onMouseEnter={(e) => showPeek(project, e.currentTarget)} onMouseLeave={hidePeek}>
          <button type="button" className={`proj ${selected === project.id ? 'on' : ''} ${finished ? 'fin' : ''} ${running ? 'busy' : ''} ${waiting ? 'wait' : ''}`} aria-label={`${project.name} · ${statusText(project)}`} data-tip={collapsed ? project.name : undefined} onClick={() => onSelect(project.id)}><ProjectAvatar name={project.name} icon={project.icon} /><span className="proj-label" data-tip={collapsed ? undefined : project.name}>{project.name}{sub}</span>{waiting > 0 ? <b className="pdot wait" data-tip={t.shell.sidebar.waitingTip} /> : finished > 0 ? <b className="pdot" data-tip={t.shell.sidebar.finishedTip} /> : !collapsed && running > 0 && <span className="spin sm" data-tip={t.shell.sidebar.runningTip} />}{collapsed && running > 0 && <span className="spin sm rail-running" data-tip={t.shell.sidebar.runningTip} />}</button>
          <button type="button" className="projnew tip" data-tip={t.shell.sidebar.newFreeChatTip} aria-label={t.shell.sidebar.newFreeChatIn(project.name)} onClick={() => onNewChat(project.id)}><ChatPlusIcon /></button></div>
      })}</nav>
      <VoiceInstallCard />
      <div className="side-foot"><button className="iconbtn gearwrap" data-tip={appUpdate ? t.shell.sidebar.settingsWithAppUpdate : agentUpdates ? t.shell.sidebar.settingsWithUpdate : t.common.settings} aria-label={appUpdate ? t.shell.sidebar.settingsWithAppUpdate : agentUpdates ? t.shell.sidebar.settingsLabelWithUpdate : t.common.settings} onClick={onSettings}>⚙{(agentUpdates || appUpdate) && <i className="gear-dot" aria-hidden="true" />}</button>{profiles.length ? <UsedAgents profiles={profiles} rail={collapsed} /> : <button type="button" className="mini secondary withicon side-addagent" data-tip={t.shell.sidebar.addAgent} aria-label={t.shell.sidebar.addAgent} onClick={onAddAgent}><PlusIcon />{!collapsed && t.shell.sidebar.addAgent}</button>}</div>
    </aside>
    {peek && !menu && <div className="projmenu projalerts" role="menu" aria-label={t.shell.sidebar.alertsOf(peek.project.name)} style={{ left: peek.x, top: peek.y }} onMouseEnter={() => window.clearTimeout(peekTimer.current)} onMouseLeave={hidePeek}>
      <div className="ctxtitle">{peek.project.name}</div>
      {collapsed && <p className="proj-summary">{statusText(projects.find((project) => project.id === peek.project.id) ?? peek.project)}</p>}
      {(peek.project.activity.alerts ?? []).map((alert) => <button type="button" role="menuitem" key={alert.cardId} className={`palert ${alert.kind}`} onClick={() => { setPeek(undefined); onOpenCard(peek.project.id, alert.cardId) }}>
        {alert.kind === 'running' ? <span className="spin sm" /> : <span className={`dot ${alert.kind === 'failed' ? '' : 'pulse'}`} />}<span className="pa-title">{alert.title || t.shell.sidebar.untitledCard}</span><small>{t.shell.sidebar.alertKind[alert.kind]}</small></button>)}
    </div>}
    {menu && <div ref={projectMenu} className="projmenu" role="menu" aria-label={t.shell.sidebar.projectActions(menu.project.name)} tabIndex={-1} style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      <div className="ctxtitle">{menu.project.name}</div>
      <button type="button" role="menuitem" onClick={() => { setMenu(undefined); onNewChat(menu.project.id) }}><ChatPlusIcon /><span>{t.shell.sidebar.newFreeChat}</span><kbd>N</kbd></button>
      <button type="button" role="menuitem" onClick={() => { setMenu(undefined); onProjectSettings(menu.project.id) }}><GearIcon /><span>{t.shell.sidebar.configureProject}</span><kbd>C</kbd></button>
      <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(undefined); onDelete(menu.project) }}><TrashIcon /><span>{t.shell.sidebar.deleteProject}</span><kbd>Del</kbd></button>
    </div>}
  </>
}
