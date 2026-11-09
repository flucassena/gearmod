import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { defaultPermissionMode, type PermissionModeInfo, type AgentConfig, type AgentOptions, type AgentProfile, type AgentPurpose, type Effort } from '@gearmod/contracts'
import { AgentIcon } from './AgentIcon'
import { CheckIcon } from './icons'
import { useFitInView } from './useFitInView'
import { useEscape } from './useEscape'
import { plainError } from './NoticeDialog'
import { tr, useT } from './i18n'

/** Effort labels in the current language (read at time of use, so they follow language changes). */
export const effortLabel = new Proxy({} as Record<Effort, string>, { get: (_target, key) => tr().chat.effort[key as Effort] })

/** Label and description of a permission mode in the current language; contracts only carries the Portuguese text. */
export function permissionModeText(provider: AgentProfile['provider'], mode: PermissionModeInfo): { label: string; description: string } {
  const found = (tr().chat.permissionModes[provider] as Record<string, { label: string; description: string }>)[mode.id]
  return found ?? { label: mode.label, description: mode.description }
}

/** Card agent configuration (agent, model, effort and mode) for planning or executing; saved on the card at each change. */
export function useAgentConfig(cardId: string, purpose: AgentPurpose, profiles: AgentProfile[], lockedProfileId?: string): { config?: AgentConfig; options?: AgentOptions; update(patch: Partial<AgentConfig>): Promise<void>; error: string; touched: boolean } {
  const [config, setConfig] = useState<AgentConfig>(), [loaded, setLoaded] = useState<{ profileId: string; options: AgentOptions }>(), [error, setError] = useState('')
  const profileId = config?.profileId, profileKey = profiles.map((item) => item.id).join(',')
  // The models belong to one agent: right after a switch, the previous agent's list must not be used (it would pick e.g. "sonnet" for a GPT agent).
  const options = loaded && loaded.profileId === profileId ? loaded.options : undefined
  const latest = useRef(profiles); latest.current = profiles
  const [touched, setTouched] = useState(false)
  const switchedFrom = useRef<{ rank: number; effort: Effort | null } | null>(null)
  useEffect(() => {
    let alive = true
    if (!cardId) {
      const first = latest.current.find((item) => item.id === lockedProfileId) ?? latest.current[0]
      if (first) setConfig((current) => current ?? { profileId: first.id, model: null, effort: null, mode: defaultPermissionMode(first.provider, purpose) })
      return () => { alive = false }
    }
    void window.gearmod.invoke('cards:agent-config', { cardId }).then((saved) => {
      if (!alive) return
      const list = latest.current, stored = saved[purpose], first = list.find((item) => item.id === lockedProfileId) ?? list.find((item) => item.id === stored?.profileId) ?? list[0]
      if (!first) return
      setConfig(stored && stored.profileId === first.id ? stored : { profileId: first.id, model: null, effort: null, mode: defaultPermissionMode(first.provider, purpose) })
    }).catch((reason: unknown) => setError(plainError(reason)))
    return () => { alive = false }
  }, [cardId, purpose, lockedProfileId, profileKey])
  useEffect(() => {
    if (!profileId) return
    let alive = true
    void window.gearmod.invoke('agents:options', { profileId }).then((value) => { if (alive) setLoaded({ profileId, options: value }) }).catch(() => { if (alive) setLoaded({ profileId, options: { models: [], mostUsed: { planning: null, execution: null, test: null } } }) })
    return () => { alive = false }
  }, [profileId])
  // With no saved choice, shows the default: the most used or the recommended one for the purpose.
  useEffect(() => {
    if (!config || !options) return
    // Saved model that this agent does not have (e.g. left over from another agent): goes back to choosing the default.
    if (config.model !== null && options.models.length && !options.models.some((item) => item.id === config.model)) { setConfig({ ...config, model: null, effort: null }); return }
    if (config.model !== null || config.effort !== null) return
    const from = switchedFrom.current
    if (from && options.models.length) {
      // Agent just switched: pick the equivalent tier (same position in the list) and keep the effort when supported.
      switchedFrom.current = null
      const target = options.models[Math.min(Math.round(from.rank * (options.models.length - 1)), options.models.length - 1)]!
      setConfig({ ...config, model: target.id, effort: target.efforts.includes(from.effort as Effort) ? from.effort : target.defaultEffort })
      return
    }
    const used = options.mostUsed[purpose], recommended = options.models.find((model) => model.recommendedFor.includes(purpose))
    const model = used?.model ?? recommended?.id ?? null
    if (model) setConfig({ ...config, model, effort: used?.effort ?? options.models.find((item) => item.id === model)?.defaultEffort ?? null })
  }, [config, options, purpose])
  const update = useCallback(async (patch: Partial<AgentConfig>): Promise<void> => {
    if (!config) return
    if (patch.profileId && patch.profileId !== config.profileId && options && config.model) {
      const index = options.models.findIndex((item) => item.id === config.model)
      switchedFrom.current = index >= 0 ? { rank: options.models.length > 1 ? index / (options.models.length - 1) : 0, effort: config.effort } : null
    }
    const next = { ...config, ...patch }
    if (!cardId) { setTouched(true); setConfig(next); return }
    try { setError(''); await window.gearmod.invoke('cards:set-agent-config', { cardId, purpose, config: next }); setConfig(next) } catch (reason) { setError(plainError(reason)) }
  }, [cardId, config, options, purpose])
  return { config, options, update, error, touched }
}

/**
 * Prototype model menu (`.mmbtn` + `.mmpop`): list of models, and the Agent and Effort submenus.
 * `field` = editor version (shows the agent name); `noAgent` = the agent is chosen in another field.
 */
export function ModelMenu({ profiles, purpose, state, noAgent = false, field = false, lockProfile = false, onLockedPick }: { profiles: AgentProfile[]; purpose: AgentPurpose; state: ReturnType<typeof useAgentConfig>; noAgent?: boolean; field?: boolean; lockProfile?: boolean; onLockedPick?(profile: AgentProfile): void }): React.JSX.Element {
  const t = useT(), m = t.chat.model
  const { config, options, update, error } = state
  const [open, setOpen] = useState(false), [sub, setSub] = useState<'agent' | 'effort' | null>(null), [pos, setPos] = useState<{ right: number; bottom?: number; top?: number; maxHeight?: number }>(), [subPos, setSubPos] = useState<React.CSSProperties>()
  const button = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null), row = useRef<HTMLButtonElement | null>(null), wrap = useRef<HTMLDivElement>(null), subBox = useRef<HTMLDivElement>(null)
  useFitInView(pop, open); useFitInView(subBox, open && sub !== null)
  useLayoutEffect(() => {
    if (!open || !button.current) return
    const rect = button.current.getBoundingClientRect()
    // Field: opens downward and flips upward when space is lacking, always with limited height so it is not cut off by the window.
    const below = window.innerHeight - rect.bottom - 16, above = rect.top - 16, flip = field && below < 260 && above > below
    setPos({ right: window.innerWidth - rect.right, ...(field && !flip ? { top: rect.bottom + 8, maxHeight: below } : { bottom: window.innerHeight - rect.top + 8, ...(field ? { maxHeight: above } : {}) }) })
  }, [open, field])
  useLayoutEffect(() => {
    if (!open || !sub || !pop.current || !row.current) { setSubPos(undefined); return }
    const popRect = pop.current.getBoundingClientRect(), rowRect = row.current.getBoundingClientRect(), width = 300
    setSubPos({ ...(field ? { top: rowRect.top - 6 } : { bottom: window.innerHeight - rowRect.bottom - 6 }), ...(popRect.left - 6 - width >= 8 ? { right: window.innerWidth - popRect.left + 6 } : { left: popRect.right + 6 }) })
  }, [open, sub, field])
  useEffect(() => {
    if (!open) return
    const close = (event: Event): void => { if (!wrap.current?.contains(event.target as Node)) { setOpen(false); setSub(null) } }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  useEscape(() => { setOpen(false); setSub(null) }, open)
  const profile = profiles.find((item) => item.id === config?.profileId)
  if (!config || !profile) return <span className="hint">{m.noAgent}</span>
  const used = options?.mostUsed[purpose]
  const modelBadges = (id: string, recommended: boolean): React.ReactNode => <>{recommended && <em>{m.recommended}</em>}{used?.model === id && <em className="used">{m.mostUsed}</em>}</>
  const model = options?.models.find((item) => item.id === config.model)
  const efforts = model?.efforts ?? []
  return <div className="mm" ref={wrap}>
    <button type="button" ref={button} className={`mmbtn ${field ? 'field' : ''} ${open ? 'on' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open); setSub(null) }}>{!noAgent && <AgentIcon profile={profile} size="sm" tip={false} />}{field && !noAgent && <span className="mag">{profile.label}</span>}<span className="mname">{model?.label ?? config.model ?? m.defaultModel}</span>{config.effort && <span className="meff">{effortLabel[config.effort]}</span>}{field && <span className="chev">▾</span>}</button>
    {open && pos && <div className="mmpop" ref={pop} role="menu" style={{ right: pos.right, bottom: pos.bottom, top: pos.top, maxHeight: field ? pos.maxHeight : undefined, overflowY: field ? 'auto' : undefined }}>
      <button type="button" role="menuitem" className="mmi" onClick={() => void update({ model: null, effort: null })}><span>{m.agentDefault}</span><small>{config.model === null ? <CheckIcon /> : ''}</small></button>
      {options?.models.map((item, index) => <button type="button" role="menuitem" key={item.id} className="mmi" onClick={() => void update({ model: item.id, effort: item.efforts.includes(config.effort as Effort) ? config.effort : item.defaultEffort })}><span>{item.label}{modelBadges(item.id, item.recommendedFor.includes(purpose))}</span><small>{config.model === item.id ? <CheckIcon /> : index + 1}</small></button>)}
      {options && !options.models.length && <p className="mmnote">{m.listFailed(options.error)}</p>}
      <div className="mmsep" />
      {!noAgent && <button type="button" role="menuitem" ref={sub === 'agent' ? row : undefined} className={`mmi sub ${sub === 'agent' ? 'mmact' : ''}`} onClick={() => setSub(sub === 'agent' ? null : 'agent')}><span>{m.agent}</span><small>{profile.label} ›</small></button>}
      {efforts.length > 0 && <button type="button" role="menuitem" ref={sub === 'effort' ? row : undefined} className={`mmi sub ${sub === 'effort' ? 'mmact' : ''}`} onClick={() => setSub(sub === 'effort' ? null : 'effort')}><span>{m.effort}</span><small>{config.effort ? effortLabel[config.effort] : m.default} ›</small></button>}
    </div>}
    {open && sub === 'effort' && subPos && <div className="mmpop mmsub" ref={subBox} style={subPos}><p className="mmnote">{m.effortNote}</p>{efforts.map((item) => <button type="button" key={item} className="mmi" onClick={() => void update({ effort: item })}><span>{effortLabel[item]}{used?.model === config.model && used.effort === item && <em className="used">{m.mostUsed}</em>}{model?.defaultEffort === item && <em>{m.recommended}</em>}</span><small>{config.effort === item && <CheckIcon />}</small></button>)}</div>}
    {open && sub === 'agent' && subPos && <div className="mmpop mmsub" ref={subBox} style={subPos}>{lockProfile && <p className="mmnote">{m.lockedNote(profile.label)}</p>}{profiles.map((item) => <button type="button" key={item.id} className="mmi" onClick={() => { setSub(null); if (lockProfile && item.id !== profile.id) { setOpen(false); onLockedPick?.(item); return } void update({ profileId: item.id, model: null, effort: null, mode: defaultPermissionMode(item.provider, purpose) }) }}><span className="mmag"><AgentIcon profile={item} size="sm" tip={false} />{item.label}</span><small>{item.id === profile.id && <CheckIcon />}</small></button>)}</div>}
    {error && <small className="error">{error}</small>}
  </div>
}
