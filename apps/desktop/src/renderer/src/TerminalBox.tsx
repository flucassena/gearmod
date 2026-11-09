import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useT } from './i18n'
import { terminalTheme } from './terminalTheme'
import { CollapseIcon, ExpandIcon, MinimizeIcon } from './icons'

/** Small terminal showing a program run by the app (login, update); the user can type when the CLI asks something. */
function MiniTerminal({ id, hidden, exited }: { id: string; hidden: boolean; exited(code: number): void }): React.JSX.Element {
  const [background, setBackground] = useState(() => terminalTheme().theme.background)
  const box = useRef<HTMLDivElement>(null), fit = useRef<FitAddon | null>(null), screen = useRef<Terminal | null>(null), ended = useRef(exited)
  ended.current = exited
  useEffect(() => {
    if (!box.current) return
    const container = box.current, colors = terminalTheme()
    const xterm = new Terminal({ cursorBlink: true, fontFamily: 'Consolas, monospace', fontSize: 12, scrollback: 2000, theme: colors.theme }), addon = new FitAddon()
    xterm.loadAddon(addon)
    // Link printed by the CLI (if the browser did not open by itself): one click opens it.
    xterm.loadAddon(new WebLinksAddon((_event, uri) => { void window.gearmod.invoke('app:open-link', { url: uri }).catch(() => undefined) }))
    xterm.open(container); screen.current = xterm; fit.current = addon
    // Theme change (preset, custom or light/dark): the terminal repaints, like the main terminal panel.
    const repaint = (): void => { const next = terminalTheme(); xterm.options.theme = next.theme; setBackground(next.theme.background) }
    const themes = new MutationObserver(repaint); themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })
    let seq = 0, ready = false
    const queued: Array<{ data: string; seq: number }> = []
    const stop = window.gearmod.onRunEvent((event) => {
      if (String(event.payload.id ?? '') !== id) return
      if (event.eventType === 'gearmod/terminal-exit') { ended.current(Number(event.payload.code ?? 0)); return }
      if (event.eventType !== 'gearmod/terminal-data') return
      const chunk = { data: String(event.payload.data ?? ''), seq: Number(event.payload.seq ?? 0) }
      if (!ready) { queued.push(chunk); return }
      if (chunk.seq > seq) { seq = chunk.seq; xterm.write(chunk.data) }
    })
    // What came out before the screen opened comes from `terminal:info`; then only newer pieces.
    void window.gearmod.invoke('terminal:info', { id }).then((info) => {
      xterm.write(info.text); seq = info.seq; ready = true
      for (const chunk of queued.splice(0)) if (chunk.seq > seq) { seq = chunk.seq; xterm.write(chunk.data) }
      if (info.exited) ended.current(0)
    }).catch(() => { ready = true })
    const input = xterm.onData((data) => { void window.gearmod.invoke('terminal:write', { id, data }).catch(() => undefined) })
    const resize = (): void => { if (!container.clientWidth || !container.clientHeight) return; addon.fit(); void window.gearmod.invoke('terminal:resize', { id, cols: Math.max(2, xterm.cols), rows: Math.max(2, xterm.rows) }).catch(() => undefined) }
    const observer = new ResizeObserver(resize); observer.observe(container); resize()
    return () => { themes.disconnect(); observer.disconnect(); stop(); input.dispose(); xterm.dispose(); screen.current = null; fit.current = null }
  }, [id])
  useEffect(() => { if (!hidden) window.setTimeout(() => { fit.current?.fit(); screen.current?.focus() }, 0) }, [hidden])
  return <div ref={box} className="agent-login-term" style={{ display: hidden ? 'none' : undefined, background }} />
}

/** Mini terminal inside a dialog, with a bar to minimize/show it and to expand it (the dialog widens with `expanded`). */
export function TerminalBox({ id, label, minimized, setMinimized, expanded, setExpanded, exited }: { id: string; label: string; minimized: boolean; setMinimized(value: boolean): void; expanded: boolean; setExpanded(value: boolean): void; exited(code: number): void }): React.JSX.Element {
  const tl = useT().settings.agentLogin
  return <div className={`agent-login-box ${expanded ? 'expanded' : ''} ${minimized ? 'minimized' : ''}`}>
    <div className="agent-login-bar"><span>{label}</span>
      <button type="button" className="ibtn" data-tip={minimized ? tl.showTerminal : tl.minimize} aria-label={minimized ? tl.showTerminal : tl.minimize} onClick={() => setMinimized(!minimized)}>{minimized ? <ExpandIcon /> : <MinimizeIcon />}</button>
      {!minimized && <button type="button" className="ibtn" data-tip={expanded ? tl.shrink : tl.expand} aria-label={expanded ? tl.shrink : tl.expand} onClick={() => setExpanded(!expanded)}>{expanded ? <CollapseIcon /> : <ExpandIcon />}</button>}
    </div>
    <MiniTerminal id={id} hidden={minimized} exited={exited} />
  </div>
}
