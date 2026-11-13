import React, { useEffect, useRef, useState } from 'react'
import { isShortcut } from './shortcuts'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { terminal, useTerminal, type TerminalTab } from './terminalStore'
import { WindowLayoutMenu, type LayoutPosition } from './WindowLayoutMenu'
import { CloseIcon, ExpandIcon, CollapseIcon } from './icons'
import { pop } from './popout'
import { FileFind, type FindOptions } from './FileFind'
import { terminalTheme } from './terminalTheme'
import { nearestDockEdge } from './dockLayout'
import { useAsk } from './useAsk'
import { toast } from './toasts'
import { plainError } from './NoticeDialog'
import { tr, useT } from './i18n'
import { findFileLinks, linkTarget } from './terminalLinks'

const absolute = (path: string): boolean => /^[A-Za-z]:[\\/]|^[\\/]/.test(path)

function Screen({ tab, visible }: { tab: TerminalTab; visible: boolean }): React.JSX.Element {
  const t = useT(), box = useRef<HTMLDivElement>(null), screen = useRef<Terminal | null>(null), consumed = useRef(''), fit = useRef<FitAddon | null>(null), search = useRef<SearchAddon | null>(null), webgl = useRef<WebglAddon | null>(null), field = useRef<HTMLInputElement>(null)
  const [finding, setFinding] = useState(false), [focusTick, setFocusTick] = useState(0), [needle, setNeedle] = useState(''), [options, setOptions] = useState<FindOptions>({ caseSensitive: false, wholeWord: false, regex: false }), [results, setResults] = useState({ index: -1, count: 0 }), [background, setBackground] = useState(() => terminalTheme().theme.background)
  const state = useRef({ needle, options }); state.current = { needle, options }
  const run = (forward: boolean, incremental = false): void => {
    const addon = search.current, current = state.current
    if (!addon || !current.needle) { addon?.clearDecorations(); setResults({ index: -1, count: 0 }); return }
    const colors = terminalTheme().search
    const config = { ...current.options, incremental, decorations: { matchBackground: colors.match, activeMatchBackground: colors.active, matchOverviewRuler: colors.match, activeMatchColorOverviewRuler: colors.active } }
    try { if (forward) addon.findNext(current.needle, config); else addon.findPrevious(current.needle, config) } catch { setResults({ index: -1, count: 0 }) }
  }
  useEffect(() => { if (finding) { field.current?.focus(); field.current?.select() } }, [focusTick])
  useEffect(() => { if (finding) run(true, true); else { search.current?.clearDecorations(); setResults({ index: -1, count: 0 }) } }, [finding, needle, options])
  useEffect(() => {
    if (!box.current) return
    const container = box.current, colors = terminalTheme()
    const xterm = new Terminal({ cursorBlink: true, fontFamily: 'Consolas, monospace', fontSize: 13, scrollback: 10000, allowProposedApi: true, theme: colors.theme }), addon = new FitAddon(), finder = new SearchAddon()
    xterm.loadAddon(addon); xterm.loadAddon(finder)
    xterm.loadAddon(new WebLinksAddon((event, uri) => { if (event.ctrlKey || event.metaKey) void window.gearmod.invoke('app:open-link', { url: uri }).catch((reason: unknown) => toast.error(tr().files.terminal.openLinkFailed, plainError(reason))) }, { hover: () => { container.title = tr().files.terminal.linkHint }, leave: () => { container.title = '' } }))
    xterm.loadAddon(new Unicode11Addon()); xterm.open(container)
    xterm.unicode.activeVersion = '11'
    screen.current = xterm; fit.current = addon; search.current = finder; consumed.current = ''
    const results$ = finder.onDidChangeResults((event) => setResults({ index: event.resultIndex, count: event.resultCount }))
    const files = xterm.registerLinkProvider({ provideLinks: (line, callback) => {
      const context = terminal.snapshot().context, text = xterm.buffer.active.getLine(line - 1)?.translateToString(true) ?? ''
      if (!context || !text) { callback(undefined); return }
      // Path with `:line[:column]` in the output (TypeScript errors, stack traces): becomes a link with Ctrl+click. See `terminalLinks.ts`.
      callback(findFileLinks(text).map((found) => ({ text: found.text, range: { start: { x: found.start + 1, y: line }, end: { x: found.start + found.text.length, y: line } }, activate: (event: MouseEvent) => { if (!(event.ctrlKey || event.metaKey)) return; const value = linkTarget(found), path = absolute(value) ? value : `${tab.cwd.replace(/[\\/]+$/, '')}/${value}`; window.dispatchEvent(new CustomEvent('gearmod:open-file', { detail: { projectId: context.projectId, cardId: context.cardId, path } })) } })))
    } })
    xterm.attachCustomKeyEventHandler((event) => {
      // The terminal and project search shortcuts go to the app, not to the shell (the others, like Ctrl+B, stay with the shell).
      if (isShortcut(event, 'toggleTerminal') || isShortcut(event, 'searchInFiles')) return false
      if (event.type !== 'keydown') return true
      if (isShortcut(event, 'find')) { event.preventDefault(); setFinding(true); setFocusTick((value) => value + 1); return false }
      // Ctrl+C copies when there is a selection; without a selection it goes through as an interrupt (^C) to the program.
      if (event.ctrlKey && event.code === 'KeyC' && (event.shiftKey || xterm.hasSelection())) { if (xterm.hasSelection()) { void navigator.clipboard.writeText(xterm.getSelection()).catch(() => undefined); xterm.clearSelection() } return false }
      return true
    })
    const input = xterm.onData((data) => { void window.gearmod.invoke('terminal:write', { id: tab.id, data }).catch(() => undefined) })
    const resize = (): void => { if (!box.current?.clientWidth || !box.current?.clientHeight) return; addon.fit(); void window.gearmod.invoke('terminal:resize', { id: tab.id, cols: Math.max(2, xterm.cols), rows: Math.max(2, xterm.rows) }).catch(() => undefined) }
    const observer = new ResizeObserver(resize); observer.observe(container); resize()
    // Light/dark theme (or another app theme): the document attribute changes and the terminal repaints.
    const repaint = (): void => { const next = terminalTheme(); xterm.options.theme = next.theme; setBackground(next.theme.background) }
    const themes = new MutationObserver(repaint); themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] }); repaint()
    return () => { themes.disconnect(); observer.disconnect(); input.dispose(); results$.dispose(); files.dispose(); xterm.dispose(); screen.current = null; fit.current = null; search.current = null; webgl.current = null }
  }, [tab.id])
  // Graphics card acceleration only for the tab on screen: each WebGL context (glyph atlas, buffers) costs memory in the GPU process,
  // and hidden tabs don't draw. Without support, or when the context is lost, it carries on in the default renderer, without notice.
  useEffect(() => {
    const xterm = screen.current
    if (!xterm) return
    if (visible && !webgl.current) {
      try {
        const gl = new WebglAddon()
        gl.onContextLoss(() => { try { gl.dispose() } catch { /* já descartado */ } if (webgl.current === gl) webgl.current = null })
        xterm.loadAddon(gl); webgl.current = gl
      } catch { /* default renderer */ }
    } else if (!visible && webgl.current) {
      try { webgl.current.dispose() } catch { /* já descartado */ }
      webgl.current = null
    }
  }, [visible, tab.id])
  useEffect(() => { if (!screen.current) return; if (tab.text.startsWith(consumed.current)) screen.current.write(tab.text.slice(consumed.current.length)); else { screen.current.reset(); screen.current.write(tab.text) } consumed.current = tab.text }, [tab.text])
  useEffect(() => { if (visible) window.setTimeout(() => { fit.current?.fit(); screen.current?.focus() }, 0) }, [visible])
  const paste = (event: React.MouseEvent): void => {
    // Like the Windows terminal: right click copies the selection or, without a selection, pastes.
    event.preventDefault()
    const xterm = screen.current; if (!xterm) return
    if (xterm.hasSelection()) { void navigator.clipboard.writeText(xterm.getSelection()).catch(() => undefined); xterm.clearSelection() } else void navigator.clipboard.readText().then((text) => { if (text) xterm.paste(text) }).catch(() => undefined)
  }
  return <div className="term-screen" style={{ display: visible ? undefined : 'none' }}>
    {finding && <div className="term-find" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setFinding(false); screen.current?.focus() } }}><FileFind input={field} query={needle} setQuery={setNeedle} options={options} setOptions={setOptions} count={results.count} index={results.index} error="" previous={() => run(false)} next={() => run(true)} close={() => { setFinding(false); screen.current?.focus() }} /></div>}
    <div ref={box} className="term-emulator" style={{ background }} onContextMenu={paste} aria-label={t.files.terminal.interactive(tab.shell)} />
  </div>
}

export function TerminalPanel({ standalone = false }: { standalone?: boolean } = {}): React.JSX.Element | null {
  const { ask, dialog } = useAsk()
  const closeTab = async (tab: TerminalTab): Promise<void> => {
    if (terminal.running(tab.id) && !(await ask({ eyebrow: t.files.terminal.closeRunningEyebrow, title: t.files.terminal.closeRunningTitle(tab.title), text: t.files.terminal.closeRunningText, ok: t.files.terminal.closeRunningOk, danger: true }))) return
    terminal.close(tab.id)
  }
  const t = useT(), { open, tabs, active, error, context } = useTerminal(), [position, setPosition] = useState<LayoutPosition>(() => { try { const saved = localStorage.getItem('gearmod.terminalPosition'); return saved === 'top' || saved === 'left' || saved === 'right' ? saved : 'bottom' } catch { return 'bottom' } }), [expanded, setExpanded] = useState(false), [height, setHeight] = useState(() => { try { return Number(localStorage.getItem('gearmod.terminalHeight')) || 300 } catch { return 300 } }), [width, setWidth] = useState(() => { try { return Number(localStorage.getItem('gearmod.terminalWidth')) || Math.round(window.innerWidth * .48) } catch { return Math.round(window.innerWidth * .48) } }), [dragging, setDragging] = useState(false), [moveTarget, setMoveTarget] = useState<LayoutPosition>()
  const current = tabs.find((tab) => tab.id === active), panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const root = document.documentElement.style
    const clear = (): void => { for (const edge of ['top', 'bottom', 'left', 'right']) root.setProperty(`--terminal-dock-${edge}`, '0px') }
    const element = panel.current
    if (!element || standalone || !open || expanded) { clear(); return }
    const publish = (): void => { const rect = element.getBoundingClientRect(), size = Math.round(position === 'top' || position === 'bottom' ? rect.height : rect.width); clear(); root.setProperty(`--terminal-dock-${position}`, `${size}px`) }
    publish(); const observer = new ResizeObserver(publish); observer.observe(element)
    return () => { observer.disconnect(); clear() }
  }, [open, standalone, expanded, position])
  const moveTo = (value: LayoutPosition): void => { setPosition(value); setExpanded(false); try { localStorage.setItem('gearmod.terminalPosition', value) } catch { /* only valid for this session */ } }
  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const element = panel.current; if (!element) return
    event.preventDefault(); const vertical = position === 'top' || position === 'bottom', rect = element.getBoundingClientRect(), start = vertical ? event.clientY : event.clientX, initial = vertical ? rect.height : rect.width, sign = position === 'bottom' || position === 'right' ? -1 : 1
    let nextSize = initial; setDragging(true)
    const move = (next: PointerEvent): void => { nextSize = Math.round(Math.max(vertical ? 180 : 320, Math.min((vertical ? window.innerHeight : window.innerWidth) * .75, initial + sign * ((vertical ? next.clientY : next.clientX) - start)))); if (vertical) setHeight(nextSize); else setWidth(nextSize) }
    const up = (): void => { setDragging(false); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); try { localStorage.setItem(vertical ? 'gearmod.terminalHeight' : 'gearmod.terminalWidth', String(nextSize)) } catch { /* only valid for this session */ } }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
  }
  const moveHeader = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (standalone || event.button !== 0 || (event.target as HTMLElement).closest('button, input, .term-tablist, .windowlayout')) return
    const header = event.currentTarget, startX = event.clientX, startY = event.clientY; let moved = false
    header.setPointerCapture(event.pointerId)

    const move = (next: PointerEvent): void => { if (Math.abs(next.clientX - startX) + Math.abs(next.clientY - startY) < 8 && !moved) return; moved = true; const outside = next.clientX < 0 || next.clientY < 0 || next.clientX > window.innerWidth || next.clientY > window.innerHeight; setMoveTarget(outside ? undefined : nearestDockEdge(next.clientX, next.clientY, window.innerWidth, window.innerHeight)) }
    const end = (next: PointerEvent): void => { header.removeEventListener('pointermove', move); header.removeEventListener('pointerup', end); header.removeEventListener('pointercancel', cancel); setMoveTarget(undefined); if (!moved) return; if (next.clientX < 0 || next.clientY < 0 || next.clientX > window.innerWidth || next.clientY > window.innerHeight) void detach({ x: Math.round(next.screenX), y: Math.round(next.screenY) }); else moveTo(nearestDockEdge(next.clientX, next.clientY, window.innerWidth, window.innerHeight)) }
    const cancel = (): void => { header.removeEventListener('pointermove', move); header.removeEventListener('pointerup', end); header.removeEventListener('pointercancel', cancel); setMoveTarget(undefined) }
    header.addEventListener('pointermove', move); header.addEventListener('pointerup', end); header.addEventListener('pointercancel', cancel)
  }
  useEffect(() => { if (standalone && pop?.terminalId) { terminal.setContext({ projectId: pop.projectId, cardId: pop.cardId }); void terminal.attach(pop.terminalId) } }, [standalone])
  // Closing the detached window leaves no orphan process: its tabs (including those from the "+") move to the main window.
  useEffect(() => { if (!standalone) return; const leave = (): void => terminal.handOff(); window.addEventListener('pagehide', leave); window.addEventListener('beforeunload', leave); return () => { window.removeEventListener('pagehide', leave); window.removeEventListener('beforeunload', leave) } }, [standalone])
  const detach = async (point?: { x: number; y: number }): Promise<void> => { if (!current || !context) return; try { await window.gearmod.invoke('windows:open', { kind: 'terminal', projectId: context.projectId, cardId: context.cardId ?? undefined, terminalId: current.id, placement: 'new', ...point }); terminal.setOpen(false) } catch (reason) { toast.error(t.files.terminal.detachFailed, plainError(reason)) } }
  if (!open && !standalone) return null
  const size = position === 'top' || position === 'bottom' ? { height } : { width }
  const fill = (): void => { if (standalone) void window.gearmod.invoke('windows:place', { placement: expanded ? 'new' : 'fill' }); setExpanded(!expanded) }
  return <section ref={panel} className={`term terminalpty ${standalone ? 'standalone' : expanded ? 'expanded' : position} ${dragging ? 'dragging' : ''}`} style={standalone || expanded ? undefined : size} aria-label={t.files.terminal.panelLabel}>
    {!standalone && !expanded && <div className={`term-grip ${position}`} role="separator" aria-orientation={position === 'top' || position === 'bottom' ? 'horizontal' : 'vertical'} aria-label={position === 'top' || position === 'bottom' ? t.files.terminal.resizeHeight : t.files.terminal.resizeWidth} onPointerDown={resize} />}
    {moveTarget && <div className={`term-move-preview ${moveTarget}`} aria-hidden="true" />}
    <div className="term-tabs" onPointerDown={moveHeader}><span className="powershell-icon" aria-hidden="true">›_</span><div className="term-tablist">{tabs.map((tab) => <span key={tab.id} className={`term-tab ${tab.id === active ? 'on' : ''}`}><button type="button" onClick={() => terminal.select(tab.id)} data-tip={tab.cwd}>{tab.exited ? t.files.terminal.tabExited(tab.title) : tab.title}</button><button type="button" className="x" aria-label={t.files.terminal.closeTab(tab.title)} onClick={() => void closeTab(tab)}>×</button></span>)}</div>
      <button type="button" className="ibtn" data-tip={t.files.terminal.newTip} aria-label={t.files.terminal.newLabel} onClick={() => void terminal.newTab()}>+</button><span className="term-header-drag" aria-hidden="true" />
      {current && <button type="button" className="term-link" onClick={() => terminal.clear(current.id)}>{t.common.clear}</button>}
      <WindowLayoutMenu move={(value) => { if (standalone) void window.gearmod.invoke('windows:place', { placement: value }); else moveTo(value) }} detach={!standalone ? () => void detach() : undefined} detachDisabled={!current || !context} />
      {!standalone && <button type="button" className="ibtn" aria-label={expanded ? t.files.terminal.restore : t.files.terminal.expand} onClick={fill}>{expanded ? <CollapseIcon /> : <ExpandIcon />}</button>}<button type="button" className="ibtn" aria-label={t.files.terminal.hide} onClick={() => { if (standalone) window.close(); else terminal.setOpen(false) }}><CloseIcon /></button>
    </div>
    {error && <p className="term-error">{error}</p>}{tabs.map((tab) => <Screen key={tab.id} tab={tab} visible={active === tab.id} />)}
    {dialog}
    {!current && <div className="term-empty"><button type="button" onClick={() => void terminal.newTab()}>{t.files.terminal.openPowerShell}</button></div>}
  </section>
}
