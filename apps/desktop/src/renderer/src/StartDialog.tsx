import { providerLabels } from '@gearmod/contracts'
import React, { useEffect, useState } from 'react'
import { defaultPermissionMode, permissionModes, type AgentConfig, type AgentProfile, type Card } from '@gearmod/contracts'
import { AgentIcon } from './AgentIcon'
import { CheckIcon } from './icons'
import { ModelMenu, useAgentConfig, permissionModeText } from './ModelMenu'
import { Select } from './Select'
import { useEscape } from './useEscape'
import { plainError } from './NoticeDialog'
import { useT } from './i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { AssessmentDialog } from './Assessment'

/**
 * Start execution (prototype): agent · model · effort and "Run as?". Start approves the current plan and moves the card to Doing.
 * `retry`: the last run failed (e.g. agent without a token): the agent is not locked; choosing another one restarts the stage chat.
 */
export function StartDialog({ card, purpose, profiles, retry, close, start }: { card: Card; purpose: 'execution' | 'test'; profiles: AgentProfile[]; retry?: { error: string }; close(): void; start(config: AgentConfig, baseBranch?: string, replaceAgent?: boolean): Promise<void> }): React.JSX.Element {
  const { board: tb, common } = useT(), t = tb.start
  const [lockedId, setLockedId] = useState<string>()
  useEffect(() => { void window.gearmod.invoke('chats:list', { projectId: card.projectId, cardId: card.id }).then((items) => setLockedId((items.find((item) => item.purpose === purpose) ?? (card.workflow === 'light' ? items.find((item) => item.purpose === 'planning') : undefined))?.profileId)).catch(() => undefined) }, [card.id, card.projectId, card.workflow, purpose])
  const locked = retry ? undefined : lockedId
  const state = useAgentConfig(card.id, purpose, profiles, locked)
  const stageAgent = profiles.find((item) => item.id === lockedId), replaceAgent = Boolean(retry && lockedId && state.config && state.config.profileId !== lockedId)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  // Decisions still waiting for the user: asked before the implementation starts.
  const [gate, setGate] = useState<string[]>(), [reviewing, setReviewing] = useState(false)
  // Worktree: new (default) or another project card's (only if this card does not have one yet).
  const [others, setOthers] = useState<Array<{ cardId: string; title: string; branch: string }>>([]), [from, setFrom] = useState('new')
  // Also the ones the user made by hand (a detached HEAD has no branch to work on, so it is left out).
  const [externals, setExternals] = useState<Array<{ path: string; branch: string | null }>>([])
  useEffect(() => { if (!card.workspace) void window.gearmod.invoke('worktrees:candidates', { cardId: card.id }).then(setOthers).catch(() => undefined) }, [card.id, card.workspace])
  useEffect(() => { if (!card.workspace) void window.gearmod.invoke('worktrees:options', { projectId: card.projectId }).then((found) => setExternals(found.external.filter((item) => item.branch))).catch(() => undefined) }, [card.projectId, card.workspace])
  const [branches, setBranches] = useState<{ branches: string[]; current: string | null; selected: string | null; locked: boolean }>(), [branch, setBranch] = useState('')
  useEffect(() => { void window.gearmod.invoke('cards:branches', { cardId: card.id }).then((info) => { setBranches(info); setBranch(info.selected ?? info.current ?? info.branches[0] ?? '') }).catch(() => undefined) }, [card.id])
  useEscape(close)
  const go = (): void => { if (!state.config) return; setBusy(true); setError(''); const config = state.config; void (from === 'new' ? Promise.resolve() : from.startsWith('ext:') ? window.gearmod.invoke('worktrees:adopt', { cardId: card.id, path: from.slice(4) }).then(() => undefined) : window.gearmod.invoke('worktrees:link', { cardId: card.id, fromCardId: from }).then(() => undefined)).then(() => start(config, from === 'new' && branches && !branches.locked && branch ? branch : undefined, replaceAgent)).catch((reason: unknown) => { setError(plainError(reason)); setBusy(false) }) }
  const tryStart = async (): Promise<void> => {
    if (purpose === 'execution') {
      const open = await window.gearmod.invoke('history:get', { cardId: card.id }).then((history) => history.decisions.filter((item) => item.status === 'proposed').map((item) => `D${String(item.number).padStart(3, '0')} · ${item.statement}`)).catch(() => [])
      if (open.length) { setGate(open); return }
    }
    go()
  }
  const acceptAll = async (): Promise<void> => {
    setGate(undefined); setBusy(true); setError('')
    try {
      const history = await window.gearmod.invoke('history:get', { cardId: card.id })
      for (const item of history.decisions.filter((decision) => decision.status === 'proposed')) await window.gearmod.invoke('history:set-decision', { decisionId: item.id, status: 'approved' })
    } catch (reason) { setError(plainError(reason)); setBusy(false); return }
    setBusy(false); go()
  }
  const profile = profiles.find((item) => item.id === state.config?.profileId)
  const modes = profile ? permissionModes[profile.provider].filter((item) => item.purposes.includes(purpose)).map((item) => ({ ...item, ...permissionModeText(profile.provider, item) })) : []
  return <div className="overlay" role="dialog" aria-label={purpose === 'test' ? t.startTest : t.startExecution}><div className="modal" style={{ width: 'min(480px,100%)' }}>
    <header><div><div className="eyebrow">{purpose === 'test' ? t.startTest : t.startExecution}</div><h2>{card.title || tb.newCard}</h2></div><button className="x" onClick={close} aria-label={common.close}>×</button></header>
    <div className="stack" style={{ gap: 10, marginBottom: 14 }}>
      <div className="f"><span>{common.agent}</span><Select label={common.agent} disabled={Boolean(locked)} options={profiles.map((item) => ({ value: item.id, label: item.label, icon: <AgentIcon profile={item} tip={false} />, sub: providerLabels[item.provider] }))} value={state.config?.profileId ?? ''} onChange={(value) => { const next = profiles.find((item) => item.id === value); if (next) void state.update({ profileId: next.id, model: null, effort: null, mode: defaultPermissionMode(next.provider, purpose) }) }} /></div>
      {retry && <p className="cx-note warn" role="status">{t.retryNote(retry.error)}</p>}
      {locked && <p className="hint">{t.agentLocked(profile?.label ?? '')}</p>}
      {replaceAgent && stageAgent && <p className="hint">{t.switchResets(stageAgent.label)}</p>}
      <div className="f"><span>{t.modelAndEffort}</span><ModelMenu profiles={profiles} purpose={purpose} state={state} noAgent field /></div>
      {from === 'new' && branches && branches.branches.length > 0 && <div className="f"><span>{t.baseBranch}</span>
        {branches.locked ? <p className="hint" style={{ margin: 0 }}>{t.baseLocked(card.workspace?.baseRef ?? branches.selected ?? '')}</p>
          : <><Select label={t.baseBranch} up options={branches.branches.map((name) => ({ value: name, label: name, sub: name === branches.current ? t.current : '' }))} value={branch} onChange={setBranch} /><small className="hint">{t.newBranchFrom(branch)}</small></>}</div>}
      {others.length + externals.length > 0 && <div className="f"><span>Worktree</span><Select label="Worktree" up options={[{ value: 'new', label: t.createNew, sub: t.isolated }, ...others.map((item) => ({ value: item.cardId, label: t.useOneOf(item.title), sub: item.branch })), ...externals.map((item) => ({ value: `ext:${item.path}`, label: tb.newCardDialog.useExisting(item.branch ?? ''), sub: item.path.split(/[\\/]/).filter(Boolean).pop() ?? item.path }))]} value={from} onChange={setFrom} /><small className="hint">{from === 'new' ? t.ownWorktree : from.startsWith('ext:') ? tb.newCardDialog.hintExternal : t.otherWorktree}</small></div>}
    </div>
    <div className="sectitle" style={{ marginBottom: 8 }}>{purpose === 'test' ? t.testHow : t.runHow}</div>
    <div className="stack" style={{ gap: 8 }}>{modes.map((item) => <button type="button" key={item.id} disabled={item.needsApprovalUi} data-tip={item.needsApprovalUi ? t.needsApprovalUi : undefined} className={`startopt ${state.config?.mode === item.id ? 'sel' : ''}`} onClick={() => void state.update({ mode: item.id })}><span className="mo-t"><b>{item.label}</b>{item.recommended && <em>{t.recommended}</em>}{item.dangerous && <em>{t.careful}</em>}<small>{item.description}</small></span><span className="mo-r">{state.config?.mode === item.id && <CheckIcon />}</span></button>)}</div>
    {(error || state.error) && <p className="error" style={{ marginTop: 10 }}>{error || state.error}</p>}
    <div className="actions"><button type="button" className="secondary" onClick={close}>{common.cancel}</button><button type="button" disabled={busy || !state.config} onClick={() => void tryStart()}>{busy ? t.starting : t.startButton}</button></div>
    {gate && !reviewing && <ConfirmDialog eyebrow={t.decisionsEyebrow} title={t.decisionsTitle(gate.length)} text={t.decisionsText(gate)} ok={t.acceptAllAndStart} secondary={{ label: t.reviewDecisions, run: () => setReviewing(true) }} cancel={() => setGate(undefined)} confirm={() => void acceptAll()} />}
    {reviewing && <AssessmentDialog card={card} initialTab="decisoes" close={() => { setReviewing(false); setGate(undefined) }} changed={() => undefined} />}
  </div></div>
}