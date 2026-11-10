import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { complexityDimensions, defaultComplexityLimits, type Approval, type Assessment, type Card, type CardHistory, type WorkflowKind } from '@gearmod/contracts'
import { AssessmentDialog, Dots } from './Assessment'
import { plainError } from './NoticeDialog'
import { useT } from './i18n'

type Limits = { simpleMax: number; mediumMax: number }

/** The project's limits between simple, medium and complex (falls back to the defaults while loading). */
function useLimits(projectId: string | undefined): Limits {
  const [limits, setLimits] = useState<Limits>(defaultComplexityLimits)
  useEffect(() => { if (projectId) void window.gearmod.invoke('workflow:get', { projectId }).then((state) => setLimits(state.config.limits)).catch(() => undefined) }, [projectId])
  return limits
}

/** Points bar: the three ranges (simple, medium, complex) and a marker where the card is. */
export function ScoreBar({ assessment, limits }: { assessment: Assessment; limits: Limits }): React.JSX.Element {
  const tb = useT().board
  const max = Math.max(complexityDimensions.reduce((sum, dimension) => sum + 3 * assessment.weights[dimension], 0), limits.mediumMax + 1, assessment.total)
  const at = (value: number): number => Math.min(100, Math.max(0, (value / max) * 100))
  return <div className="sbar" aria-label={`${assessment.total} / ${max}`}>
    <div className="sbar-track">
      <i className="simple" style={{ width: `${at(limits.simpleMax + 0.5)}%` }} />
      <i className="medium" style={{ width: `${at(limits.mediumMax + 0.5) - at(limits.simpleMax + 0.5)}%` }} />
      <i className="complex" style={{ flex: 1 }} />
      <b className={`sbar-mark ${assessment.level}`} style={{ left: `${at(assessment.total)}%` }}><span>{assessment.total}</span></b>
    </div>
    <div className="sbar-legend"><span>{tb.levelLabels.simple} 0–{limits.simpleMax}</span><span>{tb.levelLabels.medium} {limits.simpleMax + 1}–{limits.mediumMax}</span><span>{tb.levelLabels.complex} {limits.mediumMax + 1}+</span></div>
  </div>
}

const useHistory = (cardId: string): CardHistory | undefined => {
  const [history, setHistory] = useState<CardHistory>()
  useEffect(() => {
    const load = (): void => { void window.gearmod.invoke('history:get', { cardId }).then(setHistory).catch(() => undefined) }
    load()
    return window.gearmod.onRunEvent((event) => { if (['gearmod/card-updated', 'gearmod/run-completed'].includes(event.eventType)) load() })
  }, [cardId])
  return history
}

/** Opens the full Complexity and decisions window (needs the card). */
function useAssessmentDialog(cardId: string): { open(): void; dialog: React.ReactNode } {
  const [card, setCard] = useState<Card>()
  return {
    open: () => { void window.gearmod.invoke('cards:get', { cardId }).then(setCard).catch(() => undefined) },
    dialog: card ? createPortal(<AssessmentDialog card={card} close={() => setCard(undefined)} changed={() => undefined} />, document.body) : null
  }
}

/**
 * In the planning chat, when the agent proposes the flow: the score table, the points bar and the flow options.
 * The user picks the flow here (the agent's recommendation is marked); it replaces asking in the chat.
 */
export function WorkflowChoiceAsk({ approval, onDecided }: { approval: Approval; onDecided(approval: Approval): void }): React.JSX.Element {
  const all = useT(), tb = all.board, t = tb.assessment, w = all.chat.workflowChoice
  const cardId = approval.cardId ?? ''
  const history = useHistory(cardId), limits = useLimits(approval.projectId ?? undefined), details = useAssessmentDialog(cardId)
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [specKit, setSpecKit] = useState<{ enabled: boolean; reason: string | null }>({ enabled: true, reason: null })
  useEffect(() => { if (approval.projectId) void window.gearmod.invoke('speckit:availability', { projectId: approval.projectId }).then(setSpecKit).catch(() => undefined) }, [approval.projectId])
  const assessment = history?.assessments.at(-1)
  const proposed = { workflow: String(approval.payload.workflow ?? ''), method: approval.payload.method === 'native' || approval.payload.method === 'speckit' ? approval.payload.method : null }
  const reason = typeof approval.payload.reason === 'string' ? approval.payload.reason : ''
  const choose = async (workflow: WorkflowKind, method?: 'native' | 'speckit'): Promise<void> => {
    setBusy(`${workflow}:${method ?? ''}`); setError('')
    try { onDecided(await window.gearmod.invoke('approvals:decide', { id: approval.id, approve: true, choice: { workflow, ...(method ? { method } : {}) } })) } catch (reason) { setError(plainError(reason)); setBusy('') }
  }
  const options: Array<{ key: string; workflow: WorkflowKind; method?: 'native' | 'speckit'; title: string; about: string; off?: string }> = [
    { key: 'light', workflow: 'light', title: t.flowTitle.light, about: t.flowAbout.light },
    { key: 'spec', workflow: 'spec', title: t.flowTitle.spec, about: t.flowAbout.spec },
    { key: 'native', workflow: 'sdd', method: 'native', title: `${t.flowTitle.sdd} · ${t.methodNames.native}`, about: t.flowAbout.sdd },
    { key: 'speckit', workflow: 'sdd', method: 'speckit', title: `${t.flowTitle.sdd} · ${t.methodNames.speckit}`, about: t.flowAbout.sdd, off: specKit.enabled ? undefined : specKit.reason ?? '' }
  ]
  const isProposed = (option: typeof options[number]): boolean => option.workflow === proposed.workflow && (option.workflow !== 'sdd' || option.method === proposed.method)
  return <div className="cask wfchoice">
    <div className="cgprop-h"><b>{w.title}</b><small>{w.subtitle}</small></div>
    {assessment ? <>
      <div className="wfc-score"><div className={`cx-score ${assessment.level}`}><b>{assessment.total}</b><span>{tb.levelLabels[assessment.level]}{assessment.preliminary ? ` · ${t.preliminary}` : ''}</span></div><ScoreBar assessment={assessment} limits={limits} /></div>
      <table className="cx-table wfc-table"><thead><tr><th>{t.dimension}</th><th>{t.score}</th><th>{t.points}</th><th>{t.justification}</th></tr></thead><tbody>
        {complexityDimensions.map((dimension) => <tr key={dimension}><td>{tb.dimensionLabels[dimension]}</td><td><Dots value={assessment.scores[dimension]} /></td><td>{assessment.scores[dimension] * assessment.weights[dimension]}<small> ×{assessment.weights[dimension]}</small></td><td>{assessment.justifications[dimension] || <span className="cx-muted">—</span>}</td></tr>)}
      </tbody></table>
    </> : <p className="cx-muted">{all.common.loading}</p>}
    {reason && <p className="cgprop-msg">{reason}</p>}
    <div className="wfc-opts" role="group" aria-label={t.cardFlow}>{options.map((option) => <button type="button" key={option.key} className={`cx-opt ${isProposed(option) ? 'rec' : ''}`} disabled={Boolean(busy) || option.off !== undefined} data-tip={option.off || undefined} onClick={() => void choose(option.workflow, option.method)}>
      <span className="cx-opt-t">{busy === `${option.workflow}:${option.method ?? ''}` ? <span className="spin sm" /> : null}{option.title}{isProposed(option) && <em>{t.recommendedTag}</em>}</span><small>{option.about}</small>
    </button>)}</div>
    {error && <p className="error">{error}</p>}
    <div className="cgrow"><span className="grow1" /><button type="button" className="mini secondary" onClick={details.open}>{w.seeDetails}</button></div>
    {details.dialog}
  </div>
}

/** Beside the planning chat, under the decisions: the score, the recommended and the chosen flow, and a link to the details. */
export function ComplexitySide({ cardId, projectId, history }: { cardId: string; projectId: string; history?: CardHistory }): React.JSX.Element | null {
  const all = useT(), tb = all.board, t = tb.assessment, w = all.chat.workflowChoice
  const limits = useLimits(projectId), details = useAssessmentDialog(cardId)
  const assessment = history?.assessments.at(-1)
  if (!history || !assessment) return null
  const chosen = history.workflow
  const flowName = (workflow: WorkflowKind, method?: string | null): string => workflow === 'sdd' && (method === 'native' || method === 'speckit') ? `${t.flowTitle.sdd} · ${t.methodNames[method]}` : t.flowTitle[workflow]
  return <aside className="changes cxside" aria-label={w.complexity}>
    <div className="ch-head"><span className="ch-title">{w.complexity}</span><span className={`cx-badge ${assessment.level}`}><b>{assessment.total}</b>{tb.levelLabels[assessment.level]}</span></div>
    <ScoreBar assessment={assessment} limits={limits} />
    <div className="cxside-rows">
      <span>{t.recommendedByAgent}</span><b>{flowName(assessment.workflow, assessment.workflow === 'sdd' ? history.recommendedSddMethod : null)}</b>
      <span>{t.chosenByYou}</span>{chosen ? <b className={chosen === assessment.workflow ? 'ok' : 'diff'}>{flowName(chosen, history.sddMethod)}</b> : <em>{t.notChosenYet}</em>}
    </div>
    <button type="button" className="linklike cxside-more" onClick={details.open}>{w.seeMore}</button>
    {details.dialog}
  </aside>
}
