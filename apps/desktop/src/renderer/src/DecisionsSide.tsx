import React, { useCallback, useEffect, useState } from 'react'
import type { CardHistory } from '@gearmod/contracts'
import { plainError } from './NoticeDialog'
import { useT } from './i18n'
import { ComplexitySide } from './WorkflowChoice'

/**
 * Card decisions beside the planning chat (where the implementation shows Changes): the agent's recommendations are
 * approved or discarded right there, without opening Complexity and decisions.
 */
export function DecisionsSide({ cardId, projectId }: { cardId: string; projectId: string }): React.JSX.Element | null {
  const all = useT(), t = all.board.assessment
  const [expanded, setExpanded] = useState(true)
  const [history, setHistory] = useState<CardHistory>(), [working, setWorking] = useState(''), [error, setError] = useState('')
  const load = useCallback(() => { void window.gearmod.invoke('history:get', { cardId }).then(setHistory).catch(() => undefined) }, [cardId])
  useEffect(() => {
    load()
    const again = (): void => { if (!document.hidden) load() }
    const timer = window.setInterval(again, 6000)
    const off = window.gearmod.onRunEvent((event) => { if (['gearmod/card-updated', 'gearmod/run-completed', 'gearmod/tool-activity'].includes(event.eventType)) again() })
    return () => { window.clearInterval(timer); off() }
  }, [load])
  const decide = async (decisionId: string, status: 'approved' | 'superseded'): Promise<void> => {
    setWorking(decisionId); setError('')
    try { setHistory(await window.gearmod.invoke('history:set-decision', { decisionId, status })); window.dispatchEvent(new Event('gearmod:board-changed')) } catch (reason) { setError(plainError(reason)) } finally { setWorking('') }
  }
  const decisions = history?.decisions.filter((item) => item.status !== 'superseded') ?? []
  if (!history) return null
  const open = decisions.filter((item) => item.status === 'proposed')
  const approveAll = async (): Promise<void> => { for (const item of open) await decide(item.id, 'approved') }
  const approved = decisions.length - open.length
  // Same as the test checklist: the title folds the list; the count and the bar show how many are approved.
  return <div className="dockside"><aside className={`changes decside ${expanded ? 'open' : ''}`} aria-label={t.cardDecisions}>
    <div className="ch-head"><button type="button" className="ch-title" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t.cardDecisions}<span className="chev chev-box" aria-hidden="true"><svg className="chev-svg" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg></span></button>{open.length > 0 && <span className="cx-pill warn">{t.waitingForYou(open.length)}</span>}{decisions.length > 0 && <span className="pg-count">{approved}/{decisions.length}</span>}</div>
    {decisions.length > 0 && <span className="pg-bar"><i style={{ width: `${Math.round((approved / decisions.length) * 100)}%` }} /></span>}
    {expanded && !decisions.length && <p className="decside-empty">{t.noDecisions}</p>}
    {expanded && decisions.length > 0 && <ul className="decside-list">{decisions.map((item) => <li key={item.id} className={item.status}>
      <div className="cx-dtop"><span className="cx-num">D{String(item.number).padStart(3, '0')}</span><span className={`cx-status ${item.status}`}>{t.decisionStatus[item.status]}</span><span className="cx-chip">{t.decisionKinds[item.kind]}</span></div>
      <p className="cx-statement">{item.statement}</p>
      {item.status === 'proposed' && <div className="cx-actions"><button type="button" className="mini" disabled={Boolean(working)} onClick={() => void decide(item.id, 'approved')}>{working === item.id ? <span className="spin sm" /> : t.approve}</button><button type="button" className="mini secondary" disabled={Boolean(working)} onClick={() => void decide(item.id, 'superseded')}>{t.discard}</button></div>}
    </li>)}</ul>}
    {expanded && open.length > 1 && <button type="button" className="mini secondary" disabled={Boolean(working)} onClick={() => void approveAll()}>{all.board.start.acceptAll(open.length)}</button>}
    {error && <p className="ch-error">{error}</p>}
  </aside><ComplexitySide cardId={cardId} projectId={projectId} history={history} /></div>
}
