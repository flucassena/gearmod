import React, { useEffect, useState } from 'react'
import { providerLabels } from '@gearmod/contracts'
import { useT } from './i18n'
import { useEscape } from './useEscape'
import { plainError } from './NoticeDialog'
import { useTasks } from './backgroundTasks'
import { TerminalBox } from './TerminalBox'
import { startAgentUpdate, type AgentCliJob, type RunningUpdate, type UpdatableProvider } from './agentUpdates'

/**
 * Updates (or installs, `job: 'install'`) the agent CLI inside the app: progress bar and a minimized mini terminal with the command. While it runs,
 * "Leave in the background" closes the dialog and the update goes on in the process list (title bar).
 */
export function AgentUpdateDialog({ provider, close, job = 'update', done }: { provider: UpdatableProvider; close(): void; job?: AgentCliJob; done?(): void }): React.JSX.Element {
  const t = useT(), tu = job === 'install' ? t.settings.agentInstall : t.settings.agentUpdate, name = providerLabels[provider]
  const [update, setUpdate] = useState<RunningUpdate>(), [error, setError] = useState(''), [minimized, setMinimized] = useState(true), [expanded, setExpanded] = useState(false)
  const task = useTasks().find((item) => item.id === update?.taskId), state = error ? 'failed' : task?.state ?? 'running'
  useEffect(() => { let alive = true; void startAgentUpdate(provider, name, job).then((value) => { if (alive) setUpdate(value) }).catch((reason) => { if (alive) setError(plainError(reason)) }); return () => { alive = false } }, [provider, job])
  // Failed: shows the terminal, where the CLI explains what went wrong.
  // Done: lets the caller react (the new-agent dialog checks the installation again and moves on).
  useEffect(() => { if (state === 'failed') setMinimized(false); if (state === 'done') done?.() }, [state])
  useEscape(close)
  return <div className="overlay top" role="dialog" aria-label={tu.title(name)}><div className="modal" style={{ width: expanded ? 'min(860px,100%)' : 'min(560px,100%)' }}>
    <header><div><div className="eyebrow">{t.common.agent}</div><h2>{state === 'done' ? tu.doneTitle(name) : tu.title(name)}</h2></div><button className="x" onClick={close} aria-label={t.common.close}>×</button></header>
    <div className="stack">
      <p className="dialog-text">{state === 'running' ? tu.running : state === 'done' ? tu.done(name) : tu.failed}</p>
      {state === 'running' && <div role="status" className="agent-login-wait"><div className="bar" aria-hidden="true"><i /></div></div>}
      {update && <TerminalBox id={update.terminalId} label={tu.terminal} minimized={minimized} setMinimized={setMinimized} expanded={expanded} setExpanded={setExpanded} exited={() => undefined} />}
      {(error || task?.error) && <p className="error" style={{ overflowWrap: 'anywhere' }}>{error || task?.error}</p>}
    </div>
    <div className="actions">{state === 'running' ? <button type="button" onClick={close}>{tu.background}</button> : <button type="button" onClick={close}>{t.common.close}</button>}</div>
  </div></div>
}
