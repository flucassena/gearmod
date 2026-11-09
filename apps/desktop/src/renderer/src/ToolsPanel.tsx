import React, { useCallback, useEffect, useState } from 'react'
import type { SpecKitRunInput, ToolsFolderInfo, ToolsStatus, WorkflowConfig } from '@gearmod/contracts'
import { plainError } from './NoticeDialog'
import { Select } from './Select'
import { PlaywrightSection } from './PlaywrightSection'
import { terminal } from './terminalStore'
import { SpecKitRunDialog } from './SpecKitRunDialog'
import { cachedStatus, probeTools, toolsChangedEvent } from './toolsStatusCache'
import { checkedAgo, isOutdated, loadLatest, useLatestVersions } from './toolUpdates'
import { specKitInstallCommand, specKitUpdateCeiling, specKitUpdateState } from './specKitUpdates'
import { useT } from './i18n'

const pendingByProject = new Map<string, boolean>()
const pendingListeners = new Set<(projectId: string, pending: boolean) => void>()
const pendingChecks = new Map<string, Promise<void>>()

/** Is the Playwright version in use in this project older than the latest published or one already downloaded? (only if one is installed and selected) */
async function playwrightOutdated(projectId: string, latest: string | null | undefined): Promise<boolean> {
  try {
    const status = await window.gearmod.invoke('playwright:status', { projectId })
    if (!status.selected) return false
    // Newer than the one in use: the latest published or one already downloaded (e.g. by another project, since the versions are shared).
    return [latest ?? null, ...status.versions.map((item) => item.version)].some((candidate) => isOutdated(status.selected, candidate))
  } catch { return false }
}

/** The gear and the tab share the last result, without waiting for another check when the dialog opens. They light up for Spec Kit and Playwright CLI. */
export function useToolsPending(projectId: string): boolean {
  const latest = useLatestVersions(), [state, setState] = useState(() => ({ projectId, pending: pendingByProject.get(projectId) ?? false }))
  useEffect(() => {
    const listen = (id: string, pending: boolean): void => { if (id === projectId) setState({ projectId: id, pending }) }
    pendingListeners.add(listen); setState({ projectId, pending: pendingByProject.get(projectId) ?? false })
    const compute = (): Promise<void> => Promise.all([Promise.resolve(cachedStatus(projectId)), playwrightOutdated(projectId, latest?.versions.playwright)]).then(([tools, playwright]) => {
      const pending = Boolean((tools && isOutdated(tools.specify.version, latest?.versions.specify ?? null)) || playwright)
      pendingByProject.set(projectId, pending); pendingListeners.forEach((listener) => listener(projectId, pending))
    }).catch(() => undefined)
    const key = `${projectId}:${latest?.checkedAt}`
    if (latest && !pendingChecks.has(key)) pendingChecks.set(key, compute().finally(() => pendingChecks.delete(key)))
    // The Playwright section announces when something was installed, selected or removed: the dot is recalculated at once.
    const changed = (event: Event): void => { if (latest && (event as CustomEvent<string>).detail === projectId) void compute() }
    window.addEventListener('gearmod:playwright-changed', changed); window.addEventListener(toolsChangedEvent, changed)
    return () => { pendingListeners.delete(listen); window.removeEventListener('gearmod:playwright-changed', changed); window.removeEventListener(toolsChangedEvent, changed) }
  }, [projectId, latest?.checkedAt])
  return state.projectId === projectId ? state.pending : pendingByProject.get(projectId) ?? false
}

const windows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)
const safeName = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)

/** `run` makes the button open the terminal dialog; without it the command goes to the terminal panel at the bottom, as before. */
interface Step { label: string; command: string; next?: string | undefined; disabled?: string | undefined; run?: SpecKitRunInput | undefined }

/** Project Tools tab: Spec Kit runs in the app terminal. The tools are probed when the tab opens (a few quick `--version` calls); "Search for updates" repeats it and asks for the latest versions. */
export function ToolsPanel({ projectId, openedTerminal }: { projectId: string; openedTerminal(): void }): React.JSX.Element {
  const t = useT(), tt = t.settings.tools
  const [status, setStatus] = useState<ToolsStatus | undefined>(() => cachedStatus(projectId)), [error, setError] = useState(''), [checking, setChecking] = useState(false), [config, setConfig] = useState<WorkflowConfig>()
  const [specRepo, setSpecRepo] = useState(''), latest = useLatestVersions()
  const [probing, setProbing] = useState(false), [specRun, setSpecRun] = useState<{ input: SpecKitRunInput; title: string }>(), [custom, setCustom] = useState<{ path: string; name: string; info: ToolsFolderInfo }>(), [folderBusy, setFolderBusy] = useState(false)
  const refresh = useCallback(async (): Promise<void> => {
    try { const next = await probeTools(projectId); setStatus(next); setError(''); setSpecRepo((current) => next.repos.some((repo) => repo.sourceId === current) ? current : next.repos.find((repo) => repo.specKit)?.sourceId ?? next.repos[0]?.sourceId ?? '') } catch (reason) { setError(plainError(reason)) }
  }, [projectId])
  useEffect(() => { const saved = cachedStatus(projectId); setStatus(saved); if (saved) setSpecRepo((current) => saved.repos.some((repo) => repo.sourceId === current) ? current : saved.repos.find((repo) => repo.specKit)?.sourceId ?? saved.repos[0]?.sourceId ?? ''); void window.gearmod.invoke('workflow:get', { projectId }).then((state) => setConfig(state.config)).catch(() => undefined) }, [projectId])
  // Opening the tab already looks at what is installed, so nobody has to press "Search for updates" just to see it.
  useEffect(() => { setProbing(true); void refresh().finally(() => setProbing(false)) }, [refresh])
  // After "Search for updates" (or the terminal commands) the chosen folder is looked at again: it may have become a repository or got Spec Kit.
  useEffect(() => { if (!custom) return; void window.gearmod.invoke('tools:inspect-folder', { path: custom.path }).then((info) => setCustom((current) => (current && current.path === custom.path ? { ...current, info } : current))).catch(() => undefined) }, [status])
  // Whoever probes the tools again (this panel, or a Spec Kit command that just ended in the background) updates what is shown here.
  useEffect(() => {
    const changed = (event: Event): void => { if ((event as CustomEvent<string>).detail === projectId) setStatus(cachedStatus(projectId)) }
    window.addEventListener(toolsChangedEvent, changed); return () => window.removeEventListener(toolsChangedEvent, changed)
  }, [projectId])
  const verify = async (): Promise<void> => { setChecking(true); await Promise.all([refresh(), loadLatest(true).catch(() => undefined)]); setChecking(false) }
  const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path
  // Any folder can host Spec Kit, not only the project's repositories: a folder that is not a repository gets one (`git init`) before `specify init`.
  const pickFolder = async (): Promise<void> => {
    try {
      setFolderBusy(true); setError('')
      const path = await window.gearmod.invoke('projects:choose-directory', { projectId })
      if (!path) return
      setCustom({ path, name: folderName(path), info: await window.gearmod.invoke('tools:inspect-folder', { path }) }); setSpecRepo('__custom__')
    } catch (reason) { setError(plainError(reason)) } finally { setFolderBusy(false) }
  }
  const addFolderToProject = async (): Promise<void> => {
    if (!custom) return
    try {
      setFolderBusy(true); setError('')
      await window.gearmod.invoke('projects:add-repositories', { projectId, localPath: custom.path })
      window.dispatchEvent(new Event('gearmod:board-changed')); setCustom(undefined); await refresh()
    } catch (reason) { setError(plainError(reason)) } finally { setFolderBusy(false) }
  }
  const togglePlaywright = (value: boolean): void => { if (!config) return; const next = { ...config, playwrightCli: value }; setConfig(next); void window.gearmod.invoke('workflow:set', { projectId, config: next }).then((state) => setConfig(state.config)).catch((reason) => setError(plainError(reason))) }
  const folder = (id: string): string => (id === '__custom__' ? custom?.path : status?.repos.find((repo) => repo.sourceId === id)?.path) ?? ''
  const run = async (command: string, id: string): Promise<void> => { const path = folder(id); if (!path) return; setError(''); if (await terminal.runIn({ projectId, cardId: null, path }, command)) openedTerminal(); else setError(tt.cannotOpenTerminal) }
  const upToDate = (installed: string | null): { from: string; to: string } | null => installed && latest?.versions.specify && isOutdated(installed, latest.versions.specify) ? { from: installed, to: latest.versions.specify } : null

  // The buttons sit side by side; each one's "Next step" goes on its own line below (otherwise it widens the first button's column and pushes the others away).
  const buttons = (steps: Step[], repoId: string): React.JSX.Element => <div className="tl-steps"><div className="tl-btns">{steps.map((step) => <button key={step.label + step.command} type="button" className="mini" disabled={Boolean(step.disabled) || !folder(repoId)} data-tip={step.disabled ?? tt.runTip(folder(repoId), step.command)} onClick={() => { if (step.run) setSpecRun({ input: { ...step.run, ...(step.run.kind === 'init' || step.run.kind === 'init-with-git' || step.run.kind === 'upgrade-integration' ? { path: folder(repoId) } : {}) }, title: step.label }); else void run(step.command, repoId) }}>{step.label}</button>)}</div>
</div>
  // Only repositories that have the tool become a chip; the rest are summarized in one sentence (names appear on hover).
  type RepoInfo = NonNullable<typeof status>['repos'][number]
  const startedChips = (started: (repo: RepoInfo) => boolean, detail: (repo: RepoInfo) => string): React.JSX.Element => {
    const all = status?.repos ?? [], on = all.filter(started), off = all.filter((repo) => !started(repo))
    return <>{on.map((repo) => {
      const versions = Object.values(repo.specKitVersions ?? {}), files = versions.length ? versions.sort((a, b) => (isOutdated(a, b) ? -1 : 1))[0]! : null
      const old = Boolean(files && status?.specify.version && isOutdated(files, status.specify.version))
      return <span key={repo.sourceId} className={`pw-chip ${old ? 'warn' : 'ok'}`} data-tip={old ? tt.filesOutdatedTip(repo.path, files!, status!.specify.version!) : files ? tt.filesVersion(repo.path, files) : repo.path}>{tt.started(repo.name, detail(repo))}{old ? ` · ${tt.filesOutdated}` : ''}</span>
    })}{off.length > 0 && <span className="pw-chip muted" data-tip={off.map((repo) => repo.name).join(', ')}>{on.length ? tt.notStartedSome(off.length) : tt.notStartedAny}</span>}</>
  }

  // Project files written by an older Spec Kit than the CLI (or of unknown version): only then the "update files" step shows up.
  const filesOutdated = (files: string | undefined): boolean => !files || Boolean(status?.specify.version && isOutdated(files, status.specify.version))
  const spec = specRepo === '__custom__' && custom ? { sourceId: '__custom__', name: custom.name, path: custom.path, specKit: custom.info.hasSpecKit, specKitIntegrations: custom.info.integrations, specKitVersions: custom.info.integrationVersions, openSpec: false } : status?.repos.find((repo) => repo.sourceId === specRepo)
  const needsRepo = specRepo === '__custom__' && custom !== undefined && !custom.info.isRepo && !custom.info.parentRepo
  const customOutside = custom !== undefined && !(status?.repos ?? []).some((repo) => repo.path.toLowerCase() === custom.path.toLowerCase())
  const specPicker = status ? <div className="f tl-repo"><span>{tt.specKitRepo}</span>
    <Select label={tt.specKitRepo} value={specRepo} options={[...status.repos.map((repo) => ({ value: repo.sourceId, label: repo.name })), ...(custom ? [{ value: '__custom__', label: tt.customFolder(custom.name), sub: custom.path }] : []), { value: '__other__', label: tt.otherFolder }]} onChange={(value) => { if (value === '__other__') void pickFolder(); else setSpecRepo(value) }} />
    {specRepo === '__custom__' && custom && <small className="hint">{custom.info.parentRepo ? tt.folderInsideRepo(custom.info.parentRepo) : custom.info.isRepo ? tt.folderIsRepo : tt.folderNotRepo}</small>}
    {specRepo === '__custom__' && custom && custom.info.isRepo && customOutside && <div><button type="button" className="mini secondary" disabled={folderBusy} onClick={() => void addFolderToProject()}>{tt.addFolderToProject}</button></div>}
  </div> : null
  const specOld = status ? upToDate(status.specify.version) : null
  const specUpdate = specKitUpdateState(status?.specify.version ?? null, latest?.versions.specify ?? null)
  const specSteps: Step[] = !status ? [] : [
    ...(!status.uv ? [{ label: tt.installUv, command: windows ? 'winget install --id=astral-sh.uv -e' : 'curl -LsSf https://astral.sh/uv/install.sh | sh', next: specKitInstallCommand, run: { kind: 'install-uv' as const } }] : []),
    ...(status.uv && !status.specify.installed ? [{ label: tt.installCli, command: specKitInstallCommand, next: 'specify init --here', run: { kind: 'install-cli' as const, version: specKitUpdateCeiling } }] : []),
    ...(status.specify.installed && spec && !spec.specKit ? [{ label: needsRepo ? tt.createRepoAndStart : tt.startInRepo, command: needsRepo ? 'git init; specify init --here' : 'specify init --here', run: { kind: needsRepo ? 'init-with-git' as const : 'init' as const } }] : []),
    ...(specUpdate.canUpdate ? [{ label: tt.updateCli(specKitUpdateCeiling), command: `${specKitInstallCommand} --force`, run: { kind: 'update-cli' as const, version: specKitUpdateCeiling } }] : []),
    ...(status.specify.installed && spec?.specKit ? (spec.specKitIntegrations.filter(safeName).length ? spec.specKitIntegrations.filter(safeName).filter((name) => filesOutdated(spec.specKitVersions[name])).map((name) => ({ label: tt.updateFiles(spec.specKitIntegrations.length > 1 ? name : ''), command: `specify integration upgrade ${name}`, run: { kind: 'upgrade-integration' as const, integration: name } })) : [{ label: tt.updateFiles(''), command: 'specify integration upgrade', disabled: tt.integrationNotDetected }]) : [])
  ]
  const notice = (old: { from: string; to: string } | null): React.JSX.Element | null => old ? <p className="pw-warn" role="status">{tt.updateAvailable(old.from, old.to)}</p> : null
  return <div className="cx-wfpanel">
    <div className="cx-autosave" role="status">{latest?.error ? <span className="cx-warn">{latest.error}</span> : latest?.checkedAt ? tt.checked(checkedAgo(latest.checkedAt)) : tt.notChecked} · <button type="button" className="linklike" disabled={checking} onClick={() => void verify()}>{checking ? tt.checking : tt.searchUpdates}</button></div>
    {error && <div className="cx-error">{error}</div>}
    {specRun && <SpecKitRunDialog projectId={projectId} input={specRun.input} title={specRun.title} close={() => setSpecRun(undefined)} />}
    <section className="cx-wfcard tl-card">
      <header className="tl-head"><h4>Spec Kit (GitHub)</h4></header>
      {status ? <>
        <div className="tl-facts">
          {(!status.uv || !status.python) && <div className="tl-fact"><span className="tl-flabel">{tt.factNeeds}</span><div className="pw-chips">
            {!status.uv && <span className="pw-chip warn">{tt.uvMissing}</span>}
            {!status.python && <span className="pw-chip muted" data-tip={tt.pythonTip}>{tt.pythonMissing}</span>}</div></div>}
          <div className="tl-fact"><span className="tl-flabel">{tt.factCli}</span><div className="pw-chips"><span className={`pw-chip ${status.specify.installed ? 'ok' : 'muted'}`}>{status.specify.installed ? <><i aria-hidden="true" />specify{status.specify.version ? ` · v${status.specify.version}` : ''}</> : tt.specifyNotInstalled}</span></div></div>
          <div className="tl-fact"><span className="tl-flabel">{tt.factRepos}</span><div className="pw-chips">{startedChips((repo) => repo.specKit, (repo) => repo.specKitIntegrations.length ? ` · ${repo.specKitIntegrations.join(', ')}` : '')}</div></div>
        </div>
        <div className="tl-reporow">{specPicker}{specSteps.length > 0 && buttons(specSteps, specRepo)}</div>
        {notice(specOld)}
        {specUpdate.newerAvailable && <p className="pw-warn" role="status">{tt.newerThanCeiling(specKitUpdateCeiling)}</p>}
      </> : <><p className="cx-muted">{probing ? tt.checking : tt.noSavedCheck}</p></>}
    </section>
    <PlaywrightSection projectId={projectId} enabled={config?.playwrightCli ?? false} toggle={togglePlaywright} latest={latest?.versions.playwright ?? null} />
  </div>
}
