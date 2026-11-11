import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { complexityDimensions, defaultComplexityLimits, type Approval, type Assessment, type Card, type CardHistory, type WorkflowKind } from '@gearmod/contracts'
import { AssessmentDialog, Dots, FlowGears, FlowLegend, gearOf, useFlowName, type FlowSel, type SddMethod, type Tab } from './Assessment'
import { ConfirmDialog } from './ConfirmDialog'
import { plainError } from './NoticeDialog'
import { useT } from './i18n'
import { ChevronDownIcon, ChevronUpIcon } from './icons'

type Limits = { simpleMax: number; mediumMax: number }

/** The project's limits between simple, medium and complex (falls back to the defaults while loading). */
function useLimits(projectId: string | undefined): Limits {
  const [limits, setLimits] = useState<Limits>(defaultComplexityLimits)
  useEffect(() => { if (projectId) void window.gearmod.invoke('workflow:get', { projectId }).then((state) => setLimits(state.config.limits)).catch(() => undefined) }, [projectId])
  return limits
}

/** Points bar, same look as the limits in the settings: the three ranges by name, the card's range lit, a marker with the score, and the limits under the dividers. */
export function ScoreBar({ assessment, limits: current }: { assessment: Assessment; limits: Limits }): React.JSX.Element {
  const tb = useT().board
  // The limits the assessment was scored with; the project's current ones only for assessments saved before they were kept.
  const limits = assessment.limits ?? current
  const max = Math.max(complexityDimensions.reduce((sum, dimension) => sum + 3 * assessment.weights[dimension], 0), limits.mediumMax + 1, assessment.total)
  const at = (value: number): number => Math.min(100, Math.max(0, (value / max) * 100))
  const simpleEnd = at(limits.simpleMax + 0.5), mediumEnd = at(limits.mediumMax + 0.5)
  const seg = (level: Assessment['level'], width: number): React.JSX.Element => <span className={`seg ${level} ${assessment.level === level ? 'on' : ''}`} style={{ width: `${width}%` }}><b>{tb.levelLabels[level]}</b></span>
  return <div className="sbar" aria-label={`${assessment.total} / ${max}`}>
    <div className="cx-lbar sbar-lbar">
      {seg('simple', simpleEnd)}
      {seg('medium', mediumEnd - simpleEnd)}
      {seg('complex', 100 - mediumEnd)}
      <span className={`sbar-pin ${assessment.level}`} style={{ left: `${at(assessment.total)}%` }}><i>{assessment.preliminary ? '~' : ''}{assessment.total}</i></span>
    </div>
    <div className="cx-lscale sbar-scale"><span>0</span><span className="cut" style={{ left: `${simpleEnd}%` }}>{limits.simpleMax}</span><span className="cut" style={{ left: `${mediumEnd}%` }}>{limits.mediumMax}</span><span>{max}</span></div>
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
const asSel = (flow: Flow | null | undefined): FlowSel => flow && (flow.workflow === 'light' || flow.workflow === 'spec' || flow.workflow === 'sdd') ? { workflow: flow.workflow, method: flow.method === 'native' || flow.method === 'speckit' ? flow.method : null } : { workflow: null, method: null }
const sameFlow = (a: FlowSel, b: FlowSel): boolean => a.workflow === b.workflow && (a.workflow !== 'sdd' || (a.method ?? null) === (b.method ?? null))

/** Score and points bar side by side. */
function ScoreRow({ assessment, limits }: { assessment: Assessment; limits: Limits }): React.JSX.Element {
  const tb = useT().board, t = tb.assessment
  return <div className="wfc-score"><div className={`cx-score ${assessment.level}`}><b>{assessment.total}</b><span>{tb.levelLabels[assessment.level]}{assessment.preliminary ? ` · ${t.preliminary}` : ''}</span></div><ScoreBar assessment={assessment} limits={limits} /></div>
}

/** The six dimensions with notes, points and reasons; open while the flow is not chosen, so the user sees why before choosing. */
function DimensionsTable({ assessment, open }: { assessment: Assessment; open: boolean }): React.JSX.Element {
  const all = useT(), tb = all.board, t = tb.assessment
  return <details className="wfc-dims" open={open}>
    <summary>{all.chat.workflowChoice.dimensions}</summary>
    <div className="wfc-tablebox"><table className="cx-table wfc-table"><thead><tr><th>{t.dimension}</th><th>{t.score}</th><th className="num">{t.weight}</th><th className="num">{t.points}</th><th>{t.justification}</th></tr></thead><tbody>
      {complexityDimensions.map((dimension) => <tr key={dimension}><td className="dim">{tb.dimensionLabels[dimension]}</td><td><Dots value={assessment.scores[dimension]} /></td><td className="num muted">×{assessment.weights[dimension]}</td><td className="num pts">{assessment.scores[dimension] * assessment.weights[dimension]}</td><td>{assessment.justifications[dimension] || <span className="cx-muted">—</span>}</td></tr>)}
    </tbody></table></div>
  </details>
}

/** Flow chips: ✦ the AI recommendation, ✓ the chosen flow (one chip when they match), or "waiting for your choice". */
function FlowChips({ recommended, chosen }: { recommended: FlowSel; chosen: FlowSel | null }): React.JSX.Element {
  const all = useT(), t = all.board.assessment, w = all.chat.workflowChoice, name = useFlowName()
  const chip = (flow: FlowSel, className: string, title: string, mark: React.ReactNode): React.JSX.Element | null => flow.workflow ? <span className={`wfc-chip ${className}`} title={title}>{mark}{name(flow.workflow, flow.method)}<small>{t.gear(gearOf(flow.workflow))}</small></span> : null
  const spark = <span className="cx-aispark" aria-hidden="true">✦</span>
  if (!chosen?.workflow) return <>{chip(recommended, 'ai', t.recommendedByAgent, spark)}<span className="wfc-chip wait">{w.waiting}</span></>
  if (sameFlow(recommended, chosen)) return <>{chip(chosen, 'both', w.followed, <>{spark}✓ </>)}</>
  return <>{chip(recommended, 'ai', t.recommendedByAgent, spark)}{chip(chosen, 'pick', t.chosenByYou, '✓ ')}</>
}

/** Flow card header: title, level, the flow chips and the expand/collapse button on the right. */
function FlowBar({ title, assessment, recommended, chosen, open, toggle }: { title: string; assessment?: Assessment; recommended: FlowSel; chosen: FlowSel | null; open: boolean; toggle(): void }): React.JSX.Element {
  const all = useT(), tb = all.board, w = all.chat.workflowChoice
  return <div className="wfc-mini" onClick={toggle}>
    <b>{title}</b>
    {assessment && <span className={`cx-badge ${assessment.level}`}><b>{assessment.total}</b>{tb.levelLabels[assessment.level]}</span>}
    <FlowChips recommended={recommended} chosen={chosen} />
    <button type="button" className="ibtn wfc-toggle" title={open ? w.collapse : w.expand} aria-label={open ? w.collapse : w.expand} aria-expanded={open} onClick={(event) => { event.stopPropagation(); toggle() }}>{open ? <ChevronUpIcon className="gico" /> : <ChevronDownIcon className="gico" />}</button>
  </div>
}

/**
 * In the planning chat, when the agent proposes the flow: score, the six dimensions (open, to read before choosing), the AI recommendation and the options by gear.
 * The user picks the flow here and confirms; it replaces asking in the chat.
 */
export function WorkflowChoiceAsk({ approval, onDecided }: { approval: Approval; onDecided(approval: Approval): void }): React.JSX.Element {
  const all = useT(), t = all.board.assessment, w = all.chat.workflowChoice, name = useFlowName()
  const cardId = approval.cardId ?? ''
  const history = useHistory(cardId), limits = useLimits(approval.projectId ?? undefined), details = useAssessmentDialog(cardId)
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [small, setSmall] = useState(() => minimized.has(approval.id))
  const minimize = (value: boolean): void => { if (value) minimized.add(approval.id); else minimized.delete(approval.id); setSmall(value) }
  const [specKit, setSpecKit] = useState<{ enabled: boolean; reason: string | null }>({ enabled: true, reason: null })
  useEffect(() => { if (approval.projectId) void window.gearmod.invoke('speckit:availability', { projectId: approval.projectId }).then(setSpecKit).catch(() => undefined) }, [approval.projectId])
  const assessment = history?.assessments.at(-1)
  const proposed = asSel({ workflow: String(approval.payload.workflow ?? ''), method: typeof approval.payload.method === 'string' ? approval.payload.method : null })
  const reason = typeof approval.payload.reason === 'string' ? approval.payload.reason : ''
  const [confirming, setConfirming] = useState<{ workflow: WorkflowKind; method?: SddMethod }>()
  const choose = async (option: { workflow: WorkflowKind; method?: SddMethod }): Promise<void> => {
    setConfirming(undefined); setBusy(option.method ?? option.workflow); setError('')
    try { onDecided(await window.gearmod.invoke('approvals:decide', { id: approval.id, approve: true, choice: { workflow: option.workflow, ...(option.method ? { method: option.method } : {}) } })) } catch (reason) { setError(plainError(reason)); setBusy('') }
  }
  const recommendedTitle = proposed.workflow ? name(proposed.workflow, proposed.method) : ''
  const bar = <FlowBar title={w.title} assessment={assessment} recommended={proposed} chosen={null} open={!small} toggle={() => minimize(!small)} />
  if (small) return <div className="cask wfchoice pending small">{bar}</div>
  return <div className="cask wfchoice pending">
    {bar}
    <div className="wfc-body">
      {assessment ? <><ScoreRow assessment={assessment} limits={limits} /><DimensionsTable assessment={assessment} open /></> : <p className="cx-muted">{all.common.loading}</p>}
      {proposed.workflow && <div className="cx-airec"><span className="cx-airec-i" aria-hidden="true">✦</span><div><b>{t.aiRecommendation} {recommendedTitle}</b> — {reason || w.yourChoice}</div></div>}
      <FlowGears recommended={proposed} chosen={{ workflow: null }} specKit={specKit} busy={busy} pick={(workflow, method) => setConfirming({ workflow, method })} />
      {error && <p className="error">{error}</p>}
      <div className="wfc-foot"><span className="cx-muted">{w.pickHint}</span><button type="button" className="mini secondary" onClick={details.open}>{w.seeDetails}</button></div>
    </div>
    {details.dialog}
    {confirming && createPortal(<ConfirmDialog eyebrow={w.title} title={w.confirmTitle(name(confirming.workflow, confirming.method))} text={sameFlow({ workflow: confirming.workflow, method: confirming.method ?? null }, proposed) ? w.confirmRecommended : w.confirmOther(recommendedTitle)} ok={w.confirmOk} cancel={() => setConfirming(undefined)} confirm={() => void choose(confirming)} />, document.body)}
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

/** In the chat history, where the flow was chosen: the collapsed flow card (recommended and chosen), which expands to the score, the dimensions and the options (read only). */
export function WorkflowChoiceRecord({ data }: { data: WorkflowChoiceData }): React.JSX.Element {
  const all = useT(), w = all.chat.workflowChoice
  const history = useHistory(data.cardId), limits = useLimits(data.projectId ?? undefined), details = useAssessmentDialog(data.cardId)
  const [open, setOpen] = useState(false)
  const assessment = history?.assessments.find((item) => item.version === data.version) ?? history?.assessments.at(-1)
  const recommended = asSel(data.recommended), chosen = asSel(data.chosen)
  return <div className={`cask wfchoice record ${open ? '' : 'small'}`}>
    <FlowBar title={w.recordTitle} assessment={assessment} recommended={recommended} chosen={chosen} open={open} toggle={() => setOpen(!open)} />
    {open && <div className="wfc-body">
      {assessment ? <><ScoreRow assessment={assessment} limits={limits} /><DimensionsTable assessment={assessment} open={false} /></> : <p className="cx-muted">{all.common.loading}</p>}
      <FlowLegend recommended={recommended} chosen={chosen} />
      <FlowGears recommended={recommended} chosen={chosen} readOnly />
      <div className="wfc-foot"><span className="cx-muted">{w.changeHint}</span><button type="button" className="mini secondary" onClick={details.open}>{w.seeDetails}</button></div>
      {details.dialog}
    </div>}
  </div>
}

/** Beside the planning chat, under the decisions: the score, the recommended and the chosen flow (one block when they match), and the details button. */
export function ComplexitySide({ cardId, projectId, history }: { cardId: string; projectId: string; history?: CardHistory }): React.JSX.Element | null {
  const all = useT(), tb = all.board, t = tb.assessment, w = all.chat.workflowChoice, name = useFlowName()
  const limits = useLimits(projectId), details = useAssessmentDialog(cardId)
  const assessment = history?.assessments.at(-1)
  if (!history || !assessment) return null
  const recommended: FlowSel = { workflow: assessment.workflow, method: assessment.workflow === 'sdd' ? history.recommendedSddMethod : null }
  const chosen: FlowSel = { workflow: history.workflow, method: history.sddMethod }
  const spark = <span className="cx-aispark" aria-hidden="true">✦</span>
  const row = (className: string, label: React.ReactNode, flow: FlowSel, mark = ''): React.JSX.Element => <div className={`cxside-row ${className}`}>
    <span className="cxside-l">{label}</span>
    <span className="cxside-v"><b>{mark}{flow.workflow ? name(flow.workflow, flow.method) : ''}</b>{flow.workflow && <small>{t.gear(gearOf(flow.workflow))}</small>}</span>
  </div>
  const same = chosen.workflow !== null && sameFlow(recommended, chosen)
  return <aside className="changes cxside" aria-label={w.complexity}>
    <div className="ch-head"><span className="ch-title">{w.complexity}</span><span className={`cx-badge ${assessment.level}`}><b>{assessment.total}</b>{tb.levelLabels[assessment.level]}</span></div>
    <ScoreBar assessment={assessment} limits={limits} />
    <div className="cxside-rows">
      {same ? row('both', <>{spark}{w.recommendedAndChosen}</>, chosen, '✓ ') : <>
        {row('ai', <>{spark}{t.recommendedByAgent}</>, recommended)}
        {chosen.workflow ? row('pick', t.chosenByYou, chosen, '✓ ') : <div className="cxside-row none"><span className="cxside-l">{t.chosenByYou}</span><span className="cxside-v"><em>{w.notChosen}</em></span></div>}
      </>}
    </div>
    {chosen.workflow && !same && <p className="cxside-note">{t.differsFromRecommended}</p>}
    <button type="button" className="mini secondary cxside-more" onClick={details.open}>{w.seeDetails}</button>
    {details.dialog}
  </aside>
}
