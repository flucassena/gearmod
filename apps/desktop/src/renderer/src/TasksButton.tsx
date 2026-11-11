import React, { useEffect, useRef, useState } from 'react'
import { tasks, useTasks, type BgTask } from './backgroundTasks'
import { useFitInView } from './useFitInView'
import { useEscape } from './useEscape'
import { useT } from './i18n'
import { ActivityIcon } from './icons'

const elapsed = (task: BgTask, now: number): string => {
  const seconds = Math.max(0, Math.round(((task.endedAt ?? now) - task.startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}min ${String(seconds % 60).padStart(2, '0')}s`
}

/** Title bar button with the background processes (installs, reviews…) and the progress of each. */
export function TasksButton(): React.JSX.Element {
  const t = useT()
  const list = useTasks(), running = list.filter((item) => item.state === 'running').length, failed = list.filter((item) => item.state === 'failed').length
  const [open, setOpen] = useState(false), [now, setNow] = useState(() => Date.now()), box = useRef<HTMLSpanElement>(null), pop = useRef<HTMLDivElement>(null)
  useFitInView(pop, open)
  useEffect(() => { if (!open && !running) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [open, running])
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent): void => { if (!box.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  useEscape(() => setOpen(false), open)
  const label = running ? t.shell.tasks.running(running) : t.shell.tasks.backgroundProcesses
  return <span className="popwrap tasksbtn" ref={box}>
    <button type="button" className={`ibtn tip ${open ? 'on' : ''} ${running ? 'busy' : ''}`} data-tip={label} aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
      {running ? <span className="spin sm" aria-hidden="true" /> : <ActivityIcon />}
      {(running > 0 || failed > 0) && <i className={`tasks-badge ${running ? '' : 'bad'}`}>{running || failed}</i>}
    </button>
    {open && <div className="tasks-pop" ref={pop} role="dialog" aria-label={t.shell.tasks.backgroundProcesses}>
      <header><b>{t.shell.tasks.processes}</b>{list.some((item) => item.state !== 'running') && <button type="button" className="ghost" onClick={() => tasks.clearFinished()}>{t.shell.tasks.clearFinished}</button>}</header>
      {!list.length ? <p className="tasks-empty">{t.shell.tasks.empty}</p>
        : <ul>{list.map((task) => <li key={task.id} className={`tasks-item ${task.state}`}>
          <span className="tasks-ico" aria-hidden="true">{task.state === 'running' ? <span className="spin sm" /> : task.state === 'done' ? '✓' : '!'}</span>
          <span className="tasks-txt"><b>{task.title}</b>{task.detail && <small>{task.detail}</small>}{task.error && <small className="err">{task.error}</small>}</span>
          <span className="tasks-time">{task.state === 'running' ? elapsed(task, now) : task.state === 'done' ? t.shell.tasks.done(elapsed(task, now)) : t.shell.tasks.failed(elapsed(task, now))}</span>
          {task.state !== 'running' && <button type="button" className="x" aria-label={t.shell.tasks.removeFromList} onClick={() => tasks.dismiss(task.id)}>×</button>}
        </li>)}</ul>}
    </div>}
  </span>
}
