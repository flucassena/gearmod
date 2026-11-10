import React from 'react'
import { defaultPermissionMode, providerLabels, type AgentConfig, type AgentProfile } from '@gearmod/contracts'
import { AgentIcon } from './AgentIcon'
import { ModelMenu, useAgentConfig } from './ModelMenu'
import { Select } from './Select'
import { useEscape } from './useEscape'
import { useT } from './i18n'

/** Picks agent, model and effort before opening a project chat (like Start on a card). */
export function AgentPickDialog({ eyebrow, title, profiles, close, start }: { eyebrow: string; title: string; profiles: AgentProfile[]; close(): void; start(config: AgentConfig): void }): React.JSX.Element {
  const { board: tb, common } = useT(), t = tb.start
  const state = useAgentConfig('', 'execution', profiles)
  useEscape(close)
  return <div className="overlay" role="dialog" aria-label={title}><div className="modal" style={{ width: 'min(480px,100%)' }}>
    <header><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div><button className="x" onClick={close} aria-label={common.close}>×</button></header>
    <div className="stack" style={{ gap: 10, marginBottom: 14 }}>
      <div className="f"><span>{common.agent}</span><Select label={common.agent} options={profiles.map((item) => ({ value: item.id, label: item.label, icon: <AgentIcon profile={item} tip={false} />, sub: providerLabels[item.provider] }))} value={state.config?.profileId ?? ''} onChange={(value) => { const next = profiles.find((item) => item.id === value); if (next) void state.update({ profileId: next.id, model: null, effort: null, mode: defaultPermissionMode(next.provider, 'execution') }) }} /></div>
      <div className="f"><span>{t.modelAndEffort}</span><ModelMenu profiles={profiles} purpose="execution" state={state} noAgent field /></div>
    </div>
    {state.error && <p className="error">{state.error}</p>}
    <div className="actions"><button type="button" className="secondary" onClick={close}>{common.cancel}</button><button type="button" disabled={!state.config} onClick={() => { if (state.config) start(state.config) }}>{t.startButton}</button></div>
  </div></div>
}
