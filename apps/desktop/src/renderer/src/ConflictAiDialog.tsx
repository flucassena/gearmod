import React from 'react'
import { defaultPermissionMode, providerLabels, type AgentProfile, type Effort } from '@gearmod/contracts'
import { AgentIcon } from './AgentIcon'
import { ModelMenu, useAgentConfig } from './ModelMenu'
import { Select } from './Select'
import { useEscape } from './useEscape'
import { useT } from './i18n'

/** Agent and model for "Resolve with AI": the run goes on in a chat of its own (listed in Chats), nothing opens on screen. */
export function ConflictAiDialog({ file, profiles, unsaved, close, start }: { file: string; profiles: AgentProfile[]; unsaved: boolean; close(): void; start(config: { profileId: string; model: string | null; effort: Effort | null }): void }): React.JSX.Element {
  const { common, git: { conflicts: t } } = useT()
  const state = useAgentConfig('', 'execution', profiles)
  useEscape(close)
  const config = state.config
  return <div className="overlay" role="dialog" aria-label={t.aiResolve}><div className="modal" style={{ width: 'min(460px,100%)' }}>
    <header><div><div className="eyebrow">{t.aiResolve}</div><h2>{file}</h2></div><button className="x" onClick={close} aria-label={common.close}>×</button></header>
    <div className="stack" style={{ gap: 10, marginBottom: 14 }}>
      <p className="hint" style={{ margin: 0 }}>{t.aiExplain}</p>
      <div className="f"><span>{common.agent}</span><Select label={common.agent} options={profiles.map((item) => ({ value: item.id, label: item.label, icon: <AgentIcon profile={item} tip={false} />, sub: providerLabels[item.provider] }))} value={config?.profileId ?? ''} onChange={(value) => { const next = profiles.find((item) => item.id === value); if (next) void state.update({ profileId: next.id, model: null, effort: null, mode: defaultPermissionMode(next.provider, 'execution') }) }} /></div>
      <div className="f"><span>{t.aiModel}</span><ModelMenu profiles={profiles} purpose="execution" state={state} noAgent field /></div>
      {unsaved && <p className="cx-note warn" role="status">{t.aiUnsaved}</p>}
      {state.error && <p className="error">{state.error}</p>}
    </div>
    <div className="actions"><button type="button" className="secondary" onClick={close}>{common.cancel}</button><button type="button" disabled={!config} onClick={() => config && start({ profileId: config.profileId, model: config.model, effort: config.effort })}>{t.aiStart}</button></div>
  </div></div>
}
