import React, { useEffect, useRef, useState } from 'react'
import type { Project, SddConfig, IpcOutput } from '@gearmod/contracts'
import { plainError } from './NoticeDialog'
import { Select } from './Select'
import { ConstitutionPanel } from './ConstitutionPanel'
import { useT } from './i18n'
import { specRunFinishedEvent } from './specKitRun'

const FolderIcon = (): React.JSX.Element => <svg className="cx-foldico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
const slash = (value: string): string => value.replace(/\\/g, '/').replace(/\/$/, '')
const isAbsolute = (value: string): boolean => /^(?:[A-Za-z]:\/|\/)/.test(slash(value))

/** Versioned location; the content is edited in a card's worktree. */
export function SddSettings({ project, openConstitutionChat, onOpenReference }: { project: Project; openConstitutionChat(prompt?: string): void; onOpenReference(): void }): React.JSX.Element {
  const { board: tb, common } = useT(), t = tb.sddSettings
  const [config, setConfig] = useState<SddConfig>(), [branch, setBranch] = useState(project.baseBranch), [branches, setBranches] = useState<string[]>([])
  const [preview, setPreview] = useState<IpcOutput<'sdd:detect-constitutions'>>(), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [editRoot, setEditRoot] = useState(false), [editConstitution, setEditConstitution] = useState(false)
  // Bumped on each save: the Constitution panel below reads the file again from the new location.
  const [savedCount, setSavedCount] = useState(0)
  // The project's repositories are read again when something adds one (the Spec Kit start does), so the list and the choice do not wait for the dialog to be reopened.
  const [fresh, setFresh] = useState<Project>()
  const sources = (fresh ?? project).sources.filter((source) => source.isGitRepository)
  const source = sources.find((item) => item.id === config?.sourceId) ?? sources[0]
  useEffect(() => { void window.gearmod.invoke('sdd:config-get', { projectId: project.id }).then(setConfig).catch((e) => setMessage(plainError(e))) }, [project.id])
  useEffect(() => { void window.gearmod.invoke('projects:list', undefined).then((items) => { const current = items.find((item) => item.id === project.id); if (current) { setBranch(current.baseBranch); setFresh(current) } }).catch((e) => setMessage(plainError(e))) }, [project.id])
  useEffect(() => { if (!source) { setBranches([]); return }; void window.gearmod.invoke('projects:branches', { localPath: source.localPath }).then(setBranches).catch((e) => setMessage(plainError(e))) }, [source?.id, source?.localPath])
  // A Spec Kit start that just ended may have changed this configuration (repository and Constitution path): read it again.
  useEffect(() => {
    const again = (event: Event): void => {
      if ((event as CustomEvent<string>).detail !== project.id) return
      void window.gearmod.invoke('projects:list', undefined).then((items) => setFresh(items.find((item) => item.id === project.id))).catch(() => undefined)
      void window.gearmod.invoke('sdd:config-get', { projectId: project.id }).then((next) => { setConfig(next); setSavedCount((count) => count + 1) }).catch(() => undefined)
    }
    const listChanged = (): void => { void window.gearmod.invoke('projects:list', undefined).then((items) => setFresh(items.find((item) => item.id === project.id))).catch(() => undefined) }
    window.addEventListener(specRunFinishedEvent, again); window.addEventListener('gearmod:board-changed', listChanged)
    return () => { window.removeEventListener(specRunFinishedEvent, again); window.removeEventListener('gearmod:board-changed', listChanged) }
  }, [project.id])
  const save = async (): Promise<void> => {
    if (!config || !source) return
    setBusy(true); setMessage(''); setPreview(undefined)
    try {
      // Validate the branch before persisting the location, so a typo cannot silently become the base.
      await window.gearmod.invoke('projects:set-base-branch', { projectId: project.id, sourceId: source.id, branch })
      setConfig(await window.gearmod.invoke('sdd:config-set', { projectId: project.id, config }))
      setSavedCount((count) => count + 1)
      setMessage(t.saved)
    } catch (e) { setMessage(plainError(e)) } finally { setBusy(false) }
  }
  // Saves on its own at each change (after a moment), without a button: the first loaded value does not count as a change.
  const lastSaved = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!config || !source) return
    const snapshot = JSON.stringify({ config, branch })
    if (lastSaved.current === undefined) { lastSaved.current = snapshot; return }
    if (lastSaved.current === snapshot || !branch) return
    const timer = window.setTimeout(() => { lastSaved.current = snapshot; void save() }, 700)
    return () => window.clearTimeout(timer)
  }, [config, branch])
  if (!config) return <p>{message || t.loadingLocation}</p>
  const set = (patch: Partial<SddConfig>): void => { setConfig({ ...config, ...patch }); setPreview(undefined) }
  const relativeToSource = (path: string): string => {
    if (!source) return path
    const base = slash(source.localPath).toLowerCase(), candidate = slash(path), compared = candidate.toLowerCase()
    if (compared === base) return ''
    if (!compared.startsWith(`${base}/`)) throw new Error(t.chooseInside)
    return candidate.slice(base.length + 1)
  }
  const absolutePath = (path: string): string => !source || isAbsolute(path) ? path : [source.localPath, path].filter(Boolean).join('\\')
  const constitutionFile = config.constitution[config.method]
  const constitutionFolder = /\/constitution\.md$/i.test(slash(constitutionFile)) ? slash(constitutionFile).replace(/\/constitution\.md$/i, '') : constitutionFile
  const chooseFolder = async (kind: 'root' | 'constitution'): Promise<void> => {
    try {
      const path = await window.gearmod.invoke('projects:choose-directory', { projectId: project.id })
      if (!path) return
      const relative = relativeToSource(path)
      if (kind === 'root') set({ root: relative })
      else set({ constitution: { ...config.constitution, [config.method]: [relative, 'constitution.md'].filter(Boolean).join('/') } })
    } catch (reason) { setMessage(plainError(reason)) }
  }
  const chooseConstitutionSource = (method: SddConfig['method']): void => {
    const isSpecKit = method === 'speckit'
    set({
      method,
      root: '',
      constitution: {
        ...config.constitution,
        [method]: isSpecKit ? '.specify/memory/constitution.md' : '.gearmod/constitution.md'
      },
      ...(isSpecKit ? { featuresDir: 'specs' } : {})
    })
    setMessage(isSpecKit ? t.specKitSelected : t.gearModSelected)
  }
  return <section className="cx-wfcard"><h4 className="cx-labelrow">{t.title}<button type="button" className="cx-tiny" disabled={busy} onClick={() => { setMessage(''); void window.gearmod.invoke('sdd:detect-constitutions', { projectId: project.id }).then(setPreview).catch((e) => setMessage(plainError(e))) }}>{t.detect}</button></h4>
    <p className="cx-note">{t.note}</p>
    {!sources.length ? <p className="error">{t.addGitRepo}</p> : <div className="stack">
      <div className="f"><span>{t.repository}</span><Select label={t.sddRepository} value={config.sourceId ?? ''} options={[{ value: '', label: t.firstGitRepo }, ...sources.map((item) => ({ value: item.id, label: item.name }))]} onChange={(value) => set({ sourceId: value || null })} /></div>
      <div className="f"><span>{t.projectBaseBranch}</span><Select label={t.projectBaseBranch} value={branch} options={[...(!branches.includes(branch) && branch ? [{ value: branch, label: t.notFound(branch) }] : []), ...branches.map((name) => ({ value: name, label: name }))]} onChange={setBranch} /></div>
      <div className="f"><span>{t.sddFolder}</span>{!editRoot ? <div className="cx-pathrow"><span className="cx-pathchip big"><b>{config.root ? t.chosenFolder : t.repoRoot}</b><code>{absolutePath(config.root)}</code><FolderIcon /></span><button type="button" className="mini secondary" onClick={() => setEditRoot(true)}>{common.edit}</button></div> : <div className="cx-add"><input value={config.root} onChange={(event) => set({ root: event.target.value })} placeholder={t.repoRoot} /><button type="button" className="mini secondary" onClick={() => void chooseFolder('root')}>{t.choose}</button><button type="button" className="mini" onClick={() => setEditRoot(false)}>{t.done}</button></div>}</div>
      <div className="f"><span className="cx-labelrow">{t.constitutionPath(config.method === 'native' ? t.methodNames.native : t.methodNames.speckit)}<button type="button" className="cx-tiny" disabled={busy} onClick={() => chooseConstitutionSource(config.method === 'native' ? 'speckit' : 'native')}>{config.method === 'native' ? t.useSpecKitPath : t.useGearModPath}</button></span>{!editConstitution ? <div className="cx-pathrow"><span className="cx-pathchip big"><b>{t.chosenFolder}</b><code>{absolutePath(constitutionFolder)}</code><FolderIcon /></span><button type="button" className="mini secondary" onClick={() => setEditConstitution(true)}>{common.edit}</button></div> : <div className="cx-add"><input value={constitutionFolder} onChange={(event) => set({ constitution: { ...config.constitution, [config.method]: [event.target.value, 'constitution.md'].filter(Boolean).join('/') } })} placeholder={config.method === 'native' ? '.gearmod' : '.specify/memory'} /><button type="button" className="mini secondary" onClick={() => void chooseFolder('constitution')}>{t.choose}</button><button type="button" className="mini" onClick={() => setEditConstitution(false)}>{t.done}</button></div>}</div>
      <section className="cx-wfcard"><span className="sectitle">{t.constitution}</span><ConstitutionPanel projectId={project.id} reloadKey={savedCount} openChat={openConstitutionChat} onOpenReference={onOpenReference} /></section>
    </div>}
    {message && <p role="status">{message}</p>}
    {preview && <div><p>{t.result(preview.kind, preview.action)}</p>{(['db', 'native', 'speckit'] as const).map((key) => <p key={key}><b>{key}</b>: {preview.candidates[key]?.sha256 ?? t.absent}</p>)}</div>}
  </section>
}
