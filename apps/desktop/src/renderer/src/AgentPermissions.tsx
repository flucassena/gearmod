import { providerLabels } from '@gearmod/contracts'
import { useEffect, useState } from 'react'
import type { AgentPermission } from '@gearmod/contracts'
import { explainCommand, riskLabel, shortPath, type Risk } from './permissionExplain'
import { plainError } from './NoticeDialog'
import { tr, useT } from './i18n'

export function AgentPermissions({ chatId }: { chatId?: string }): React.JSX.Element | null {
  const t = useT()
  const [requests, setRequests] = useState<AgentPermission[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState<string>(), [auto, setAuto] = useState(false)
  useEffect(() => {
    setRequests([]); setError(''); setAuto(false)
    if (!chatId) return
    let disposed = false, revision = 0
    const load = (): void => {
      const current = ++revision
      void window.gearmod.invoke('agents:permissions', { chatId }).then((items) => { if (!disposed && current === revision) setRequests(items) }).catch((reason: unknown) => { if (!disposed) setError(plainError(reason)) })
      void window.gearmod.invoke('agents:permission-auto', { chatId }).then((state) => { if (!disposed && current === revision) setAuto(state.enabled) }).catch(() => undefined)
    }
    const off = window.gearmod.onRunEvent((event) => { if (event.eventType.startsWith('gearmod/permission-') && event.payload.chatId === chatId) load() })
    load()
    return () => { disposed = true; off() }
  }, [chatId])
  const stopAuto = async (): Promise<void> => {
    if (!chatId) return
    try { await window.gearmod.invoke('agents:permission-auto-off', { chatId }); setAuto(false) } catch (reason) { setError(plainError(reason)) }
  }
  const decide = async (request: AgentPermission, allow: boolean, always = false): Promise<void> => {
    setBusy(request.id); setError('')
    try {
      const result = await window.gearmod.invoke('agents:permission-decide', { runId: request.runId, requestId: request.id, allow, ...(always ? { always: true } : {}) })
      if (always && result.decided) setAuto(true)
      setRequests((items) => items.filter((item) => item.id !== request.id))
      if (!result.decided) setError(t.chat.permission.alreadyAnswered)
    } catch (reason) { setError(plainError(reason)) } finally { setBusy(undefined) }
  }
  if (!requests.length && !error && !auto) return null
  return <div aria-live="polite">{auto && <p className="msg system perm" role="status">{t.chat.permission.autoOn}<button type="button" className="mini secondary" onClick={() => void stopAuto()}>{t.chat.permission.autoOff}</button></p>}{requests.map((request) => <article className="msg system perm" key={request.id}>
    <PermissionAction request={request} />
    <div className="cx-actions"><button type="button" className="mini" disabled={Boolean(busy)} onClick={() => void decide(request, true)}>{t.chat.permission.approveAction}</button>{request.kind !== 'ExitPlanMode' && <button type="button" className="mini" title={t.chat.permission.allowAlwaysHint} disabled={Boolean(busy)} onClick={() => void decide(request, true, true)}>{t.chat.permission.allowAlways}</button>}<button type="button" className="mini secondary" disabled={Boolean(busy)} onClick={() => void decide(request, false)}>{t.chat.permission.deny}</button></div>
  </article>)}{error && <p role="alert">{error}</p>}</div>
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const readable = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''
const codeStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto' } as const

const riskClass: Record<Risk, string> = { read: 'perm-read', write: 'perm-write', other: 'perm-other' }

function permSteps(steps: NonNullable<ReturnType<typeof explainCommand>>['steps']): React.JSX.Element {
  return <ol className="perm-steps">{steps.map((step, index) => <li key={index} className={riskClass[step.risk]}>
    <span className="perm-n">{index + 1}</span><span className="perm-what"><b>{step.label}</b>{step.detail && <code>{step.detail}</code>}</span>{step.joinedBy === '|' && index > 0 ? <em>{tr().chat.permission.usesPreviousOutput}</em> : null}
  </li>)}</ol>
}

function PermissionAction({ request }: { request: AgentPermission }): React.JSX.Element {
  const data = request.details, input = record(data.input), item = record(data.item)
  const command = data.command ?? input.command
  const reason = data.reason ?? data.description ?? data.decision_reason ?? input.description
  const cwd = data.cwd ?? input.cwd
  const path = input.file_path ?? input.path ?? data.path
  const changes = Array.isArray(item.changes) ? item.changes.map(record) : []
  const commandText = command ? (Array.isArray(command) ? command.map(readable).join(' ') : readable(command)) : ''
  const explained = commandText ? explainCommand(commandText) : null
  const t = useT(), p = t.chat.permission, toolTitles: Record<string, string> = p.toolTitles
  const toolKind = typeof data.toolKind === 'string' ? data.toolKind : ''
  const title = command ? p.runCommand : toolTitles[toolKind] ? toolTitles[toolKind]! : request.kind.includes('permissions/') ? p.widenAccess : request.kind.includes('fileChange') || request.kind === 'applyPatchApproval' ? p.changeFiles : ({ Write: p.writeFile, Edit: p.toolTitles.edit, Read: p.toolTitles.read, Bash: p.runCommand }[request.kind] ?? request.kind)
  const risk: Risk | null = explained ? explained.risk : ['edit', 'delete', 'move'].includes(toolKind) ? 'write' : ['read', 'search', 'fetch', 'think'].includes(toolKind) ? 'read' : /Write|Edit|fileChange|applyPatch|permissions\//.test(request.kind) ? 'write' : request.kind === 'Read' ? 'read' : null
  return <>
    <div className="perm-head"><span className="perm-who">{p.asksPermission(providerLabels[request.provider])}</span>{risk && <span className={`perm-risk ${riskClass[risk]}`}>{riskLabel(risk)}</span>}</div>
    <p className="perm-title"><strong>{title}</strong>{reason ? <span>{readable(reason)}</span> : null}</p>
    {explained && explained.steps.length > 1 ? <details className="perm-more"><summary><span>{p.askedActions(explained.steps.length)}</span><small>{p.viewActions}</small></summary>{permSteps(explained.steps)}</details> : explained && explained.steps.length > 0 && permSteps(explained.steps)}
    <dl className="perm-facts">
      {cwd ? <><dt>{p.folder}</dt><dd><code>{shortPath(readable(cwd))}</code></dd></> : null}
      {path ? <><dt>{p.file}</dt><dd><code>{shortPath(readable(path))}</code></dd></> : null}
      {data.grantRoot ? <><dt>{p.folderAccess}</dt><dd><code>{shortPath(readable(data.grantRoot))}</code></dd></> : null}
    </dl>
    {input.content !== undefined ? <details><summary>{p.contentToWrite}</summary><pre style={codeStyle}>{readable(input.content)}</pre></details> : null}
    {input.old_string !== undefined ? <details><summary>{p.replacementRequested}</summary><p>{p.currentSnippet}</p><pre style={codeStyle}>{readable(input.old_string)}</pre><p>{p.newSnippet}</p><pre style={codeStyle}>{readable(input.new_string)}</pre></details> : null}
    {changes.map((change, index) => <details key={index}><summary>{shortPath(readable(change.path ?? p.changedFile))}</summary><pre style={codeStyle}>{readable(change.diff ?? change)}</pre></details>)}
    {data.permissions ? <details open><summary>{p.accessRequested}</summary><pre style={codeStyle}>{readable(data.permissions)}</pre></details> : null}
    {commandText ? <details><summary>{p.fullCommand}</summary><pre style={codeStyle}>{commandText}</pre></details> : null}
    <details><summary>{p.technicalDetails}</summary><pre style={codeStyle}>{JSON.stringify(data, null, 2)}</pre></details>
  </>
}
