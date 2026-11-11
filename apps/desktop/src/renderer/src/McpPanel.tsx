import React, { useCallback, useEffect, useState, useRef } from 'react'
import type { McpPreset, McpServer, McpServerInput } from '@gearmod/contracts'
import { ConfirmDialog } from './ConfirmDialog'
import { plainError } from './NoticeDialog'
import { Select } from './Select'
import { Switch } from './Switch'
import { toast } from './toasts'
import { useEscape } from './useEscape'
import { useT } from './i18n'
import { EyeIcon, EyeOffIcon, SearchIcon } from './icons'

type Provider = McpServer['providers'][number]
const providerNames: Record<Provider, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }
type Draft = { id?: string; name: string; presetId: string | null; transport: 'stdio' | 'http'; sse: boolean; command: string; argsText: string; url: string; env: Array<{ key: string; value: string; set: boolean }>; headers: Array<{ key: string; value: string; set: boolean }>; providers: Provider[]; enabled: boolean }
const blank = (providers: Provider[]): Draft => ({ name: '', presetId: null, transport: 'stdio', sse: false, command: '', argsText: '', url: '', env: [], headers: [], providers, enabled: true })
const fromServer = (server: McpServer): Draft => ({ id: server.id, name: server.name, presetId: server.presetId, transport: server.transport, sse: server.sse, command: server.command, argsText: server.args.join('\n'), url: server.url, env: server.env.map((item) => ({ key: item.key, value: '', set: item.set })), headers: server.headers.map((item) => ({ key: item.key, value: '', set: item.set })), providers: server.providers, enabled: server.enabled })
const fromPreset = (preset: McpPreset, providers: Provider[]): Draft => ({ name: preset.id.replace(/[^a-z0-9_-]/gi, '-'), presetId: preset.id, transport: preset.transport, sse: false, command: preset.command, argsText: preset.args.join('\n'), url: '', env: preset.env.map((key) => ({ key, value: '', set: false })), headers: preset.headers.map((key) => ({ key, value: '', set: false })), providers, enabled: true })
/** A name the registry accepts (letters, numbers, "-" and "_", up to 40): other characters become "-". */
const slugName = (raw: string): string => raw.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40)
const argsOf = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter(Boolean)
const summary = (draft: Draft): string => draft.transport === 'stdio' ? `${draft.command} ${argsOf(draft.argsText).join(' ')}`.trim() : draft.url
// Example argument like "<allowed folder>": must be replaced before saving.
const hasPlaceholder = (text: string): boolean => /<[^>]+>/.test(text)

/** Public catalogs where to look for more servers; they open in the default browser. */
const catalogs = [{ key: 'official', url: 'https://github.com/modelcontextprotocol/servers' }, { key: 'mcpso', url: 'https://mcp.so' }, { key: 'smithery', url: 'https://smithery.ai' }, { key: 'glama', url: 'https://glama.ai/mcp/servers' }] as const

/** "Find more: [a] [b]" line. The links open in the default browser through the `app:open-link` channel (main only accepts http(s) and mailto). */
export function CatalogLinks({ label, links }: { label: string; links: ReadonlyArray<{ label: string; url: string }> }): React.JSX.Element {
  const t = useT()
  const open = (url: string): void => { void window.gearmod.invoke('app:open-link', { url }).catch((reason: unknown) => toast.error(t.shell.markdown.couldNotOpenLink, plainError(reason))) }
  return <p className="catlinks"><span>{label}</span>{links.map((link) => <button type="button" key={link.url} className="catlink tip" data-tip={link.url} onClick={() => open(link.url)}>{link.label}<span aria-hidden="true">↗</span></button>)}</p>
}

/** MCP servers: recommended (presets not yet installed), installed, and registration in a dialog. `scope="global"` in Settings; `scope="project"` on the project screen. */
export function McpPanel({ scope, projectId, available }: { scope: 'global' | 'project'; projectId?: string; available: Provider[] }): React.JSX.Element {
  const t = useT(), tm = t.settings.mcp
  const [items, setItems] = useState<McpServer[]>([]), [presets, setPresets] = useState<McpPreset[]>([]), [dialog, setDialog] = useState<{ draft: Draft; preset?: McpPreset }>(), [removing, setRemoving] = useState<McpServer>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const reload = useCallback(async (): Promise<void> => { try { setItems(await window.gearmod.invoke('mcp:list', projectId ? { projectId } : {})); setError('') } catch (reason) { setError(plainError(reason)) } }, [projectId])
  useEffect(() => { void reload(); void window.gearmod.invoke('mcp:presets', undefined).then(setPresets).catch(() => undefined) }, [reload])
  const [importing, setImporting] = useState(false), [detected, setDetected] = useState<{ path: string | null; servers: Array<{ name: string; kind: string; exists: boolean }> }>()
  const [view, setView] = useState<'mine' | 'discover'>('mine'), [query, setQuery] = useState(''), [addMenu, setAddMenu] = useState(false)
  const addRef = useRef<HTMLDivElement>(null)
  // The "Add" menu closes on a click outside it and on Escape.
  useEffect(() => {
    if (!addMenu) return
    const away = (event: MouseEvent): void => { if (!addRef.current?.contains(event.target as Node)) setAddMenu(false) }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') setAddMenu(false) }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key) }
  }, [addMenu])
  // The project's own .mcp.json is only looked at: nothing runs until the user chooses to import.
  useEffect(() => { if (scope === 'project' && projectId) void window.gearmod.invoke('mcp:detect', { projectId }).then(setDetected).catch(() => undefined) }, [scope, projectId, items])
  const visible = scope === 'global' ? items.filter((item) => item.scope === 'global') : items
  // The generic "remote" preset is not a real server: manual registration (Remote type) already covers that case.
  const recommended = presets.filter((item) => item.id !== 'remote' && !visible.some((server) => server.presetId === item.id))
  const needle = query.trim().toLowerCase()
  const matches = (...parts: string[]): boolean => !needle || parts.some((part) => part.toLowerCase().includes(needle))
  const shownInstalled = visible.filter((server) => matches(server.name, server.url, server.command))
  const shownRecommended = recommended.filter((item) => matches(item.label, item.description))
  const run = async (task: () => Promise<unknown>): Promise<void> => { setBusy(true); setError(''); try { await task(); await reload() } catch (reason) { setError(plainError(reason)) } finally { setBusy(false) } }
  // Returns the error for the dialog to show (the dialog stays open); null when saved.
  const save = async (draft: Draft): Promise<string | null> => {
    const input: McpServerInput = { ...(draft.id ? { id: draft.id } : {}), scope, ...(scope === 'project' ? { projectId } : {}), name: slugName(draft.name), presetId: draft.presetId, transport: draft.transport, sse: draft.sse, command: draft.command, args: argsOf(draft.argsText), url: draft.url, env: draft.env.map(({ key, value }) => ({ key, value })), headers: draft.headers.map(({ key, value }) => ({ key, value })), providers: draft.providers, enabled: draft.enabled }
    setBusy(true)
    try { await window.gearmod.invoke('mcp:save', input); setDialog(undefined); await reload(); return null } catch (reason) { return plainError(reason) } finally { setBusy(false) }
  }
  return <div className="mcp">
    <div className="mcp-bar">
      <h4>{tm.title}</h4>
      <div className="mcp-seg" role="tablist" aria-label={tm.title}>
        <button type="button" role="tab" aria-selected={view === 'mine'} className={view === 'mine' ? 'on' : ''} onClick={() => setView('mine')}>{tm.tabMine}{visible.length > 0 && <small>{visible.length}</small>}</button>
        <button type="button" role="tab" aria-selected={view === 'discover'} className={view === 'discover' ? 'on' : ''} onClick={() => setView('discover')}>{tm.tabDiscover}</button>
      </div>
      <label className="mcp-search"><SearchIcon /><input value={query} placeholder={tm.search} aria-label={tm.search} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="mcp-add" ref={addRef}>
        <button type="button" className="mini mcp-add-btn" aria-haspopup="menu" aria-expanded={addMenu} onClick={() => setAddMenu(!addMenu)}>{tm.addButton} <span aria-hidden="true">▾</span></button>
        {addMenu && <div className="mcp-add-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setAddMenu(false); setDialog({ draft: blank(available) }) }}>{tm.addManual}</button>
          <button type="button" role="menuitem" onClick={() => { setAddMenu(false); setImporting(true) }}>{tm.importJson}</button>
        </div>}
      </div>
    </div>
    <p className="mcp-intro">{tm.intro(scope === 'project')}</p>
    {scope === 'project' && detected && detected.servers.some((item) => !item.exists) && <div className="mcp-detected" role="status"><div><b>{tm.detectedTitle}</b><p>{tm.detectedText(detected.servers.filter((item) => !item.exists).map((item) => item.name))}</p><small className="hint">{tm.detectedWarn}</small></div><button type="button" className="mini" disabled={busy} onClick={() => void run(async () => { const result = await window.gearmod.invoke('mcp:import', { scope: 'project', projectId: projectId!, fromProjectFile: true }); toast.success(tm.imported(result.added.length, result.skipped.length)) })}>{tm.detectedImport}</button></div>}
    {error && <p className="error" role="alert">{error}</p>}
    {view === 'mine'
      ? <section className="mcp-sec">
        {!visible.length && <p className="mcp-empty">{tm.empty}</p>}
        {visible.length > 0 && !shownInstalled.length && <p className="mcp-empty">{tm.noMatches}</p>}
        {shownInstalled.length > 0 && <ul className="mcp-list">{shownInstalled.map((server) => <li key={server.id} className={server.enabled && !server.disabledHere ? '' : 'off'}>
        <div className="mcp-main"><b>{server.name}</b><small>{server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}`.trim() : server.url}</small>
          <span className="mcp-tags">{scope === 'project' && <em>{server.scope === 'global' ? tm.global : tm.thisProjectOnly}</em>}{server.providers.map((provider) => <em key={provider}>{providerNames[provider]}</em>)}{server.env.some((item) => !item.set) || server.headers.some((item) => !item.set) ? <em className="warn">{tm.missingValue}</em> : null}</span></div>
        <div className="mcp-actions">
          {scope === 'project' && server.scope === 'global'
            ? <Switch className="dbsw" tip={tm.projectToggleTip} checked={!server.disabledHere} disabled={busy || !server.enabled} onChange={(value) => void run(() => window.gearmod.invoke('mcp:set-project-enabled', { projectId: projectId!, id: server.id, enabled: value }))}>{tm.inThisProject}</Switch>
            : <Switch className="dbsw" checked={server.enabled} disabled={busy} onChange={(value) => void run(() => window.gearmod.invoke('mcp:save', { id: server.id, scope: server.scope, ...(server.projectId ? { projectId: server.projectId } : {}), name: server.name, presetId: server.presetId, transport: server.transport, command: server.command, args: server.args, url: server.url, env: server.env.map((item) => ({ key: item.key })), headers: server.headers.map((item) => ({ key: item.key })), providers: server.providers, enabled: value }))}>{tm.on}</Switch>}
          {(scope === 'global' ? server.scope === 'global' : server.scope === 'project') && <><button type="button" className="mini secondary" onClick={() => setDialog({ draft: fromServer(server), preset: presets.find((item) => item.id === server.presetId) })}>{t.common.edit}</button><button type="button" className="mini secondary" onClick={() => setRemoving(server)}>{t.common.remove}</button></>}
        </div></li>)}</ul>}
      </section>
      : <section className="mcp-sec">
        {shownRecommended.length ? <ul className="mcp-grid">{shownRecommended.map((item) => <li key={item.id}><button type="button" className="mcp-card" disabled={busy} data-tip={tm.addPreset(item.label)} aria-label={tm.addPreset(item.label)} onClick={() => setDialog({ draft: fromPreset(item, available), preset: item })}>
          <span className="mcp-avatar" aria-hidden="true">{item.label.slice(0, 1).toUpperCase()}</span>
          <span className="mcp-main"><b>{item.label}</b><small className="desc">{item.description}</small></span></button></li>)}</ul>
          : <p className="mcp-empty">{recommended.length ? tm.noMatches : tm.allRecommendedInstalled}</p>}
        <CatalogLinks label={tm.browseMore} links={catalogs.map((item) => ({ label: tm.catalogs[item.key], url: item.url }))} />
      </section>}
    {importing && <McpImportDialog scope={scope} projectId={projectId} cancel={() => setImporting(false)} done={() => { setImporting(false); void reload() }} />}
    {dialog && <McpDialog initial={dialog.draft} preset={dialog.preset} available={available} busy={busy} cancel={() => setDialog(undefined)} save={save} />}
    {removing && <ConfirmDialog eyebrow="MCP" title={tm.removeTitle(removing.name)} text={tm.removeText} ok={t.common.remove} danger cancel={() => setRemoving(undefined)} confirm={() => { const target = removing; setRemoving(undefined); void run(() => window.gearmod.invoke('mcp:delete', { id: target.id })) }} />}
  </div>
}

/**
 * Registration dialog, in three uses: manual (full form); recommended (confirmation with what will be added and only the fields
 * still to fill in; "Edit all fields" opens the full form); editing an installed server (full form).
 */
function McpDialog({ initial, preset, available, busy, cancel, save }: { initial: Draft; preset?: McpPreset; available: Provider[]; busy: boolean; cancel(): void; save(draft: Draft): Promise<string | null> }): React.JSX.Element {
  const t = useT(), tm = t.settings.mcp
  const [draft, setDraft] = useState(initial), [full, setFull] = useState(Boolean(initial.id) || !preset), [error, setError] = useState('')
  useEscape(cancel)
  // An old server may use an agent that is no longer offered (Gemini): it keeps showing so it can be turned off.
  const [options] = useState<Provider[]>(() => [...available, ...initial.providers.filter((item) => !available.includes(item))])
  const title = draft.id ? tm.editServer : preset ? tm.addPreset(preset.label) : tm.addServer
  const missing = !draft.name.trim() ? tm.needName : !draft.providers.length ? tm.needAgent
    : draft.transport === 'stdio' ? (!draft.command.trim() ? tm.needCommand : hasPlaceholder(draft.argsText) ? tm.needArgs : '') : !draft.url.trim() ? tm.needUrl : ''
  const submit = async (): Promise<void> => { if (missing) { setError(missing); return } setError(''); const failure = await save(draft); if (failure) setError(failure) }
  const nameField = <label className="f">{t.common.name}<input className="in" value={draft.name} autoFocus={!preset} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={tm.namePlaceholder} />{draft.name.trim() && slugName(draft.name) !== draft.name.trim() && <small className="hint">{tm.nameWillBe(slugName(draft.name))}</small>}</label>
  const agents = <fieldset className="mcp-agents"><legend>{tm.agentsUsing}</legend>{options.map((provider) => <Switch key={provider} className="dbsw" checked={draft.providers.includes(provider)} onChange={(value) => setDraft({ ...draft, providers: value ? [...draft.providers, provider] : draft.providers.filter((item) => item !== provider) })}>{providerNames[provider]}</Switch>)}</fieldset>
  return <div className="overlay top" role="dialog" aria-label={title}><div className="modal mcp-dialog" style={{ width: 'min(760px,100%)' }}>
    <header><div><div className="eyebrow">MCP</div><h2>{title}</h2></div><button type="button" className="x" onClick={cancel} aria-label={t.common.close}>×</button></header>
    {preset?.note && <p className="mcp-note">{preset.note}</p>}
    <div className="dbform stack">
      {!full ? <>
        <div className="mcp-preview"><span className="eyebrow">{tm.willAdd}</span><b>{preset?.label}</b>{preset?.description && <small>{preset.description}</small>}{draft.transport === 'stdio' && <code>{summary(draft)}</code>}</div>
        {nameField}
        {draft.transport === 'stdio' && hasPlaceholder(preset?.args.join('\n') ?? '') && <label className="f">{tm.args}<textarea className="in" rows={3} value={draft.argsText} onChange={(event) => setDraft({ ...draft, argsText: event.target.value })} /><small className="mcp-warn">{tm.replacePlaceholder}</small></label>}
        {draft.transport === 'http' && <label className="f">URL<input className="in" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder={draft.sse ? 'https://…/sse' : 'https://…/mcp'} /></label>}
        {draft.env.length > 0 && <KeyValues title={tm.envVars} rows={draft.env} fixed change={(env) => setDraft({ ...draft, env })} />}
        {draft.headers.length > 0 && <KeyValues title={tm.headers} rows={draft.headers} fixed change={(headers) => setDraft({ ...draft, headers })} />}
        {agents}
        {draft.transport === 'stdio' && <p className="mcp-warn">{tm.localWarn}</p>}
        <button type="button" className="mini secondary" style={{ justifySelf: 'start' }} onClick={() => setFull(true)}>{tm.editAll}</button>
      </> : <>
        <div className="dbrow">{nameField}
          <div className="f"><span>{tm.type}</span><Select label={tm.type} value={draft.transport === 'stdio' ? 'stdio' : draft.sse ? 'sse' : 'http'} options={[{ value: 'stdio', label: tm.local }, { value: 'http', label: tm.remote }, { value: 'sse', label: tm.remoteSse }]} onChange={(value) => setDraft({ ...draft, transport: value === 'stdio' ? 'stdio' : 'http', sse: value === 'sse' })} />{draft.transport === 'http' && draft.sse && <small className="hint">{tm.sseHint}</small>}</div></div>
        {draft.transport === 'stdio' ? <>
          <label className="f">{tm.command}<input className="in" value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" /></label>
          <label className="f">{tm.args}<textarea className="in" rows={3} value={draft.argsText} onChange={(event) => setDraft({ ...draft, argsText: event.target.value })} /></label>
          <KeyValues title={tm.envVars} rows={draft.env} change={(env) => setDraft({ ...draft, env })} />
          <p className="mcp-warn">{tm.localWarn}</p></> : <>
          <label className="f">URL<input className="in" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://…/mcp" /></label>
          <KeyValues title={tm.headers} rows={draft.headers} change={(headers) => setDraft({ ...draft, headers })} /></>}
        {agents}
      </>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
    <div className="actions"><button type="button" className="secondary" disabled={busy} onClick={cancel}>{t.common.cancel}</button><button type="button" disabled={busy} onClick={() => void submit()}>{draft.id ? t.common.save : t.common.add}</button></div>
  </div></div>
}

/** Name/value pairs (environment variables or headers). `fixed`: the names come from the preset, only the value is editable. */
function KeyValues({ title, rows, change, fixed = false }: { title: string; rows: Draft['env']; change(rows: Draft['env']): void; fixed?: boolean }): React.JSX.Element {
  const t = useT(), tm = t.settings.mcp
  const [shown, setShown] = useState<Set<number>>(new Set())
  const toggle = (index: number): void => setShown((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next })
  return <div className="f"><span>{title}</span>
    {rows.map((row, index) => <div className={`mcp-kv ${fixed ? 'fixed' : ''}`} key={index}>
      <input className="in" aria-label={t.common.name} value={row.key} readOnly={fixed} placeholder={tm.keyPlaceholder} onChange={(event) => change(rows.map((item, at) => at === index ? { ...item, key: event.target.value } : item))} />
      <span className="pwfield"><input className="in" aria-label={tm.valueAria} type={shown.has(index) ? 'text' : 'password'} autoComplete="new-password" value={row.value} placeholder={row.set ? tm.valueSet : tm.valuePlaceholder} onChange={(event) => change(rows.map((item, at) => at === index ? { ...item, value: event.target.value } : item))} />
        <button type="button" className="pwtoggle tip" data-tip={shown.has(index) ? tm.hideValue : tm.showValue} aria-label={shown.has(index) ? tm.hideValue : tm.showValue} aria-pressed={shown.has(index)} onClick={() => toggle(index)}>{shown.has(index) ? <EyeOffIcon /> : <EyeIcon />}</button></span>
      {!fixed && <button type="button" className="mini secondary" aria-label={tm.removeRow} onClick={() => change(rows.filter((_, at) => at !== index))}>×</button>}</div>)}
    {!fixed && <button type="button" className="mini secondary" style={{ justifySelf: 'start' }} onClick={() => change([...rows, { key: '', value: '', set: false }])}>{tm.addRow}</button>}</div>
}

/** Paste the JSON that other tools use (`{ "mcpServers": { ... } }`) and register every server in it. */
function McpImportDialog({ scope, projectId, cancel, done }: { scope: 'global' | 'project'; projectId?: string; cancel(): void; done(): void }): React.JSX.Element {
  const t = useT(), tm = t.settings.mcp
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEscape(cancel)
  const submit = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      const result = await window.gearmod.invoke('mcp:import', { scope, ...(scope === 'project' ? { projectId } : {}), text })
      toast.success(tm.imported(result.added.length, result.skipped.length)); done()
    } catch (reason) { setError(plainError(reason)) } finally { setBusy(false) }
  }
  return <div className="overlay top" role="dialog" aria-label={tm.importTitle}><div className="modal mcp-dialog" style={{ width: 'min(640px,100%)' }}>
    <header><div><div className="eyebrow">MCP</div><h2>{tm.importTitle}</h2></div><button type="button" className="x" onClick={cancel} aria-label={t.common.close}>×</button></header>
    <div className="dbform stack">
      <p className="mcp-note">{tm.importHint}</p>
      <textarea className="in mcp-json" rows={12} spellCheck={false} autoFocus value={text} onChange={(event) => setText(event.target.value)} placeholder={'{\n  "mcpServers": {\n    "my-server": { "type": "sse", "url": "https://…/sse", "headers": { "Authorization": "Bearer …" } }\n  }\n}'} />
      {error && <p className="error" role="alert">{error}</p>}
    </div>
    <div className="actions"><button type="button" className="secondary" onClick={cancel}>{t.common.cancel}</button><button type="button" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? t.common.saving : tm.importButton}</button></div>
  </div></div>
}
