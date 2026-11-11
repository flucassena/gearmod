import React, { useEffect, useState } from 'react'
import { complexityDimensions, type WorkflowConfig } from '@gearmod/contracts'
import { plainError } from './NoticeDialog'
import { Checkbox } from './Checkbox'
import { useT } from './i18n'
import { FolderGlyph } from './icons'

const FolderIcon = (): React.JSX.Element => <FolderGlyph className="cx-foldico" />

/** Project settings: Complexity Engine weights and thresholds, and the artifacts folder. */
export function WorkflowPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const { board: tb, common } = useT(), t = tb.workflowPanel
  const [config, setConfig] = useState<WorkflowConfig>(), [defaultDir, setDefaultDir] = useState(''), [message, setMessage] = useState('')
  const [editArt, setEditArt] = useState(false), [saveState, setSaveState] = useState<'' | 'saving' | 'saved'>(''), lastSaved = React.useRef('')
  const take = (state: { config: WorkflowConfig; defaultArtifactsDir: string }): void => { lastSaved.current = JSON.stringify(state.config); setConfig(state.config); setDefaultDir(state.defaultArtifactsDir) }
  useEffect(() => { void window.gearmod.invoke('workflow:get', { projectId }).then(take).catch((reason) => setMessage(plainError(reason))) }, [projectId])
  // Saves on its own ~0.7 s after the last change; what the server returns only updates the detections, so it does not disturb what is being typed.
  useEffect(() => {
    if (!config || JSON.stringify(config) === lastSaved.current) return
    const snapshot = JSON.stringify(config)
    const timer = window.setTimeout(() => {
      setSaveState('saving'); setMessage('')
      void window.gearmod.invoke('workflow:set', { projectId, config }).then((state) => { lastSaved.current = snapshot; setDefaultDir(state.defaultArtifactsDir); setSaveState('saved') }).catch((reason) => { setSaveState(''); setMessage(plainError(reason)) })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [config, projectId])
  if (!config) return <p className="cx-muted">{message || common.loading}</p>
  const set = (patch: Partial<WorkflowConfig>): void => setConfig({ ...config, ...patch })
  const choose = async (): Promise<void> => { try { const path = await window.gearmod.invoke('projects:choose-directory', { projectId }); if (path) set({ artifactsDir: path }) } catch (reason) { setMessage(plainError(reason)) } }
  const openFolder = (): void => { void window.gearmod.invoke('workflow:open-path', { projectId, which: 'artifacts' }).catch((reason) => setMessage(plainError(reason))) }
  const harness = config.harness, setHarness = (patch: Partial<WorkflowConfig['harness']>): void => set({ harness: { ...harness, ...patch } })
  const optional = (value: string): number | null => value.trim() === '' ? null : Number(value)
  const max = complexityDimensions.reduce((sum, dimension) => sum + 3 * config.weights[dimension], 0)
  return <div className="cx-wfpanel">
    <p className="cx-note">{t.intro}</p>
    <section className="cx-wfcard">
    <h4>{t.weightsTitle}</h4>
    <div className="cx-weights">{complexityDimensions.map((dimension) => <label key={dimension}>{tb.dimensionLabels[dimension]}<input type="number" min={0} max={5} value={config.weights[dimension]} onChange={(event) => set({ weights: { ...config.weights, [dimension]: Math.max(0, Math.min(5, Number(event.target.value) || 0)) } })} /></label>)}</div>
    </section>
    <section className="cx-wfcard">
    <h4>{t.limitsTitle(max)}</h4>
    <LimitsBar max={max} simpleMax={config.limits.simpleMax} mediumMax={config.limits.mediumMax} change={(simpleMax, mediumMax) => set({ limits: { ...config.limits, simpleMax, mediumMax } })} />
    </section>
    <section className="cx-wfcard">
    <h4>{t.artifactsTitle}</h4>
    <p className="cx-note">{t.artifactsNote}</p>
    {!editArt ? <div className="cx-pathrow"><button type="button" className="cx-pathchip big link" data-tip={t.openFolder(config.artifactsDir ?? defaultDir)} onClick={openFolder}><b>{config.artifactsDir ? t.chosenFolder : t.appDefault}</b><code>{config.artifactsDir ?? defaultDir}</code><FolderIcon /></button><button type="button" className="mini secondary" onClick={() => setEditArt(true)}>{common.edit}</button></div> : <div className="cx-add"><input value={config.artifactsDir ?? ''} onChange={(event) => set({ artifactsDir: event.target.value.trim() || null })} placeholder={defaultDir} /><button type="button" className="mini secondary" onClick={() => void choose()}>{t.choose}</button><button type="button" className="mini" onClick={() => setEditArt(false)}>{t.done}</button></div>}
    </section>
    <section className="cx-wfcard">
    <h4>{t.execLimitsTitle}</h4>
    <p className="cx-note">{t.execLimitsNote}</p>
    <div className="cx-weights">
      <label>{t.maxTime}<input type="number" min={1} value={harness.timeoutMinutes ?? ''} onChange={(event) => setHarness({ timeoutMinutes: optional(event.target.value) })} placeholder={t.noLimit} /></label>
      <label>{t.maxTokens}<input type="number" min={1000} step={1000} value={harness.maxTokens ?? ''} onChange={(event) => setHarness({ maxTokens: optional(event.target.value) })} placeholder={t.noLimit} /></label>
      <label>{t.maxCost}<input type="number" min={0.01} step={0.5} value={harness.maxCostUsd ?? ''} onChange={(event) => setHarness({ maxCostUsd: optional(event.target.value) })} placeholder={t.noLimit} /></label>
      <label>{t.sameFailures}<input type="number" min={1} max={20} value={harness.maxAttempts} onChange={(event) => setHarness({ maxAttempts: Math.max(1, Math.min(20, Number(event.target.value) || 1)) })} /></label>
    </div>
    <label className="ck-line"><Checkbox checked={harness.includeEquivalentCost} onChange={(includeEquivalentCost) => setHarness({ includeEquivalentCost })} /> {t.includeEquivalentCost}</label>
    <label className="ck-line"><Checkbox checked={harness.scopeCheck} onChange={(scopeCheck) => setHarness({ scopeCheck })} /> {t.scopeCheck}</label>
    {harness.scopeCheck && <label className="cx-field">{t.scopeIgnore}<textarea rows={3} value={harness.scopeIgnore.join('\n')} onChange={(event) => setHarness({ scopeIgnore: event.target.value.split('\n').slice(0, 50) })} placeholder={t.scopeIgnorePlaceholder} spellCheck={false} /><small className="cx-note">{t.scopeIgnoreNote}</small></label>}
    <label className="ck-line"><Checkbox checked={config.exportUsage} onChange={(exportUsage) => set({ exportUsage })} /> {t.exportUsage}</label>
    </section>
    <div className="cx-autosave" role="status" aria-live="polite">{saveState === 'saving' ? common.saving : saveState === 'saved' ? t.savedAuto : message ? <span className="cx-warn">{message}</span> : t.autoSaveNote}</div>
  </div>
}


/** Bar from 0 to the maximum score in three bands (simple, medium, complex); the handles drag the thresholds, and the fields still apply. */
function LimitsBar({ max, simpleMax, mediumMax, change }: { max: number; simpleMax: number; mediumMax: number; change(simpleMax: number, mediumMax: number): void }): React.JSX.Element {
  const t = useT().board.workflowPanel
  const track = React.useRef<HTMLDivElement>(null)
  const total = Math.max(1, max), pct = (value: number): number => Math.max(0, Math.min(100, (value / total) * 100))
  const move = (which: 'simple' | 'medium', value: number): void => {
    const next = Math.round(value)
    if (which === 'simple') change(Math.max(0, Math.min(next, mediumMax - 1)), mediumMax)
    else change(simpleMax, Math.max(simpleMax + 1, Math.min(next, total)))
  }
  const drag = (which: 'simple' | 'medium') => (event: React.PointerEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    const rect = track.current?.getBoundingClientRect(); if (!rect) return
    const onMove = (e: PointerEvent): void => move(which, ((e.clientX - rect.left) / rect.width) * total)
    const up = (): void => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', up) }
    document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', up)
  }
  const key = (which: 'simple' | 'medium') => (event: React.KeyboardEvent): void => {
    const current = which === 'simple' ? simpleMax : mediumMax
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); move(which, current - 1) }
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); move(which, current + 1) }
  }
  return <div className="cx-limits">
    <div className="cx-lbar" ref={track}>
      <span className="seg simple" style={{ width: `${pct(simpleMax)}%` }}><b>{t.simple}</b></span>
      <span className="seg medium" style={{ width: `${pct(mediumMax) - pct(simpleMax)}%` }}><b>{t.medium}</b></span>
      <span className="seg complex" style={{ width: `${100 - pct(mediumMax)}%` }}><b>{t.complex}</b></span>
      <button type="button" className="knob" role="slider" aria-label={t.simpleLimit} aria-valuemin={0} aria-valuemax={total} aria-valuenow={simpleMax} style={{ left: `${pct(simpleMax)}%` }} onPointerDown={drag('simple')} onKeyDown={key('simple')}><i>{simpleMax}</i></button>
      <button type="button" className="knob" role="slider" aria-label={t.mediumLimit} aria-valuemin={0} aria-valuemax={total} aria-valuenow={mediumMax} style={{ left: `${pct(mediumMax)}%` }} onPointerDown={drag('medium')} onKeyDown={key('medium')}><i>{mediumMax}</i></button>
    </div>
    <div className="cx-lscale"><span>0</span><span>{total}</span></div>
    <div className="cx-weights">
      <label>{t.simpleUpTo}<input type="number" min={0} max={total} value={simpleMax} onChange={(event) => change(Math.max(0, Math.min(Number(event.target.value) || 0, mediumMax - 1)), mediumMax)} /></label>
      <label>{t.mediumUpTo}<input type="number" min={0} max={total} value={mediumMax} onChange={(event) => change(simpleMax, Math.max(simpleMax + 1, Math.min(Number(event.target.value) || 0, total)))} /></label>
      <label>{t.complex}<input disabled value={t.above(mediumMax)} /></label>
    </div>
  </div>
}
