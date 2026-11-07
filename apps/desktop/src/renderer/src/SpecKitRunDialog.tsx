import React, { useEffect, useState } from 'react'
import type { SpecKitRunInput } from '@gearmod/contracts'
import { useT } from './i18n'
import { useEscape } from './useEscape'
import { plainError } from './NoticeDialog'
import { useTasks } from './backgroundTasks'
import { TerminalBox } from './TerminalBox'
import { startSpecRun, type RunningSpecRun } from './specKitRun'

/**
 * A Spec Kit step (install, update, init…) running in a terminal inside the dialog, like the agent CLI updates. While it runs, "Leave in the background"
 * closes the dialog and it goes on in the process list (title bar). `init` may ask questions, so its terminal opens large to answer them.
 */
export function SpecKitRunDialog({ projectId, input, title, close }: { projectId: string; input: SpecKitRunInput; title: string; close(): void }): React.JSX.Element {
  const t = useT(), tr = t.settings.tools.run
  const interactive = input.kind === 'init' || input.kind === 'init-with-git'
  const [run, setRun] = useState<RunningSpecRun>(), [error, setError] = useState(''), [minimized, setMinimized] = useState(!interactive), [expanded, setExpanded] = useState(interactive), [showOutput, setShowOutput] = useState(false)
  const task = useTasks().find((item) => item.id === run?.taskId), state = error ? 'failed' : task?.state ?? 'running'
  useEffect(() => { let alive = true; void startSpecRun(projectId, input, title).then((value) => { if (alive) setRun(value) }).catch((reason) => { if (alive) setError(plainError(reason)) }); return () => { alive = false } }, [projectId, input, title])
  // Failed: shows the terminal, where the command explains what went wrong.
  useEffect(() => { if (state === 'failed') setMinimized(false) }, [state])
  // A step that waits for the user's answers is not left running in the background: closing it means giving up, so the command is stopped.
  const leave = (): void => { if (interactive && state === 'running' && run) void window.gearmod.invoke('terminal:kill', { id: run.terminalId }).catch(() => undefined); close() }
  useEscape(leave)
  return <div className="overlay top" role="dialog" aria-label={title}><div className="modal" style={{ width: expanded ? 'min(860px,100%)' : 'min(560px,100%)' }}>
    <header><div><div className="eyebrow">Spec Kit</div><h2>{state === 'done' ? tr.successTitle : title}</h2></div><button className="x" onClick={leave} aria-label={t.common.close}>×</button></header>
    <div className="stack">
      <p className="dialog-text">{state === 'running' ? (interactive ? tr.runningInteractive : tr.running) : state === 'done' ? (tr.success[input.kind] ?? tr.done) : tr.failed}</p>
      {state === 'running' && !interactive && <div role="status" className="agent-login-wait"><div className="bar" aria-hidden="true"><i /></div></div>}
      {state === 'done' && !showOutput && <p role="status" className="dialog-text" style={{ fontWeight: 700 }}>✓ {tr.done}</p>}
      {run && (state !== 'done' || showOutput) && <TerminalBox id={run.terminalId} label={tr.terminal} minimized={minimized} setMinimized={setMinimized} expanded={expanded} setExpanded={setExpanded} exited={() => undefined} />}
      {(error || task?.error) && <p className="error" style={{ overflowWrap: 'anywhere' }}>{error || task?.error}</p>}
    </div>
    <div className="actions">{state === 'running' ? (interactive ? null : <button type="button" onClick={close}>{tr.background}</button>) : <>{state === 'done' && !showOutput && <button type="button" className="secondary" onClick={() => { setMinimized(false); setExpanded(true); setShowOutput(true) }}>{tr.showTerminal}</button>}<button type="button" onClick={close}>{t.common.close}</button></>}</div>
  </div></div>
}
