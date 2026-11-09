import { providerLabels } from '@gearmod/contracts'
import { AboutPanel } from './AboutPanel'
import { StoragePanel } from './StoragePanel'
import { useAppUpdate } from './appUpdate'
import { setLocale, useT } from './i18n'
import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useFloatingMenu } from './useFloatingMenu'
import { isOutdated, useLatestVersions } from './toolUpdates'
import { agentColorPalette, defaultAgentColor, type AgentProbe, type AgentProfile, type AppLanguage, type AppSettings, type AppTheme, type VoiceModel } from '@gearmod/contracts'
import { AgentIcon, ProviderLogo } from './AgentIcon'
import { NoticeDialog, plainError } from './NoticeDialog'
import { SkillsPanel } from './SkillsPanel'
import { ShortcutsPanel } from './ShortcutsPanel'
import { McpPanel } from './McpPanel'
import { messageSpacings, readMessageSpacing, saveMessageSpacing, type MessageSpacing } from './chatPrefs'
import { dismissVoiceInstall, notifyVoiceChanged } from './voiceStore'
import { Select } from './Select'
import { useEscape } from './useEscape'
import { ConfirmDialog } from './ConfirmDialog'
import { Switch } from './Switch'
import { setGravatarEnabled } from './gravatarSetting'
import { DefaultCardTypes } from './CardTypes'
import { AgentLoginDialog } from './AgentLoginDialog'
import { toast } from './toasts'
import { AgentUpdateDialog } from './AgentUpdateDialog'
import { useTasks } from './backgroundTasks'
import type { UpdatableProvider } from './agentUpdates'

export const themes: ReadonlyArray<{ value: AppTheme; mode: 'dark' | 'light'; swatches: [string, string, string] }> = [
  { value: 'green', mode: 'dark', swatches: ['#8db99a', '#2f5a40', '#101713'] },
  { value: 'purple', mode: 'dark', swatches: ['#a99bd9', '#4a3f6e', '#15121d'] },
  { value: 'blue', mode: 'dark', swatches: ['#8fb3d9', '#345273', '#101720'] },
  { value: 'orange', mode: 'dark', swatches: ['#d9a477', '#6b4a33', '#1c1510'] },
  { value: 'graphite', mode: 'dark', swatches: ['#b8c0cc', '#4b5563', '#101216'] },
  { value: 'teal', mode: 'dark', swatches: ['#65c9c2', '#246b68', '#0c1818'] },
  { value: 'rose', mode: 'dark', swatches: ['#dda0b6', '#704052', '#1d1116'] },
  { value: 'light-mint', mode: 'light', swatches: ['#237a4b', '#a8d8ba', '#f4faf6'] },
  { value: 'light-sky', mode: 'light', swatches: ['#2468a2', '#aacde9', '#f4f8fc'] },
  { value: 'light-lavender', mode: 'light', swatches: ['#6848a0', '#cabce4', '#f8f6fc'] },
  { value: 'light-sand', mode: 'light', swatches: ['#95601f', '#dfc49b', '#fbf8f1'] },
  { value: 'light-rose', mode: 'light', swatches: ['#a74468', '#e5b7c8', '#fcf6f8'] },
  { value: 'light-slate', mode: 'light', swatches: ['#40566f', '#bcc8d5', '#f5f7fa'] }
]
const languages: ReadonlyArray<{ value: AppLanguage; label: string }> = [{ value: 'pt-BR', label: 'Português (Brasil)' }, { value: 'en', label: 'English' }]

export function applyTheme(theme: AppTheme): void {
  document.documentElement.dataset.accent = theme
  const light = theme.startsWith('light-')
  document.documentElement.dataset.theme = light ? 'light' : 'dark'
  void window.gearmod.invoke('app:set-titlebar-theme', { light }).catch(() => undefined)
}

export function applySettings(settings: AppSettings): void {
  applyTheme(settings.tema)
  // The window, taskbar and tray icons follow the app theme (a project theme only changes the inside of the app).
  const accent = themes.find((theme) => theme.value === settings.tema)?.swatches[0]
  if (accent) void window.gearmod.invoke('app:set-brand-color', { color: accent }).catch(() => undefined)
  setLocale(settings.idioma)
}

/**
 * Create and edit agent. A new one goes in steps: type (Claude/Codex), then name, usage and personality, then the account login
 * inside the app (`AgentLoginDialog`). Editing shows everything at once.
 */
export function AgentDialog({ profile, close, changed }: { profile?: AgentProfile; close(): void; changed(): Promise<void> }): React.JSX.Element {
  const t = useT(), ta = t.settings.agent
  const [provider, setProvider] = useState<'codex' | 'claude' | 'gemini'>(profile?.provider ?? 'claude'), [label, setLabel] = useState(profile?.label ?? ''), [scope, setScope] = useState(profile?.scope ?? ta.defaultScope), [color, setColor] = useState(profile?.color ?? defaultAgentColor('claude'))
  const [billingMode, setBillingMode] = useState<AgentProfile['billingMode']>(profile?.billingMode ?? 'unknown')
  const [envPassthrough, setEnvPassthrough] = useState<string[]>(profile?.envPassthrough ?? []), [envVarDraft, setEnvVarDraft] = useState('')
  const [installed, setInstalled] = useState(Boolean(profile)), [pending, setPending] = useState<AgentProfile | undefined>(undefined), [status, setStatus] = useState<AgentProbe>(), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [createdHere, setCreatedHere] = useState(false), [removing, setRemoving] = useState(false)
  const [step, setStep] = useState<'type' | 'details'>(profile ? 'details' : 'type'), [loginFor, setLoginFor] = useState<AgentProfile>()
  // `checked`: the automatic check finished (until then the dialog says it is checking, not that the CLI is missing).
  const [installing, setInstalling] = useState<'codex' | 'claude' | 'gemini'>(), [checked, setChecked] = useState(false)
  const run = async (action: () => Promise<void>): Promise<void> => { setBusy(true); setMessage(''); try { await action() } catch (error) { setMessage(plainError(error)) } finally { setBusy(false) } }
  // Not found: only asks to install (the technical detail stays out); after an install that still is not found, says so plainly.
  const checkInstall = async (which = provider, afterInstall = false): Promise<void> => {
    try {
      const result = await window.gearmod.invoke('profiles:detect-provider', { provider: which })
      setInstalled(result.installed)
      setMessage(result.installed ? ta.installFound(result.version || which) : afterInstall ? ta.stillNotFound(item(which)) : '')
    } finally { setChecked(true) }
  }
  useEffect(() => { if (!profile && step === 'details') { setChecked(false); void run(() => checkInstall(provider)) } }, [provider, step])
  useEffect(() => { if (!profile) setColor(defaultAgentColor(provider)) }, [provider, profile])
  useEscape(() => { void cancel() })
  const cancel = async (): Promise<void> => { if (pending && createdHere) await window.gearmod.invoke('profiles:delete', { profileId: pending.id }).catch(() => undefined); close() }
  const checkAccount = async (item: AgentProfile): Promise<void> => {
    const result = await window.gearmod.invoke('profiles:probe', { profileId: item.id })
    setStatus(result)
    if (result.authenticated && result.installed) { await changed(); setMessage(ta.connectedReady(item.label)); if (!profile) close() }
    else setMessage(result.installed ? ta.installFoundLogin : ta.cannotRun(result.error || ta.programNotFound))
  }
  const save = async (): Promise<void> => {
    if (profile) { await window.gearmod.invoke('profiles:update', { profileId: profile.id, label, scope, color, billingMode, envPassthrough }); await changed(); close(); return }
    const created = await window.gearmod.invoke('profiles:create', { provider, label: label.trim() || ta.defaultLabel(providerLabels[provider]), scope: scope.trim() || ta.defaultScope, color })
    setCreatedHere(true); setPending(created); setLoginFor(created)
  }
  // Account connected in the login dialog: a new agent is ready (closes); when editing, refreshes the account shown.
  // Login canceled for a new agent: removes the registration just created and goes back to the filled form (name, usage, personality).
  const loginCanceled = async (): Promise<void> => {
    setLoginFor(undefined)
    if (profile || !pending || !createdHere) return
    try { await window.gearmod.invoke('profiles:delete', { profileId: pending.id }); setPending(undefined); setCreatedHere(false); setMessage('') } catch (reason) { setMessage(plainError(reason)) }
  }
  const loggedIn = async (item: AgentProfile): Promise<void> => { setLoginFor(undefined); toast.success(t.settings.agentLogin.connectedTitle, t.settings.agentLogin.connectedText(item.label)); if (profile) await run(() => checkAccount(item)); else { await changed(); close() } }
  const [notice, setNotice] = useState<{ title: string; text: string; after?: boolean }>()
  const remove = async (): Promise<void> => {
    if (!profile) return
    try {
      const result = await window.gearmod.invoke('profiles:delete', { profileId: profile.id }); await changed()
      if (result.archived) setNotice({ title: ta.removedTitle, text: ta.removedText(profile.label), after: true })
      else close()
    } catch (reason) { setNotice({ title: ta.removeFailed, text: plainError(reason) }) }
  }
  const preview = { provider, label: label || ta.previewFallback, color }
  return <div className="overlay top" role="dialog" aria-label={profile ? ta.edit : ta.new}><div className="modal" style={{ width: 'min(460px,100%)' }}>
    <header><div><div className="eyebrow">{t.common.agent}</div><h2>{profile ? ta.edit : ta.new}</h2></div><button className="x" onClick={() => void cancel()} aria-label={t.common.close}>×</button></header>
    <div className="stack">
      {!profile && !pending && step === 'type' && <div className="f"><span>{ta.pickType}</span><div className="provcards two">{newAgentProviders.map((item) => <button type="button" key={item} onClick={() => { setProvider(item); setStep('details') }}><i className={`av lg ${item}`} style={{ color: defaultAgentColor(item) }}><ProviderLogo provider={item} /></i><span><b>{item === 'claude' ? 'Claude' : 'Codex'}</b><small>{item === 'claude' ? 'Anthropic' : 'OpenAI'}</small></span></button>)}</div></div>}
      {!profile && !pending && step === 'details' && !installed && !checked && <p role="status" className="hint">{ta.checkingInstall(item(provider))}</p>}
      {!profile && !pending && step === 'details' && !installed && checked && <div className="convbox"><p>{ta.askInstall(item(provider))}</p><div className="actions" style={{ margin: 0 }}><button type="button" className="secondary" disabled={busy} onClick={() => { setMessage(''); setStep('type') }}>{ta.notNow}</button><button type="button" disabled={busy} onClick={() => setInstalling(provider)}>{ta.install(item(provider))}</button></div></div>}
      {(profile || installed) && !pending && step === 'details' && <>
        <label className="f">{t.common.name}<div className="aename"><AgentIcon profile={preview} size="lg" tip={false} /><input className="in" value={label} placeholder={provider === 'claude' ? ta.labelPlaceholderClaude : provider === 'gemini' ? ta.labelPlaceholderGemini : ta.labelPlaceholderCodex} onChange={(e) => setLabel(e.target.value)} /></div></label>
        <label className="f">{ta.usage}<input className="in" value={scope} onChange={(e) => setScope(e.target.value)} /></label>
        {profile && <div className="f"><span>{ta.billing}</span><Select label={ta.billing} options={[{ value: 'unknown', label: ta.billingUnknown }, { value: 'subscription', label: ta.billingSubscription }, { value: 'api', label: ta.billingApi }, { value: 'credits', label: ta.billingCredits }]} value={billingMode} onChange={(value) => setBillingMode(value as AgentProfile['billingMode'])} />
          {profile.apiKeySourceHint && profile.apiKeySourceHint !== 'none' && billingMode !== 'api' && <div className="convbox" style={{ margin: 0 }}><p>{ta.apiKeyHint(profile.apiKeySourceHint)}</p><div className="actions" style={{ margin: 0 }}><button type="button" className="secondary" disabled={busy} onClick={() => setLoginFor(profile)}>{ta.redoLogin}</button></div></div>}
        </div>}
        {profile && <div className="f"><span>{ta.envVars}<small>{ta.envVarsHint}</small></span>
          <div className="swatches" style={{ flexWrap: 'wrap', gap: 6 }}>{envPassthrough.map((name) => <span key={name} className="pillg" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{name}<button type="button" className="x" aria-label={ta.removeVar(name)} onClick={() => setEnvPassthrough(envPassthrough.filter((item) => item !== name))}>×</button></span>)}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="in" placeholder={ta.envPlaceholder} value={envVarDraft} onChange={(e) => setEnvVarDraft(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key !== 'Enter') return; e.preventDefault(); const name = envVarDraft.trim(); if (name && !envPassthrough.includes(name)) setEnvPassthrough([...envPassthrough, name]); setEnvVarDraft('') }} style={{ flex: 1 }} />
            <button type="button" className="secondary" disabled={!envVarDraft.trim()} onClick={() => { const name = envVarDraft.trim(); if (name && !envPassthrough.includes(name)) setEnvPassthrough([...envPassthrough, name]); setEnvVarDraft('') }}>{t.common.add}</button>
          </div>
          {/^.*_(TOKEN|KEY|SECRET)$/i.test(envVarDraft.trim()) && <small className="hint" style={{ margin: 0 }}>{ta.envKeyHint}</small>}
        </div>}
        <div className="f"><span>{ta.personality}</span><div className="swatches">{agentColorPalette.map((value) => <button type="button" key={value} className={`sw ${color.toLowerCase() === value.toLowerCase() ? 'sel' : ''}`} style={{ '--c': value } as React.CSSProperties} aria-label={ta.colorAria(value)} aria-pressed={color.toLowerCase() === value.toLowerCase()} onClick={() => setColor(value)} />)}<label className={`sw custom ${agentColorPalette.some((value) => value.toLowerCase() === color.toLowerCase()) ? '' : 'sel'}`} style={{ '--c': color } as React.CSSProperties} title={ta.customColor} aria-label={ta.customColor}><input type="color" value={color.toLowerCase()} onChange={(e) => setColor(e.target.value)} /></label></div></div>
      </>}
      {pending && <div className="convbox"><p>{ta.pendingLogin(pending.label)}</p><div className="actions" style={{ margin: 0 }}><button type="button" disabled={busy} onClick={() => setLoginFor(pending)}>{ta.signIn}</button><button type="button" className="secondary" disabled={busy} onClick={() => void run(() => checkAccount(pending))}>{ta.checkAccount}</button></div></div>}
      {profile && <div className="convbox"><p>{status ? (status.authenticated ? ta.accountConnected(status.account ?? '') : status.installed ? ta.installedNotConnected : ta.notInstalled(status.error ?? ta.programNotFound)) : ta.checkPrompt}</p><div className="actions" style={{ margin: 0 }}><button type="button" className="secondary" disabled={busy} onClick={() => setLoginFor(profile)}>{ta.signIn}</button><button type="button" className="secondary" disabled={busy} onClick={() => void run(() => checkAccount(profile))}>{ta.checkAccount}</button></div></div>}
      {message && <p role="status" className="hint" style={{ overflowWrap: 'anywhere' }}>{message}</p>}
    </div>
    <div className="actions">{profile && <button type="button" className="danger" style={{ marginRight: 'auto' }} disabled={busy} onClick={() => setRemoving(true)}>{t.common.remove}</button>}<button type="button" className="secondary" onClick={() => void cancel()}>{pending ? ta.cancelRegistration : t.common.cancel}</button>{!profile && !pending && step === 'details' && <button type="button" className="secondary" disabled={busy} onClick={() => { setStep('type'); setMessage('') }}>{ta.back}</button>}{!pending && step === 'details' && (profile || installed) && <button type="button" disabled={busy} onClick={() => void run(save)}>{profile ? t.common.save : ta.continueToAccount}</button>}</div>
    {loginFor && <AgentLoginDialog profile={loginFor} close={() => void loginCanceled()} connected={() => void loggedIn(loginFor)} />}
    {installing && <AgentUpdateDialog job="install" provider={installing} close={() => setInstalling(undefined)} done={() => void run(() => checkInstall(installing, true))} />}
    {removing && profile && <ConfirmDialog eyebrow={t.common.agent} title={ta.removeTitle(profile.label)} text={ta.removeText} ok={t.common.remove} danger cancel={() => setRemoving(false)} confirm={() => { setRemoving(false); void run(remove) }} />}
    {notice && <NoticeDialog eyebrow={t.common.agent} title={notice.title} text={notice.text} close={() => { const after = notice.after; setNotice(undefined); if (after) close() }} />}
  </div></div>
}
/** Groq key: stays encrypted on the computer; the screen only knows whether it exists, never shows the value. */
function GroqKeyField(): React.JSX.Element {
  const t = useT(), tg = t.settings.groq
  const [saved, setSaved] = useState<boolean>(), [editing, setEditing] = useState(false), [key, setKey] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { void window.gearmod.invoke('voice:status', undefined).then((status) => setSaved(status.modelInstalled)).catch(() => undefined) }, [])
  const store = async (value: string): Promise<void> => {
    setBusy(true); setError('')
    try { setSaved((await window.gearmod.invoke('voice:set-key', { key: value })).modelInstalled); setKey(''); setEditing(false); dismissVoiceInstall(); notifyVoiceChanged() } catch (reason) { setError(plainError(reason)) } finally { setBusy(false) }
  }
  return <div className="stack" style={{ gap: 6 }}>
    <div className="f">{tg.keyTitle}
      {saved && !editing
        ? <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input className="in" type="password" readOnly value="••••••••••••••••" aria-label={tg.savedAria} style={{ flex: 1 }} /><span className="hint" style={{ margin: 0 }}>{tg.saved}</span><button type="button" className="secondary" disabled={busy} onClick={() => { setEditing(true); setError('') }}>{tg.replace}</button><button type="button" className="secondary" disabled={busy} onClick={() => void store('')}>{t.common.remove}</button></div>
        : <form style={{ display: 'flex', gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (key.trim()) void store(key) }}><input className="in" type="password" autoComplete="off" spellCheck={false} autoFocus={editing} placeholder="gsk_…" aria-label={tg.keyTitle} value={key} onChange={(e) => setKey(e.target.value)} style={{ flex: 1 }} /><button type="submit" disabled={busy || !key.trim()}>{busy ? tg.checking : t.common.save}</button>{editing && <button type="button" className="secondary" disabled={busy} onClick={() => { setEditing(false); setKey(''); setError('') }}>{t.common.cancel}</button>}</form>}
    </div>
    <p className="hint">{tg.hint}</p>
    {error && <p className="error">{error}</p>}
  </div>
}

const item = (provider: 'codex' | 'claude' | 'gemini'): string => (providerLabels[provider])
// Gemini is hidden when creating an agent: the CLI's personal login was discontinued by Google. Gemini agents already created keep working.
const newAgentProviders = ['claude', 'codex'] as const

/** Project theme: shows only the chosen one; on click opens the list with each theme's colors. Applies immediately, for this project only. */
export function ThemePicker({ value, onChange, project = false }: { value: AppTheme | null; onChange(value: AppTheme | null): void; project?: boolean }): React.JSX.Element {
  const t = useT(), tp = t.settings.themePicker
  const [open, setOpen] = useState(false), root = React.useRef<HTMLDivElement>(null), button = React.useRef<HTMLButtonElement>(null), list = React.useRef<HTMLDivElement>(null)
  const box = useFloatingMenu(open, button)
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent): void => { if (!root.current?.contains(event.target as Node) && !list.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  useEscape(() => setOpen(false), open)
  const current = themes.find((theme) => theme.value === value)
  const face = (label: string, swatches?: readonly string[]): React.JSX.Element => <><span className="sw3">{swatches ? swatches.map((color) => <i key={color} style={{ background: color }} />) : <i className="auto" />}</span><span className="tn">{label}</span></>
  return <div className="f themepick" ref={root}><span>{tp.title}</span>
    <button ref={button} type="button" className="themetrigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>{face(current ? t.settings.themeNames[current.value] : tp.appDefault, current?.swatches)}<span className="chev">▾</span></button>
    {open && box && createPortal(<div ref={list} className="themelist floating-select-list" role="listbox" style={box} onClick={(event) => event.stopPropagation()} aria-label={project ? tp.projectAria : tp.appAria}>
      {project && <button type="button" role="option" aria-selected={value === null} className={value === null ? 'on' : ''} onClick={() => { onChange(null); setOpen(false) }}>{face(tp.appDefault)}</button>}
      {themes.map((theme) => <button type="button" role="option" aria-selected={value === theme.value} key={theme.value} className={value === theme.value ? 'on' : ''} onClick={() => { onChange(theme.value); setOpen(false) }}>{face(t.settings.themeNames[theme.value], theme.swatches)}</button>)}
    </div>, document.body)}
    <small className="hint">{project ? tp.projectHint : tp.appHint}</small>
  </div>
}


export function SettingsDialog({ profiles, settings, initialTab, close, changed, settingsChanged }: { profiles: AgentProfile[]; settings: AppSettings; initialTab?: 'general' | 'agents' | 'about'; close(): void; changed(): Promise<void>; settingsChanged(settings: AppSettings): void }): React.JSX.Element {
  const [tab, setTab] = useState<'agents' | 'skills' | 'mcp' | 'general' | 'shortcuts' | 'about' | 'tools'>(initialTab ?? 'general'), [editing, setEditing] = useState<AgentProfile | 'new'>(), [items, setItems] = useState(profiles), [statuses, setStatuses] = useState<Record<string, AgentProbe>>({}), [error, setError] = useState('')
  const appUpdate = useAppUpdate()
  const [messageSpacing, setMessageSpacing] = useState<MessageSpacing>(() => readMessageSpacing())
  const t = useT(), td = t.settings.dialog
  const voices: ReadonlyArray<{ value: VoiceModel; label: string }> = [{ value: 'small', label: td.voiceSmall }, { value: 'large-v3-turbo', label: td.voiceLarge }, { value: 'groq', label: td.voiceGroq }]
  const spacingOptions = messageSpacings.map((item) => ({ ...item, label: item.value === 'compact' ? td.spacingCompact : item.value === 'comfortable' ? td.spacingComfortable : td.spacingWide }))
  useEffect(() => setItems(profiles), [profiles])
  useEscape(close, !editing)
  const probeAll = (): void => { void window.gearmod.invoke('profiles:probe-all', undefined).then((all) => setStatuses(Object.fromEntries(all.map((probe) => [probe.profileId, probe])))).catch(() => undefined) }
  // An update that finished (here or in the background) changes the installed version: checks again.
  const updatesFinished = useTasks().filter((task) => task.key.startsWith('agent-update:') && task.state !== 'running').length
  const [updating, setUpdating] = useState<UpdatableProvider>()
  useEffect(() => { probeAll() }, [profiles, updatesFinished])
  // The update runs in a separate terminal: when returning to the window, checks the version again.
  useEffect(() => { window.addEventListener('focus', probeAll); return () => window.removeEventListener('focus', probeAll) }, [])
  const latest = useLatestVersions()
  const newer = (profile: AgentProfile): string | null => { const probe = statuses[profile.id], last = latest?.versions[profile.provider as 'claude' | 'codex' | 'gemini']; return probe?.installed && last && isOutdated(probe.version, last) ? last : null }
  const updatesPending = items.some((profile) => newer(profile))
  const save = async (patch: Partial<AppSettings>): Promise<void> => { try { setError(''); settingsChanged(await window.gearmod.invoke('settings:update', patch)) } catch (reason) { setError(plainError(reason)) } }
  const refresh = async (): Promise<void> => { await changed() }
  const [capacity, setCapacity] = useState<{ recommended: number; cores: number; memoryGb: number }>(), [limitDraft, setLimitDraft] = useState<string>()
  useEffect(() => { void window.gearmod.invoke('agents:capacity', undefined).then(setCapacity).catch(() => undefined) }, [])
  const limitValue = settings.execucoesSimultaneas ?? capacity?.recommended ?? 2
  const commitLimit = (): void => { const value = Math.round(Number(limitDraft)); setLimitDraft(undefined); if (limitDraft !== undefined && Number.isFinite(value) && value >= 1 && value !== limitValue) void save({ execucoesSimultaneas: Math.min(16, value) }) }
  return <div className="overlay" role="dialog" aria-label={t.common.settings}><div className="modal settings-dialog">
    <header><div><div className="eyebrow">{t.common.settings}</div><h2>GearMod</h2></div><button className="x" onClick={close} aria-label={t.common.close}>×</button></header>
    <div className="tabs" role="tablist" style={{ marginBottom: 14 }}>{([['general', td.tabGeneral], ['agents', td.tabAgents], ['skills', td.tabSkills], ['mcp', td.tabMcp], ['tools', td.tabTools], ['shortcuts', td.tabShortcuts], ['about', td.tabAbout]] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} className={`tab ${tab === value ? 'on' : ''}`} onClick={() => setTab(value)}>{label}{value === 'agents' && updatesPending && <i className="tab-dot" data-tip={td.agentUpdateTip} />}{value === 'about' && appUpdate?.available && <i className="tab-dot" data-tip={td.appUpdateTip} />}</button>)}</div>
    <div className="settings-dialog-body">{tab === 'agents' && <><p style={{ marginBottom: 12 }}>{td.agentsIntro}</p>
      <div className="stack" style={{ gap: 8 }}>{items.length === 0 && <div className="emptyBox">{td.noAgents}</div>}{items.map((profile) => { const probe = statuses[profile.id], state = !probe ? 'checking' : probe.authenticated ? 'on' : 'off'; return <div className="ck-line" key={profile.id}><span className="settings-agent-avatar tip" data-tip={!probe ? td.checkingConnection : probe.authenticated ? td.connected : probe.installed ? td.disconnectedNoLogin : td.disconnectedNotInstalled} aria-label={!probe ? td.checkingConnection : probe.authenticated ? td.connected : td.disconnected}><AgentIcon profile={profile} size="lg" tip={false} /><i className={`settings-agent-status ${state}`} aria-hidden="true" /></span><span className="t">{profile.label}<small>{item(profile.provider)}</small>{probe?.account && <small className="acct" data-tip={td.accountTip}>{probe.account}</small>}</span>{newer(profile) && <span className="agupdate" data-tip={td.versionTip(statuses[profile.id]?.version ?? '?', newer(profile) ?? '')}>{td.updateAvailable}<button type="button" className="linklike" onClick={() => setUpdating(profile.provider)}>{td.update}</button></span>}<span className="agtype" data-tip={td.usageTip}>{profile.scope}</span><button className="mini secondary" onClick={() => setEditing(profile)}>{t.common.edit}</button></div> })}</div>
      <button className="bigadd" onClick={() => setEditing('new')}>{td.addAgent}</button></>}
    {tab === 'skills' && <SkillsPanel scope="global" profiles={items} />}
    {tab === 'mcp' && <McpPanel scope="global" available={['claude', 'codex']} />}
    {tab === 'tools' && <StoragePanel />}
    {tab === 'shortcuts' && <ShortcutsPanel />}
    {tab === 'about' && <AboutPanel />}
    {tab === 'general' && <><div className="stack">
        <section className="cx-wfcard"><h4>{td.cardLook}</h4><ThemePicker value={settings.tema} onChange={(value) => { if (value) void save({ tema: value }) }} />
        <div className="f"><span>{t.settings.language}</span><Select label={t.settings.language} options={[...languages]} value={settings.idioma} onChange={(value) => void save({ idioma: value as AppLanguage })} /></div>
        <p className="hint">{t.settings.languageHint}</p>
        <div className="f"><span>{td.messageSpacing}</span><Select label={td.messageSpacing} options={spacingOptions} value={messageSpacing} onChange={(value) => { const spacing = value as MessageSpacing; setMessageSpacing(spacing); saveMessageSpacing(spacing) }} /></div>
        <p className="hint">{td.messageSpacingHint}</p></section>
        <section className="cx-wfcard"><h4>{td.cardBehavior}</h4><Switch style={{ marginRight: 0 }} checked={settings.notificacoes} onChange={(value) => void save({ notificacoes: value })}>{td.notifications}</Switch>
        <p className="hint">{td.notificationsHint}</p>
        <Switch style={{ marginRight: 0 }} checked={settings.retomarSozinho} onChange={(value) => void save({ retomarSozinho: value })}>{td.autoResume}</Switch>
        <p className="hint">{td.autoResumeHint}</p>
        <div className="f"><span>{td.concurrency}</span><input className="in" type="number" min={1} max={16} style={{ width: 80 }} value={limitDraft ?? limitValue} onChange={(event) => setLimitDraft(event.target.value)} onBlur={commitLimit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></div>
        {capacity && <p className="hint">{td.concurrencyHint(capacity.recommended, capacity.cores, capacity.memoryGb)}{settings.execucoesSimultaneas !== null && settings.execucoesSimultaneas !== capacity.recommended && <> <button type="button" className="linklike" onClick={() => void save({ execucoesSimultaneas: null })}>{td.concurrencyUseRecommended}</button></>}</p>}</section>
        <section className="cx-wfcard"><h4>{td.cardGit}</h4><Switch style={{ marginRight: 0 }} checked={settings.fotosGravatar} onChange={(value) => { setGravatarEnabled(value); void save({ fotosGravatar: value }) }}>{td.gitPhotos}</Switch>
        <p className="hint">{td.gitPhotosHint}</p></section>
        <section className="cx-wfcard"><DefaultCardTypes /></section>
        <section className="cx-wfcard"><h4>{td.cardVoice}</h4><div className="f"><span>{td.voice}</span><Select label={td.voice} options={[...voices]} value={settings.voz} onChange={(value) => void save({ voz: value as VoiceModel }).then(() => { dismissVoiceInstall(); notifyVoiceChanged() })} /></div>
        {settings.voz === 'groq' ? <GroqKeyField /> : <p className="hint">{td.voiceModelHint}</p>}</section>
      </div>{error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}</>}</div>
    {updating && <AgentUpdateDialog provider={updating} close={() => setUpdating(undefined)} />}
    {editing && <AgentDialog profile={editing === 'new' ? undefined : editing} close={() => setEditing(undefined)} changed={refresh} />}
  </div></div>
}
