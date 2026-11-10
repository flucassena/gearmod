import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { complexityDimensions, defaultComplexityLimits, type Approval, type Assessment, type Card, type CardHistory, type WorkflowKind } from '@gearmod/contracts'
import { AssessmentDialog, Dots, type Tab } from './Assessment'
import { ConfirmDialog } from './ConfirmDialog'
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

/** Opens the full Complexity and decisions window (needs the card), on the given tab. */
export function useAssessmentDialog(cardId: string, tab?: Tab): { open(): void; dialog: React.ReactNode } {
  const [card, setCard] = useState<Card>()
  return {
    open: () => { void window.gearmod.invoke('cards:get', { cardId }).then(setCard).catch(() => undefined) },
    dialog: card ? createPortal(<AssessmentDialog card={card} close={() => setCard(undefined)} changed={() => undefined} initialTab={tab} />, document.body) : null
  }
}

/** Flow proposals the user minimized to keep talking (kept while the app is open; a newer proposal opens again). */
const minimized = new Set<string>()

type Flow = { workflow: string; method: string | null }
type Texts = ReturnType<typeof useT>['board']['assessment']
const flowTitle = (t: Texts, flow: Flow): string => flow.workflow === 'sdd' && (flow.method === 'native' || flow.method === 'speckit') ? `${t.flowTitle.sdd} · ${t.methodNames[flow.method]}` : flow.workflow === 'light' || flow.workflow === 'spec' || flow.workflow === 'sdd' ? t.flowTitle[flow.workflow] : flow.workflow
const sameFlow = (a: Flow, b: Flow): boolean => a.workflow === b.workflow && (a.workflow !== 'sdd' || a.method === b.method)

/** Score, points bar and the table of the six dimensions. */
function ScoreTable({ assessment, limits }: { assessment: Assessment; limits: Limits }): React.JSX.Element {
  const tb = useT().board, t = tb.assessment
  return <>
    <div className="wfc-score"><div className={`cx-score ${assessment.level}`}><b>{assessment.total}</b><span>{tb.levelLabels[assessment.level]}{assessment.preliminary ? ` · ${t.preliminary}` : ''}</span></div><ScoreBar assessment={assessment} limits={limits} /></div>
    <table className="cx-table wfc-table"><thead><tr><th>{t.dimension}</th><th>{t.score}</th><th>{t.points}</th><th>{t.justification}</th></tr></thead><tbody>
      {complexityDimensions.map((dimension) => <tr key={dimension}><td>{tb.dimensionLabels[dimension]}</td><td><Dots value={assessment.scores[dimension]} /></td><td>{assessment.scores[dimension] * assessment.weights[dimension]}<small> ×{assessment.weights[dimension]}</small></td><td>{assessment.justifications[dimension] || <span className="cx-muted">—</span>}</td></tr>)}
    </tbody></table>
  </>
}

/** Collapsed flow card: title, level, the recommended (and chosen) flow as chips and the expand button on the right. */
function FlowBar({ title, assessment, recommended, chosen, open, toggle }: { title: string; assessment?: Assessment; recommended?: string; chosen?: { title: string; differs: boolean }; open: boolean; toggle(): void }): React.JSX.Element {
  const all = useT(), tb = all.board, w = all.chat.workflowChoice
  return <div className="wfc-mini">
    <b>{title}</b>
    {assessment && <span className={`cx-badge ${assessment.level}`}><b>{assessment.total}</b>{tb.levelLabels[assessment.level]}</span>}
    {recommended && <span className="wfc-chip">{w.recommended(recommended)}</span>}
    {chosen && <span className={`wfc-chip chosen ${chosen.differs ? 'diff' : ''}`}>{w.chosen(chosen.title)}</span>}
    <button type="button" className="ibtn wfc-toggle" title={open ? w.collapse : w.expand} aria-label={open ? w.collapse : w.expand} aria-expanded={open} onClick={toggle}><svg viewBox="0 0 24 24" className="gico"><path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></svg></button>
  </div>
}

/**
 * In the planning chat, when the agent proposes the flow: the score table, the points bar and the flow options.
 * The user picks the flow here (the agent's recommendation is marked) and confirms; it replaces asking in the chat.
 */
export function WorkflowChoiceAsk({ approval, onDecided }: { approval: Approval; onDecided(approval: Approval): void }): React.JSX.Element {
  const all = useT(), tb = all.board, t = tb.assessment, w = all.chat.workflowChoice
  const cardId = approval.cardId ?? ''
  const history = useHistory(cardId), limits = useLimits(approval.projectId ?? undefined), details = useAssessmentDialog(cardId)
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [small, setSmall] = useState(() => minimized.has(approval.id))
  const minimize = (value: boolean): void => { if (value) minimized.add(approval.id); else minimized.delete(approval.id); setSmall(value) }
  const [specKit, setSpecKit] = useState<{ enabled: boolean; reason: string | null }>({ enabled: true, reason: null })
  useEffect(() => { if (approval.projectId) void window.gearmod.invoke('speckit:availability', { projectId: approval.projectId }).then(setSpecKit).catch(() => undefined) }, [approval.projectId])
  const assessment = history?.assessments.at(-1)
  const proposed: Flow = { workflow: String(approval.payload.workflow ?? ''), method: approval.payload.method === 'native' || approval.payload.method === 'speckit' ? approval.payload.method : null }
  const reason = typeof approval.payload.reason === 'string' ? approval.payload.reason : ''
  type Option = { key: string; workflow: WorkflowKind; method?: 'native' | 'speckit'; title: string; about: string; off?: string }
  const [confirming, setConfirming] = useState<Option>()
  const choose = async (option: Option): Promise<void> => {
    setConfirming(undefined); setBusy(option.key); setError('')
    try { onDecided(await window.gearmod.invoke('approvals:decide', { id: approval.id, approve: true, choice: { workflow: option.workflow, ...(option.method ? { method: option.method } : {}) } })) } catch (reason) { setError(plainError(reason)); setBusy('') }
  }
  const options: Option[] = [
    { key: 'light', workflow: 'light', title: t.flowTitle.light, about: t.flowAbout.light },
    { key: 'spec', workflow: 'spec', title: t.flowTitle.spec, about: t.flowAbout.spec },
    { key: 'native', workflow: 'sdd', method: 'native', title: `${t.flowTitle.sdd} · ${t.methodNames.native}`, about: t.flowAbout.sdd },
    { key: 'speckit', workflow: 'sdd', method: 'speckit', title: `${t.flowTitle.sdd} · ${t.methodNames.speckit}`, about: t.flowAbout.sdd, off: specKit.enabled ? undefined : specKit.reason ?? '' }
  ]
  const isProposed = (option: Option): boolean => sameFlow({ workflow: option.workflow, method: option.method ?? null }, proposed)
  const recommendedTitle = flowTitle(t, proposed)
  if (small) return <div className="cask wfchoice small"><FlowBar title={w.title} assessment={assessment} recommended={recommendedTitle} open={false} toggle={() => minimize(false)} /></div>
  return <div className="cask wfchoice">
    <div className="cgprop-h"><b>{w.title}</b><small>{w.subtitle}</small><button type="button" className="ibtn wfc-min" title={w.minimize} aria-label={w.minimize} onClick={() => minimize(true)}><svg viewBox="0 0 24 24" className="gico"><path d="M5 12h14" /></svg></button></div>
    {assessment ? <ScoreTable assessment={assessment} limits={limits} /> : <p className="cx-muted">{all.common.loading}</p>}
    {reason && <p className="cgprop-msg">{reason}</p>}
    <div className="wfc-opts" role="group" aria-label={t.cardFlow}>{options.map((option) => <button type="button" key={option.key} className={`cx-opt ${isProposed(option) ? 'rec' : ''}`} disabled={Boolean(busy) || option.off !== undefined} data-tip={option.off || undefined} onClick={() => setConfirming(option)}>
      <span className="cx-opt-t">{busy === option.key ? <span className="spin sm" /> : null}{option.title}{isProposed(option) && <em>{t.recommendedTag}</em>}</span><small>{option.about}</small>
    </button>)}</div>
    {error && <p className="error">{error}</p>}
    <div className="cgrow"><span className="grow1" /><button type="button" className="mini secondary" onClick={details.open}>{w.seeDetails}</button></div>
    {details.dialog}
    {confirming && createPortal(<ConfirmDialog eyebrow={w.title} title={w.confirmTitle(confirming.title)} text={isProposed(confirming) ? w.confirmRecommended : w.confirmOther(recommendedTitle)} ok={w.confirmOk} cancel={() => setConfirming(undefined)} confirm={() => void choose(confirming)} />, document.body)}
  </div>
}

/** What the app records in the chat when the user picks the flow (see workflowChoiceRecord in the main process). */
export type WorkflowChoiceData = { cardId: string; projectId?: string | null; version: number | null; recommended: Flow; chosen: Flow }
const recordPattern = /<!--gearmod:workflow-choice (\{.*\})-->/
export function parseWorkflowChoice(body: string): WorkflowChoiceData | null {
  const match = recordPattern.exec(body)
  if (!match) return null
  try { const data = JSON.parse(match[1]!) as WorkflowChoiceData; return typeof data.cardId === 'string' && data.recommended && data.chosen ? data : null } catch { return null }
}

/** In the chat history, where the flow was chosen: the collapsed flow card (recommended and chosen), which expands to the score table. */
export function WorkflowChoiceRecord({ data }: { data: WorkflowChoiceData }): React.JSX.Element {
  const all = useT(), t = all.board.assessment, w = all.chat.workflowChoice
  const history = useHistory(data.cardId), limits = useLimits(data.projectId ?? undefined), details = useAssessmentDialog(data.cardId)
  const [open, setOpen] = useState(false)
  const assessment = history?.assessments.find((item) => item.version === data.version) ?? history?.assessments.at(-1)
  const recommended = flowTitle(t, data.recommended), chosen = flowTitle(t, data.chosen), differs = !sameFlow(data.recommended, data.chosen)
  return <div className={`cask wfchoice record ${open ? '' : 'small'}`}>
    <FlowBar title={w.recordTitle} assessment={assessment} recommended={recommended} chosen={{ title: chosen, differs }} open={open} toggle={() => setOpen(!open)} />
    {open && <>
      {assessment ? <ScoreTable assessment={assessment} limits={limits} /> : <p className="cx-muted">{all.common.loading}</p>}
      <div className="cgrow"><span className="grow1" /><button type="button" className="mini secondary" onClick={details.open}>{w.seeDetails}</button></div>
      {details.dialog}
    </>}
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
