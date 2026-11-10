import React, { useCallback, useEffect, useState } from 'react'
import type { Approval } from '@gearmod/contracts'
import { plainError } from './NoticeDialog'
import { DiffEditor } from './editor/DiffEditor'
import { usePreferences } from './editor/preferences'
import { tr, useT } from './i18n'
import { WorkflowChoiceAsk } from './WorkflowChoice'

/** Approval requests (S02) of this card: reloads when the card changes or an agent tool is used. */
export function useApprovals(cardId: string): { items: Approval[]; reload(): Promise<void> } {
  const [items, setItems] = useState<Approval[]>([])
  const reload = useCallback(async (): Promise<void> => { if (!cardId) return setItems([]); try { setItems(await window.gearmod.invoke('approvals:list', { cardId })) } catch { /* the chat continues without the notice */ } }, [cardId])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => window.gearmod.onRunEvent((event) => { if (['gearmod/card-updated', 'gearmod/run-completed'].includes(event.eventType)) void reload() }), [reload])
  return { items, reload }
}

/** Title and description per request type; types not yet known fall back to the generic one (does not block any new request). */
function describe(approval: Approval): { title: string; detail: string } {
  const payload = approval.payload, a = tr().chat.approval
  switch (approval.kind) {
    case 'workflow-choice': return { title: a.switchWorkflow(payload.workflow === 'sdd' ? (payload.method === 'native' ? a.sddNative : payload.method === 'speckit' ? a.sddSpecKit : a.sddNoMethod) : payload.workflow === 'light' ? a.workflowLight : payload.workflow === 'spec' ? a.workflowSpec : String(payload.workflow ?? '')), detail: typeof payload.reason === 'string' && payload.reason ? payload.reason : a.workflowReason }
    case 'git-commit': return { title: a.commitIn(String(payload.repo ?? a.aRepository)), detail: typeof payload.message === 'string' ? payload.message.split('\n')[0]! : '' }
    case 'agent-move': return { title: a.moveCard(String(payload.columnLabel ?? '')), detail: a.moveCardDetail }
    case 'usage-ledger-purge': return { title: a.purgeUsage, detail: a.purgeUsageDetail }
    case 'constitution-apply': return { title: a.changeConstitution, detail: a.reviewOf(String(payload.path ?? '')) }
    default: return { title: a.agentRequest(approval.kind), detail: '' }
  }
}

/** Generic approval card (S02): shows the pending request and lets the user authorize or deny. Used in the card chat. */
export function ApprovalAsk({ approval, onDecided }: { approval: Approval; onDecided(approval: Approval): void }): React.JSX.Element {
  const t = useT(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [preferences] = usePreferences()
  const options = { wrap: preferences.wrap, tabSize: preferences.tabSize, indentWithTab: preferences.indent, whitespace: preferences.whitespace, guides: preferences.guides, scrollPastEnd: preferences.beyond }
  const { title, detail } = describe(approval)
  const decide = async (approve: boolean): Promise<void> => {
    setBusy(true); setError('')
    try { onDecided(await window.gearmod.invoke('approvals:decide', { id: approval.id, approve })) } catch (reason) { setError(plainError(reason)); onDecided(approval) } finally { setBusy(false) }
  }
  return <div className="cask">
    <div className="cgprop-h"><b>{title}</b><small>{t.chat.approval.asksApproval}</small></div>
    {detail && <p className="cgprop-msg">{detail}</p>}
    {approval.kind === 'constitution-apply' && typeof approval.payload.content === 'string' && <div className="wf-diffview" style={{ height: 260 }}><DiffEditor before={typeof approval.payload.before === 'string' ? approval.payload.before : null} after={approval.payload.content} path={String(approval.payload.path ?? '')} layout={preferences.diffLayout} editable={false} options={options} /></div>}
    {error && <p className="error">{error}</p>}
    {approval.status === 'approved' ? <button type="button" className="mini" disabled={busy} onClick={() => { setBusy(true); void window.gearmod.invoke('approvals:apply-constitution', { id: approval.id }).then(onDecided).catch((reason) => setError(plainError(reason))).finally(() => setBusy(false)) }}>{t.chat.approval.retryApply}</button> : <div className="cgrow"><button type="button" className="mini" disabled={busy} onClick={() => void decide(true)}>{t.chat.approval.approve}</button><span className="grow1" /><button type="button" className="mini secondary" disabled={busy} onClick={() => void decide(false)}>{t.chat.approval.deny}</button></div>}
  </div>
}

/** In the card chat: all pending approval requests (any type), one card each. */
export function ApprovalAsks({ cardId }: { cardId: string }): React.JSX.Element | null {
  const { items, reload } = useApprovals(cardId)
  // git-commit only mirrors the approval_record for audit (S06); the decision itself still goes through the commit card (CommitAsks), without duplicating the request on screen.
  const pending = items.filter((item) => (item.status === 'requested' && item.kind !== 'git-commit' && !item.kind.startsWith('speckit-')) || (item.kind === 'constitution-apply' && item.status === 'approved' && !item.consumedAt))
  // Only the newest flow proposal (the list comes newest first): older ones were replaced while the user kept talking.
  const latestFlow = pending.find((item) => item.kind === 'workflow-choice')
  const shown = pending.filter((item) => item.kind !== 'workflow-choice' || item === latestFlow)
  if (!shown.length) return null
  return <>{shown.map((item) => item.kind === 'workflow-choice' ? <WorkflowChoiceAsk key={item.id} approval={item} onDecided={() => void reload()} /> : <ApprovalAsk key={item.id} approval={item} onDecided={() => void reload()} />)}</>
}
