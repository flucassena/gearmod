import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BackgroundTask } from '@gearmod/contracts'
import { useT } from './i18n'
const elapsed = (from: string, to: string | null, now: number): string => {
  const seconds = Math.max(0, Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}min` : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}min`
}

/** Subagents and background commands of the chat, read from the events the agent already emits. Disappears when the chat never used the background. */
export function AgentBackground({ chatId }: { chatId?: string }): React.JSX.Element | null {
  const t = useT().chat.background
  const [tasks, setTasks] = useState<BackgroundTask[]>([]), [open, setOpen] = useState(false), [now, setNow] = useState(Date.now()), [expanded, setExpanded] = useState<string[]>([]), box = useRef<HTMLSpanElement>(null), menu = useRef<HTMLDivElement>(null), [pos, setPos] = useState<React.CSSProperties | null>(null)
  useEffect(() => {
    setTasks([]); setOpen(false)
    if (!chatId) return
    let disposed = false, timer: number | undefined
    const load = (): void => { void window.gearmod.invoke('chats:background', { chatId }).then((items) => { if (!disposed) setTasks(items) }).catch(() => undefined) }
    const later = (): void => { window.clearTimeout(timer); timer = window.setTimeout(load, 1200) }
    const off = window.gearmod.onRunEvent((event) => {
      if (event.eventType === 'gearmod/run-completed' || event.eventType === 'gearmod/run-started' || (event.eventType === 'claude/system' && String(event.payload.subtype ?? '').startsWith('task_') && event.payload.session_id !== undefined)) later()
    })
    load()
    return () => { disposed = true; window.clearTimeout(timer); off() }
  }, [chatId])
  const running = tasks.filter((task) => task.status === 'running').length
  useEffect(() => { if (!running) return; const id = window.setInterval(() => setNow(Date.now()), 5000); return () => window.clearInterval(id) }, [running])
  useEffect(() => { if (!open) return; const out = (event: MouseEvent): void => { const target = event.target as Node; if (!box.current?.contains(target) && !menu.current?.contains(target)) setOpen(false) }; document.addEventListener('mousedown', out); return () => document.removeEventListener('mousedown', out) }, [open])
  // The menu is portaled to <body> with fixed position so no container clips it; it opens above the chip and stays inside the window.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const place = (): void => {
      const chip = box.current?.getBoundingClientRect(); if (!chip) return
      const width = Math.min(420, window.innerWidth * 0.86, window.innerWidth - 16)
      setPos({ left: Math.max(8, Math.min(chip.left, window.innerWidth - width - 8)), bottom: window.innerHeight - chip.top + 8, width })
    }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  if (!tasks.length) return null
  return <span className="modewrap bgtasks" ref={box}>
    <button type="button" className={`modechip ${open ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setNow(Date.now()); setOpen(!open) }} data-tip={t.tip}>{running > 0 && <i className="bgdot" />}{running > 0 ? t.runningCount(running) : t.title}</button>
    {open && pos && createPortal(<div ref={menu} className="modemenu bgmenu" style={pos} role="dialog" aria-label={t.tasks}><div className="mm-title">{t.title}</div>
      <div className="bglist">{tasks.map((task) => { const shown = expanded.includes(task.id), detail = task.status === 'running' ? task.activity : task.summary
        return <div className={`bgtask st-${task.status} ${shown ? 'open' : ''}`} key={task.id}>
          <button type="button" className="bghead" aria-expanded={shown} onClick={() => setExpanded(shown ? expanded.filter((id) => id !== task.id) : [...expanded, task.id])}>
            <span className="bgrow"><b>{task.kind === 'subagent' ? t.subagent : t.command}</b><span className="bgstate"><span className={`bgico st-${task.status}`} role="img" aria-label={t.status[task.status]} data-tip={t.status[task.status]}>{task.status === 'running' ? <i className="bgspin" /> : <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">{task.status === 'completed' ? <path d="m3.5 8.5 3 3 6-6.5" /> : task.status === 'failed' ? <path d="m4 4 8 8M12 4l-8 8" /> : <rect x="4.5" y="4.5" width="7" height="7" rx="1" />}</svg>}</span>{elapsed(task.startedAt, task.endedAt, now)}</span><span className="chev" aria-hidden="true">›</span></span>
            {!shown && <span className="bgtitle">{task.title || t.noDescription}</span>}
          </button>
          {shown && <div className="bgfull"><pre>{task.title || t.noDescription}</pre>{detail && detail !== task.title && <pre className="bgdetail">{detail}</pre>}</div>}
        </div> })}</div>
    </div>, document.body)}
  </span>
}
