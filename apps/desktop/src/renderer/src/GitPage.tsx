import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Chevron, SparkIcon, WarningIcon } from './icons'
import { errorCodeOf, withoutErrorCode, type AgentProfile, type GitChange, type GitCommitFile, type GitGraph, type GitRepo, type GitRow, type ProjectBoard, type PullRequestSummary } from '@gearmod/contracts'
import { AgentIcon } from './AgentIcon'
import { GitSide } from './GitSide'
import { PrPanel, PrScreen } from './PrPanel'
import type { PullRequestsState } from './usePullRequests'
import { GitMenu, branchItems, commitItems, stashItems, type BranchAction, type CommitMenuAction, type StashMenuAction } from './BranchMenu'
import { ConfirmDialog } from './ConfirmDialog'
import { PushRejectedDialog } from './PushRejectedDialog'
import { ConflictsView, operationLabel, type ConflictTarget } from './ConflictsView'
import { GitDiffEditor } from './editor/GitDiffEditor'
import { openInEditor } from './openInEditor'
import { toast } from './toasts'
import { GitEmpty, GitUpstreamDialog as UpstreamDialog, gitChangedEvent } from './GitSetup'
import { plainError } from './NoticeDialog'
import { agoLabel, commitDateLong, commitDateTime, ghostChip, graphEdges, initials, isWip, laneColor, laneSpacing, laneX, refChips, rowHeight, shortAgo, splitPath, type RefChip } from './gitView'
import { Checkbox } from './Checkbox'
import { ExternalWorktreeDeleteDialog, WorktreeDeleteDialog } from './WorktreeDelete'
import { FileContextMenu, type FileMenuItem } from './FileContextMenu'
import { useAsk } from './useAsk'
import { useEscape } from './useEscape'
import { useT } from './i18n'
import { gravatarEnabled } from './gravatarSetting'
import { branchNameProblem } from './branchName'

const I = (children: React.ReactNode): React.JSX.Element => <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">{children}</svg>
export const gitIcons = {
  branch: I(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10" /><path d="M18 9c0 5-12 3-12 8" /></>),
  repo: I(<><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" /><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3" /></>),
  cloud: I(<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.2 4.5 4.5 0 0 0 7 18z" />),
  pc: I(<><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></>),
  folder: I(<path d="M3.5 6.8c0-1 .8-1.8 1.8-1.8h4l2 2h7.4c1 0 1.8.8 1.8 1.8v8.4c0 1-.8 1.8-1.8 1.8H5.3c-1 0-1.8-.8-1.8-1.8z" />),
  stash: I(<><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" /><path d="M10 13h4" /></>),
  fetch: I(<><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>),
  pull: I(<><path d="M12 4v12" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" /></>),
  push: I(<><path d="M12 20V8" /><path d="m7 13 5-5 5 5" /><path d="M5 4h14" /></>),
  graph: I(<><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="12" r="2" /><path d="M6 8v8" /><path d="M8 6c6 0 8 2 8 4" /></>),
  head: I(<path d="m5 12.5 4.5 4.5L19 7.5" />),
  pen: I(<path d="M4 20h4L19 9l-4-4L4 16z" />),
  trash: I(<><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" /></>),
  tree: I(<><path d="m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z" /><path d="M12 22v-3" /></>),
  tag: I(<><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="8.5" r="1" /></>),
  card: I(<><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h5" /></>),
  undo: I(<><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>),
  redo: I(<><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></>)
}

/** Card icon in the corner of the detail: on click shows title, branch and the card's actions in a bubble, without taking up the panel. */
function CardButton({ cardId, title, branch, focus, setFocus, openCardGit }: { cardId: string; title: string; branch?: string | null; focus: string | null; setFocus(id: string | null): void; openCardGit(cardId: string): void }): React.JSX.Element {
  const T = useT(), t = T.git.page
  const [open, setOpen] = useState(false), box = useRef<HTMLDivElement>(null), pop = useRef<HTMLDivElement>(null)
  // The bubble goes to the body (fixed), so the graph panel does not clip it and the side panel does not cover it; it stays inside the window.
  const [at, setAt] = useState<{ top: number; left: number }>()
  useLayoutEffect(() => {
    if (!open) { setAt(undefined); return }
    const place = (): void => {
      const anchor = box.current?.getBoundingClientRect(), width = pop.current?.offsetWidth ?? 300, height = pop.current?.offsetHeight ?? 0
      if (!anchor) return
      const left = Math.min(Math.max(8, anchor.right - width), window.innerWidth - width - 8)
      const below = anchor.bottom + 6, top = below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 6) : below
      setAt({ top, left })
    }
    place()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const out = (event: MouseEvent): void => { const target = event.target as Node; if (!box.current?.contains(target) && !pop.current?.contains(target)) setOpen(false) }
    const esc = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', out); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc) }
  }, [open])
  const on = focus === cardId
  return <div ref={box} className="gcardbtnwrap">
    <button type="button" className={`gcardbtn ${on ? 'on' : ''}`} data-tip={title} aria-label={`${T.common.card}: ${title}`} aria-expanded={open} onClick={() => setOpen(!open)}>{gitIcons.card}</button>
    {open && createPortal(<div ref={pop} className="gcardpop" role="dialog" aria-label={T.common.card} style={at ? { top: at.top, left: at.left } : { visibility: 'hidden', top: 0, left: 0 }}><small>{T.common.card}</small><b>{title}</b>{branch && <span className="gcardpopbr" data-tip={branch}>{branch}</span>}
      <div className="cgrow"><button type="button" className="mini" onClick={() => { setOpen(false); openCardGit(cardId) }}>{t.openCardGit}</button><button type="button" className="mini secondary" onClick={() => setFocus(on ? null : cardId)}>{on ? t.showAllCommits : t.onlyThisCard}</button></div></div>, document.body)}
  </div>
}

/** App checkbox (same markup as the other screens). */
export function GitCheck({ checked, onChange, label }: { checked: boolean; onChange(value: boolean): void; label?: string }): React.JSX.Element {
  return <Checkbox checked={checked} onChange={onChange} label={label} />
}

export function FileCounts({ files }: { files: Array<{ additions: number; deletions: number }> }): React.JSX.Element {
  const add = files.reduce((sum, file) => sum + file.additions, 0), del = files.reduce((sum, file) => sum + file.deletions, 0)
  return <span className="nums"><span className="p">+{add}</span> <span className="m">−{del}</span></span>
}

export function FileRow({ file, onOpen }: { file: GitCommitFile | GitChange; onOpen?(): void }): React.JSX.Element {
  return <div className={`gfile ${onOpen ? 'click' : ''}`} role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : undefined} onClick={onOpen} onKeyDown={onOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } } : undefined}><span className={`st ${file.status}`}>{file.status}</span><span className="pth" data-tip={file.path}>{file.path}</span><span className="nums"><span className="p">+{file.additions}</span> <span className="m">−{file.deletions}</span></span></div>
}

function Chip({ chip, worktrees = [], remotes = [], pick, open }: { chip: RefChip; worktrees?: GitGraph['worktrees']; remotes?: string[]; pick?(): void; open?(): void }): React.JSX.Element {
  const t = useT().git.page
  // In the list that opens on hover the name already shows in full and the system tooltip only gets in the way, hence no `title` when it is clickable.
  const label = [chip.name, chip.local && t.chipLocal, chip.remote && (remotes.length ? remotes.join(', ') : t.chipRemote), chip.tag && t.chipTag, ...worktrees.map((wt) => t.chipWorktree(wt.title, wt.path))].filter(Boolean).join(' · ')
  const props = pick ? { role: 'button', tabIndex: 0, 'aria-label': label, title: label, onClick: (event: React.MouseEvent) => { event.stopPropagation(); pick() }, onDoubleClick: (event: React.MouseEvent) => { event.stopPropagation(); open?.() }, onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Enter') { event.stopPropagation(); open?.() } } } : { title: label }
  return <span className={`rchip ${chip.head ? 'head' : ''} ${pick ? 'pick' : ''}`} {...props}>
    {chip.head && gitIcons.head}<span className="rn">{chip.name}</span>{chip.tag && gitIcons.tag}{chip.local && gitIcons.pc}{chip.remote && gitIcons.cloud}{worktrees.length > 0 && gitIcons.tree}</span>
}

function RefsCell({ row, ghost, spacing, worktrees, act }: { row: GitRow; ghost: RefChip | null; spacing: number; worktrees: GitGraph['worktrees']; act(kind: 'local' | 'remote', name: string, open: boolean): void }): React.JSX.Element {
  const chips = refChips(row.refs), style = { '--lc': laneColor(row.lane), '--lx': `${laneX(row.lane, spacing) - 12}px` } as React.CSSProperties
  const details = (chip: RefChip): { worktrees: GitGraph['worktrees']; remotes: string[] } => ({ worktrees: chip.local && !chip.tag ? worktrees.filter((wt) => wt.branch === chip.name) : [], remotes: row.refs.filter((ref) => ref.kind === 'remote' && ref.name.replace(/^[^/]+\//, '') === chip.name).map((ref) => ref.name.split('/')[0]!) })
  if (!chips.length) return ghost ? <span className="grefs ghost" style={style}><span className="grefs-in"><Chip chip={ghost} /></span></span> : <span className="grefs" />
  return <span className={`grefs ${chips.length > 1 ? 'multi' : ''}`} style={style}><span className="grefs-in">{chips.map((chip) => <Chip key={chip.name} chip={chip} {...details(chip)} />)}</span>
    <span className="gstack">{chips.map((chip) => {
      // Labels (tags) are not branches; the others open the local one, or the remote one when only it exists.
      const remote = row.refs.find((ref) => ref.kind === 'remote' && ref.name.replace(/^[^/]+\//, '') === chip.name)?.name
      const target = chip.tag ? null : chip.local ? { kind: 'local' as const, name: chip.name } : remote ? { kind: 'remote' as const, name: remote } : null
      return <Chip key={chip.name} chip={chip} {...details(chip)} {...(target ? { pick: () => act(target.kind, target.name, false), open: () => act(target.kind, target.name, true) } : {})} />
    })}</span>{chips.length > 1 && <span className="rmore">+{chips.length - 1}</span>}</span>
}

/** Author photo from Gravatar (the same service GitKraken uses): only the email hash leaves the app; with no registered photo, the initials stay. */
const gravatars = new Map<string, Promise<string | null>>()
function gravatarUrl(email: string): Promise<string | null> {
  const key = email.trim().toLowerCase()
  if (!key || !globalThis.crypto?.subtle) return Promise.resolve(null)
  let found = gravatars.get(key)
  if (!found) {
    found = crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)).then((buffer) => {
      const hash = Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')
      const url = `https://gravatar.com/avatar/${hash}?s=64&d=404`
      return new Promise<string | null>((resolve) => { const image = new Image(); image.onload = () => resolve(url); image.onerror = () => resolve(null); image.src = url })
    }).catch(() => null)
    gravatars.set(key, found)
  }
  return found
}
function useGravatar(email: string): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true; setUrl(null)
    void gravatarEnabled().then((enabled) => enabled ? gravatarUrl(email) : null).then((value) => { if (alive) setUrl(value) })
    return () => { alive = false }
  }, [email])
  return url
}

function Dot({ row, profiles, spacing }: { row: GitRow; profiles: AgentProfile[]; spacing: number }): React.JSX.Element {
  const t = useT().git.page
  const style = { left: laneX(row.lane, spacing), '--lc': laneColor(row.lane) } as React.CSSProperties
  if (isWip(row)) return <span className="gdot wip" style={style} />
  if (row.stash) return <span className="gdot gstashdot" style={style} data-tip={row.stash.ref}>{gitIcons.stash}</span>
  const agent = profiles.find((profile) => profile.id === row.agentProfileId), photo = useGravatar(row.email)
  return <span className="gdot tip" style={style} data-tip={row.email ? `${row.author} · ${row.email}` : row.author}>{photo ? <img className="gphoto" src={photo} alt="" /> : <b>{initials(row.author)}</b>}{agent && <span className="gdotag tip" data-tip={t.commitBy(agent.label)}><AgentIcon profile={agent} size="sm" tip={false} /></span>}</span>
}

function Who({ row, profiles }: { row: GitRow; profiles: AgentProfile[] }): React.JSX.Element {
  const t = useT().git.page
  const agent = profiles.find((profile) => profile.id === row.agentProfileId)
  const photo = useGravatar(row.email)
  return <><span className="me tip" data-tip={row.author}>{photo ? <img className="gphoto" src={photo} alt="" /> : initials(row.author)}</span><span className="gname">{row.author}</span>{agent && <span className="gvia tip" data-tip={t.commitBy(agent.label)}><AgentIcon profile={agent} size="sm" tip={false} /></span>}</>
}

/** WIP detail, as in GitKraken: unstaged and staged files and the commit below. */
function WipForm({ row, graph, summary, setSummary, changed, openDiff }: { row: GitRow; graph: GitGraph; summary: string; setSummary(value: string): void; changed(): void; openDiff(file: GitChange): void }): React.JSX.Element {
  const t = useT().git.page, tc = useT().git.cardPanel
  const sourceId = graph.repo.sourceId, cardId = row.cardId
  const [suggesting, setSuggesting] = useState(false)
  const [files, setFiles] = useState<GitChange[]>([]), [last, setLast] = useState(''), [description, setDescription] = useState(''), [amend, setAmend] = useState(false)
  const [closed, setClosed] = useState<{ un?: boolean; on?: boolean }>({}), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [split, setSplit] = useState(50), listsRef = useRef<HTMLDivElement>(null)
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; file: GitChange }>(), [pending, setPending] = useState<{ kind: 'discard' | 'stash'; paths: string[] }>()
  const [sectionMenu, setSectionMenu] = useState<{ x: number; y: number }>()
  const resizeLists = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const move = (e: PointerEvent): void => {
      const bounds = listsRef.current?.getBoundingClientRect()
      if (bounds?.height) setSplit(Math.max(10, Math.min(90, (e.clientY - bounds.top) / bounds.height * 100)))
    }
    const finish = (): void => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish) }
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish)
  }
  const load = useCallback(async () => { try { const state = await window.gearmod.invoke('git:changes', { sourceId, cardId }); setFiles(state.files); setLast(state.lastMessage) } catch (reason) { setError(plainError(reason)) } }, [sourceId, cardId])
  useEffect(() => { void load() }, [load, row.wip?.modified, row.wip?.added, row.wip?.deleted, row.wip?.staged])
  useEffect(() => { const refresh = (): void => { void load() }; window.addEventListener(gitChangedEvent, refresh); return () => window.removeEventListener(gitChangedEvent, refresh) }, [load])
  const unstaged = files.filter((file) => !file.staged), staged = files.filter((file) => file.staged)
  const stage = async (paths: string[], value: boolean): Promise<void> => {
    try { setError(''); const state = await window.gearmod.invoke('git:stage', { sourceId, cardId, paths, stage: value }); setFiles(state.files); changed() } catch (reason) { setError(plainError(reason)) }
  }
  const perform = async (action: 'discard' | 'stash', paths: string[]): Promise<void> => {
    try { setError(''); const state = action === 'discard' ? await window.gearmod.invoke('git:discard-unstaged', { sourceId, cardId, paths }) : await window.gearmod.invoke('git:stash-file', { sourceId, cardId, path: paths[0]! }); setFiles(state.files); changed() } catch (reason) { setError(plainError(reason)) }
  }
  const ignore = async (path: string, kind: 'file' | 'directory' | 'extension'): Promise<void> => {
    try { const state = await window.gearmod.invoke('git:ignore-file', { sourceId, cardId, path, kind }); setFiles(state.files); changed(); toast.info(t.ignoreAdded) } catch (reason) { setError(plainError(reason)) }
  }
  const menuItems = (file: GitChange): FileMenuItem[] => {
    const { dir, name } = splitPath(file.path), extension = /\.[^.]+$/.exec(name)?.[0]
    const external = async (target: 'explorer'): Promise<void> => { try { const found = await window.gearmod.invoke('git:file-path', { sourceId, cardId, path: file.path }); await window.gearmod.invoke('workspace:external', { ...found, cardId, target }) } catch (reason) { setError(plainError(reason)) } }
    const edit = async (): Promise<void> => { try { const found = await window.gearmod.invoke('git:file-path', { sourceId, cardId, path: file.path }); await window.gearmod.invoke('windows:open', { kind: 'file', projectId: found.projectId, cardId: cardId ?? undefined, path: found.path, placement: 'new' }) } catch (reason) { setError(plainError(reason)) } }
    return [
      { label: file.staged ? t.unstageFile : t.stageFile, action: () => void stage([file.path], !file.staged) },
      ...(!file.staged ? [{ label: t.discardChanges, action: () => setPending({ kind: 'discard' as const, paths: [file.path] }) }] : []),
      { label: t.ignoreMenu, children: [{ label: t.ignoreName(name), action: () => void ignore(file.path, 'file') }, { label: t.ignoreExtension(extension), disabled: !extension, action: () => void ignore(file.path, 'extension') }, { label: t.ignoreFolder(dir), disabled: !dir, action: () => void ignore(file.path, 'directory') }] },
      { label: t.stashFile, action: () => setPending({ kind: 'stash', paths: [file.path] }) },
      { label: t.openInFiles, separator: true, action: () => void openInEditor({ sourceId, cardId, path: file.path }).catch((reason: unknown) => setError(plainError(reason))) },
      { label: t.editFile, action: () => void edit() },
      { label: t.copyFilePath, action: () => void navigator.clipboard.writeText(file.path).catch(() => toast.error(t.copyFailed, t.clipboardDenied)) },
      { label: t.showInFolder, action: () => void external('explorer') }
    ]
  }
  const commit = async (): Promise<void> => {
    setBusy(true); setError('')
    try { await window.gearmod.invoke('git:commit', { sourceId, cardId, message: summary.trim(), description: description.trim() || undefined, amend }); setSummary(''); setDescription(''); setAmend(false); await load(); changed() } catch (reason) { setError(plainError(reason)) } finally { setBusy(false) }
  }
  // AI suggestion (a simple model, in the repository's commit convention) from what is staged, or from every change when nothing is.
  const suggest = async (): Promise<void> => {
    const paths = [...new Set((staged.length ? staged : files).map((file) => file.path))]
    if (!paths.length) return setError(tc.checkOneFile)
    setSuggesting(true); setError('')
    try { setSummary((await window.gearmod.invoke('git:suggest-message', { sourceId, cardId, paths })).message) } catch (reason) { setError(plainError(reason)) } finally { setSuggesting(false) }
  }
  const lines = (list: GitChange[], isStaged: boolean): React.JSX.Element => <>{list.map((file) => {
    const { dir, name } = splitPath(file.path), key = `${isStaged ? 's' : 'u'}:${file.path}`
    return <React.Fragment key={key}><div className="gwrow" data-tip={file.path} onContextMenu={(event) => { event.preventDefault(); setFileMenu({ x: event.clientX, y: event.clientY, file }) }}><span className={`st ${file.status}`}>{file.status === 'M' ? gitIcons.pen : file.status === 'A' ? '+' : '−'}</span>
      <button type="button" className="gwp" onClick={() => openDiff(file)}>{dir && <span className="dir">{dir}</span>}<b>{name}</b></button>
      <button type="button" className={`gwbtn ${isStaged ? 'un' : ''}`} onClick={() => void stage([file.path], !isStaged)}>{isStaged ? t.unstageShort : t.stageShort}</button></div>
      </React.Fragment>
  })}{!list.length && <div className="gwempty">{t.nothingHere}</div>}</>
  const section = (id: 'un' | 'on', title: string, list: GitChange[], isStaged: boolean): React.JSX.Element => <div className={`gwsec ${closed[id] ? 'closed' : ''}`} style={{ flexGrow: closed[id] ? 0 : closed[id === 'un' ? 'on' : 'un'] ? 1 : id === 'un' ? split : 100 - split }}><div className="gwsech" onContextMenu={!isStaged && list.length ? (event) => { event.preventDefault(); setSectionMenu({ x: event.clientX, y: event.clientY }) } : undefined}>
    <button type="button" className="gwtog" onClick={() => setClosed({ ...closed, [id]: !closed[id] })}><Chevron open={!closed[id]} />{title} ({list.length})</button>
    {list.length > 0 && <span className="gwsection-actions">{!isStaged && <button type="button" className="gwdiscard" data-tip={t.discardAllTip} aria-label={t.discardAllTip} onClick={() => setPending({ kind: 'discard', paths: list.map((file) => file.path) })}>{gitIcons.trash}</button>}<button type="button" className={`gwall ${isStaged ? 'un' : ''}`} onClick={() => void stage([], !isStaged)}>{isStaged ? t.unstageAll : t.stageAll}</button></span>}</div>
    {!closed[id] && <div className="gwlist">{lines(list, isStaged)}</div>}</div>
  const toggleAmend = (value: boolean): void => { setAmend(value); if (value && !summary.trim()) setSummary(last); else if (!value && summary === last) setSummary('') }
  const ready = staged.length > 0 || amend, count = Array.from(new Set(staged.map((file) => file.path))).length
  return <div className="gwform"><div className="gwtop"><span>{t.filesChangedIn(new Set(files.map((file) => file.path)).size)} <code>{row.wip?.branch}</code></span></div>
    <div className="gwlists" ref={listsRef}>{section('un', t.unstagedTitle, unstaged, false)}{!closed.un && !closed.on && <div className="gwresize" role="separator" aria-label={t.resizeLists} aria-orientation="horizontal" aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(split)} tabIndex={0} onPointerDown={resizeLists} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setSplit((value) => Math.max(10, Math.min(90, value + (event.key === 'ArrowUp' ? -5 : 5)))) } }} />}{section('on', t.stagedTitle, staged, true)}</div>
    <div className="gwcommit"><label className="gwamend"><GitCheck checked={amend} onChange={toggleAmend} label={t.amend} /> {t.amendWithHint}</label>
      <div className="gwmsg"><div className="gwsumrow"><input maxLength={120} placeholder={t.summaryPlaceholder} value={summary} onChange={(e) => setSummary(e.target.value)} /><span className={`gwcount ${summary.length > 72 ? 'over' : ''}`}>{72 - summary.length}</span><button type="button" className="cgai" data-tip={suggesting ? tc.suggesting : tc.suggestTip} aria-label={tc.suggestWithAi} disabled={busy || suggesting || !files.length} onClick={() => void suggest()}><SparkIcon /></button></div>
        <textarea className="autogrow" placeholder={t.descriptionPlaceholder} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      {error && <p className="error">{error}</p>}
      <button type="button" className="gwgo" disabled={!ready || busy || (!amend && !summary.trim())} onClick={() => void commit()}>{amend ? t.amend : staged.length ? t.commitFiles(count) : t.stageFirst}</button></div>
    {fileMenu && <FileContextMenu x={fileMenu.x} y={fileMenu.y} items={menuItems(fileMenu.file)} close={() => setFileMenu(undefined)} />}
    {sectionMenu && <FileContextMenu x={sectionMenu.x} y={sectionMenu.y} label={t.unstagedActions} items={[{ label: t.stageAll, action: () => void stage([], true) }, { label: t.discardAll, action: () => setPending({ kind: 'discard', paths: unstaged.map((file) => file.path) }) }]} close={() => setSectionMenu(undefined)} />}
    {pending && <ConfirmDialog eyebrow={pending.kind === 'stash' ? t.stashFile : t.discardChanges} title={pending.kind === 'stash' ? t.stashTitle(pending.paths[0]!) : pending.paths.length === 1 ? t.discardTitleOne(pending.paths[0]!) : t.discardTitleMany(pending.paths.length)} text={pending.kind === 'stash' ? t.stashText : `${t.discardText} ${t.undoHint}`} ok={pending.kind === 'stash' ? t.stashOk : t.discardChanges} danger={pending.kind === 'discard'} cancel={() => setPending(undefined)} confirm={() => { const action = pending; setPending(undefined); void perform(action.kind, action.paths) }} />}</div>
}

function CommitDetail({ row, graph, profiles, board, focus, setFocus, openCardGit, openFile, editMessage, renaming }: { row: GitRow; graph: GitGraph; profiles: AgentProfile[]; board: ProjectBoard; focus: string | null; setFocus(id: string | null): void; openCardGit(cardId: string): void; openFile(file: GitCommitFile): void; editMessage?(): void; renaming?: { value: string; change(value: string): void; submit(): void; cancel(): void } }): React.JSX.Element {
  const t = useT().git.page
  const [detail, setDetail] = useState<{ body: string; files: GitCommitFile[] }>(), [error, setError] = useState(''), [moreBody, setMoreBody] = useState(false)
  useEffect(() => { setDetail(undefined); setError(''); setMoreBody(false); void window.gearmod.invoke('git:commit-detail', { sourceId: graph.repo.sourceId, hash: row.hash }).then(setDetail).catch((reason: unknown) => setError(plainError(reason))) }, [graph.repo.sourceId, row.hash])
  const card = board.cards.find((item) => item.id === row.cardId), branch = graph.worktrees.find((item) => item.cardId === row.cardId)?.branch
  const files = detail?.files ?? []
  return <>
    {card && <CardButton cardId={card.id} title={card.title} branch={branch} focus={focus} setFocus={setFocus} openCardGit={openCardGit} />}
    <div className="gmeta"><span>{t.commitWord} <code>{row.short}</code>{row.parents.length > 1 ? t.mergeSuffix : ''}</span></div>{editMessage ? (renaming ? <input className="in gtitleedit" autoFocus aria-label={t.summary} maxLength={2000} value={renaming.value} onFocus={(event) => event.currentTarget.select()} onChange={(event) => renaming.change(event.target.value)} onBlur={renaming.cancel} onKeyDown={(event) => { if (event.key === 'Enter' && renaming.value.trim()) { event.preventDefault(); renaming.submit() } else if (event.key === 'Escape') { event.stopPropagation(); renaming.cancel() } }} /> : <button type="button" className="gstashname" data-tip={t.editLastMessageTip} onClick={editMessage}>{row.subject} {gitIcons.pen}</button>) : <h3>{row.subject}</h3>}
    <div className="gmeta"><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Who row={row} profiles={profiles} /> · {shortAgo(row.date)}</span><span>{row.parents.length > 0 && <>{t.parent} <code>{row.parents.map((hash) => hash.slice(0, 7)).join(', ')}</code> · </>}{row.date && <time dateTime={row.date} data-tip={commitDateLong(row.date)}>{commitDateTime(row.date)}</time>}</span></div>
    {detail?.body && detail.body !== row.subject && (() => { const text = detail.body.replace(row.subject, '').trim(), long = text.length > 180 || text.split('\n').length > 3; return <><p className={`gbody ${long && !moreBody ? 'short' : ''}`}>{text}</p>{long && <button type="button" className="gmore" aria-expanded={moreBody} onClick={() => setMoreBody(!moreBody)}>{moreBody ? t.seeLess : t.seeMore}</button>}</> })()}
    {!card && <div className="cgnote">{t.noCardCommit}</div>}
    {error ? <p className="error">{error}</p> : <><div className="cglabel">{t.filesCount(files.length)} · <FileCounts files={files} /></div><div className="gfiles">{files.map((file) => <FileRow key={file.path} file={file} onOpen={() => openFile(file)} />)}</div></>}
  </>
}

function StashDetail({ row, sourceId, cardId, busy, action, rename }: { row: GitRow; sourceId: string; cardId: string | null; busy: boolean; action(action: StashMenuAction, ref: string): void; rename(): void }): React.JSX.Element {
  const t = useT().git.page
  const [files, setFiles] = useState<GitCommitFile[]>(), [error, setError] = useState('')
  const stash = row.stash!
  useEffect(() => { let alive = true; setFiles(undefined); setError(''); void window.gearmod.invoke('git:stash-detail', { sourceId, cardId, ref: stash.ref, commit: stash.commit }).then((result) => { if (alive) setFiles(result.files) }).catch((reason: unknown) => { if (alive) setError(plainError(reason)) }); return () => { alive = false } }, [sourceId, cardId, stash.ref, stash.commit])
  return <><div className="gmeta"><span>{t.stashDetail(stash.ref)}</span></div><button type="button" className="gstashname" data-tip={t.editStashNameTip} onClick={rename}>{row.subject} {gitIcons.pen}</button><div className="gmeta"><span>{t.stashBase(row.parents[0]?.slice(0, 7))}</span></div><div className="cgrow">{stashItems().map((item) => <button type="button" className="mini secondary" key={item.key} disabled={busy} onClick={() => action(item.key, stash.ref)}>{item.label}</button>)}</div>{error ? <p className="error">{error}</p> : files ? <><div className="cglabel">{t.filesCount(files.length)} · <FileCounts files={files} /></div><div className="gfiles">{files.map((file) => <FileRow key={file.path} file={file} />)}</div></> : <p className="gmeta">{t.loadingFiles}</p>}</>
}

/** Changed file code (diff) in the graph area: opens on clicking a WIP file. */
function DiffView({ viewer, close, changed }: { viewer: { sourceId: string; cardId: string | null; hash?: string; file: GitChange }; close(): void; changed(): void }): React.JSX.Element {
  const { common, git: { page: t } } = useT()
  const { sourceId, cardId, file, hash } = viewer
  const [error, setError] = useState(''), [discard, setDiscard] = useState(false)
  const act = async (action: 'stage' | 'discard'): Promise<void> => { try { if (action === 'stage') await window.gearmod.invoke('git:stage', { sourceId, cardId, paths: [file.path], stage: !file.staged }); else await window.gearmod.invoke('git:discard-unstaged', { sourceId, cardId, paths: [file.path] }); window.dispatchEvent(new Event(gitChangedEvent)); changed(); close() } catch (reason) { setError(plainError(reason)) } }
  return <section className="gdiffview" style={{ gridColumn: '1 / span 2' }} aria-label={t.changesOf(file.path)}><header><span className={`st ${file.status}`}>{file.status}</span><b data-tip={file.path}>{file.path}</b><small>{hash ? t.commitHash(hash.slice(0, 7)) : file.staged ? t.staged : t.notStaged}</small><span className="gdstat"><span className="p">+{file.additions}</span> <span className="m">−{file.deletions}</span></span><span className="grow1" /><button type="button" className="fv-toggle" data-tip={t.openCurrentTip} onClick={() => void openInEditor({ sourceId, cardId, path: file.path }).then(close).catch((reason: unknown) => setError(plainError(reason)))}>{t.openInEditor}</button><button type="button" className="x" onClick={close} aria-label={common.close}>×</button></header>
    {!hash && <div className="gdiff-actions">{!file.staged && <button type="button" className="gwdiscard" data-tip={t.discardChanges} aria-label={t.discardChanges} onClick={() => setDiscard(true)}>{gitIcons.trash}</button>}<button type="button" className={`gwall ${file.staged ? 'un' : ''}`} onClick={() => void act('stage')}>{file.staged ? t.unstageFile : t.stageFile}</button></div>}
    <div className="gdiffbody">{error && <p className="error">{error}</p>}<GitDiffEditor sourceId={sourceId} cardId={cardId} path={file.path} hash={hash} mode={file.staged ? 'staged' : 'unstaged'} /></div>{discard && <ConfirmDialog eyebrow={t.discardChanges} title={t.discardTitleOne(file.path)} text={`${t.discardDiffText} ${t.undoHint}`} ok={t.discardChanges} danger cancel={() => setDiscard(false)} confirm={() => { setDiscard(false); void act('discard') }} />}</section>
}

type PullMode = 'fetch-all' | 'ff' | 'ff-only' | 'rebase'
const pullModes: PullMode[] = ['fetch-all', 'ff', 'ff-only', 'rebase']
const pullKey = 'gearmod.gitPull'
const loadPull = (): PullMode => { try { const value = localStorage.getItem(pullKey); return pullModes.some((id) => id === value) ? value as PullMode : 'ff' } catch { return 'ff' } }
/** Width of the two side columns (left sidebar and right detail): draggable, with minimum and maximum; double click goes back to the default. */
const paneLimits = { side: { min: 170, max: 420, def: 230 }, detail: { min: 270, max: 620, def: 330 } } as const
const paneKey = 'gearmod.gitPanes'
const loadPanes = (): { side: number; detail: number } => {
  try { const saved = JSON.parse(localStorage.getItem(paneKey) ?? '{}') as Partial<Record<'side' | 'detail', number>>; return { side: clamp(saved.side ?? paneLimits.side.def, 'side'), detail: clamp(saved.detail ?? paneLimits.detail.def, 'detail') } } catch { return { side: paneLimits.side.def, detail: paneLimits.detail.def } }
}
const clamp = (value: number, pane: 'side' | 'detail'): number => Math.max(paneLimits[pane].min, Math.min(paneLimits[pane].max, Math.round(value)))
const graphMin = 36
const colKey = 'gearmod.gitCols'
const loadCols = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(colKey) ?? '{}') as Record<string, number> } catch { return {} } }

function RepoTabs({ repos, selected, select, reorder, alerts, conflicts }: { repos: GitRepo[]; selected?: string; select(id: string): void; reorder(id: string, index: number): void; alerts(sourceId: string): number; conflicts: Array<ConflictTarget & { operation: keyof typeof operationLabel; files: string[] }> }): React.JSX.Element {
  const t = useT().git.page
  const [dragging, setDragging] = useState<string>(), [drop, setDrop] = useState<number>(), geometry = useRef<number[]>([]), dragWidth = useRef(0)
  const position = (x: number): number => { const index = geometry.current.findIndex((center) => x < center); return index < 0 ? geometry.current.length : index }
  let visibleIndex = 0
  const dragged = repos.find((repo) => repo.sourceId === dragging)
  const placeholder = dragged ? <span className="gtab gtab-placeholder" style={{ width: dragWidth.current }} aria-hidden="true">{gitIcons.repo}<span className="gtn">{dragged.name}</span></span> : null
  return <div className="gtabs" role="tablist" aria-label={t.reposAria} onDragOver={(event) => { if (!event.dataTransfer.types.includes('application/x-gearmod-git-repo')) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDrop(position(event.clientX)) }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(undefined) }} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData('application/x-gearmod-git-repo'); if (id) reorder(id, drop ?? position(event.clientX)); setDragging(undefined); setDrop(undefined) }}>
    {repos.map((repo) => { const index = repo.sourceId === dragging ? -1 : visibleIndex++; const flagged = conflicts.filter((entry) => entry.sourceId === repo.sourceId), total = flagged.reduce((sum, entry) => sum + entry.files.length, 0); return <React.Fragment key={repo.sourceId}>{index >= 0 && drop === index && placeholder}<button type="button" role="tab" data-repo-tab={repo.sourceId} aria-selected={repo.sourceId === selected} className={`gtab ${repo.sourceId === selected ? 'on' : ''} ${repo.sourceId === dragging ? 'dragging' : ''}`} draggable onDragStart={(event) => { const source = event.currentTarget, rect = source.getBoundingClientRect(), tabs = [...source.parentElement!.querySelectorAll<HTMLElement>('[data-repo-tab]')], sourceIndex = tabs.indexOf(source); dragWidth.current = Math.round(rect.width); geometry.current = tabs.filter((tab) => tab !== source).map((tab, i) => { const box = tab.getBoundingClientRect(); return box.left + box.width / 2 - (i >= sourceIndex ? rect.width + 4 : 0) }); window.setTimeout(() => { setDragging(repo.sourceId); setDrop(sourceIndex) }, 0); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-gearmod-git-repo', repo.sourceId) }} onDragEnd={() => { setDragging(undefined); setDrop(undefined); geometry.current = [] }} data-tip={`${repo.path}${repo.head ? ` · ${repo.head}` : ''}`} onClick={() => select(repo.sourceId)}>{gitIcons.repo}<span className="gtn">{repo.name}</span>{alerts(repo.sourceId) > 0 && <i className="ydot" data-tip={t.prsWithNews(alerts(repo.sourceId))} />}{flagged.length > 0 && <span className="gtab-conflict" data-tip={t.repoConflictOps(flagged.length)}>{t.conflictTab}{total ? ` · ${total}` : ''}</span>}</button></React.Fragment> })}
    {dragging && drop === visibleIndex && placeholder}
  </div>
}

const reposCacheKey = (projectId: string): string => `gearmod.gitRepos.${projectId}`
/** Last list of the project's repositories: tabs appear instantly and detection updates behind the scenes. */
function cachedRepos(projectId: string): GitRepo[] | undefined {
  try { const value: unknown = JSON.parse(localStorage.getItem(reposCacheKey(projectId)) ?? 'null'); const list = Array.isArray(value) ? value.filter((item): item is GitRepo => typeof item === 'object' && item !== null && typeof (item as GitRepo).sourceId === 'string' && typeof (item as GitRepo).name === 'string') : []; return list.length ? list : undefined } catch { return undefined }
}
/** Board Git tab: one repository at a time, branches/worktrees/stashes on the side, graph in the center and the commit detail on the right. */
export function GitPage({ board, prs, profiles, openCardGit, focusRequest }: { board: ProjectBoard; prs: PullRequestsState; profiles: AgentProfile[]; openCardGit(cardId: string): void; focusRequest?: { cardId: string; at: number } }): React.JSX.Element {
  const T = useT(), t = T.git.page, common = T.common
  const projectId = board.project.id
  const [repos, setRepos] = useState<GitRepo[] | undefined>(() => cachedRepos(projectId)), [repoId, setRepoId] = useState<string | undefined>(() => { const list = cachedRepos(projectId); if (!list) return undefined; try { const saved = localStorage.getItem(`gearmod.gitRepo.${projectId}`); return list.find((item) => item.sourceId === saved)?.sourceId ?? list[0]?.sourceId } catch { return list[0]?.sourceId } }), [graph, setGraph] = useState<GitGraph>(), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('')
  const repoOrderKey = `gearmod.gitRepoOrder.${projectId}`
  const sortRepos = (items: GitRepo[]): GitRepo[] => {
    try { const saved: unknown = JSON.parse(localStorage.getItem(repoOrderKey) ?? '[]'); if (!Array.isArray(saved)) return items; const order = new Map(saved.filter((id): id is string => typeof id === 'string').map((id, index) => [id, index])); return [...items].sort((a, b) => (order.get(a.sourceId) ?? Infinity) - (order.get(b.sourceId) ?? Infinity)) } catch { return items }
  }
  const dropRepo = (source: string, index: number): void => {
    if (!repos) return
    const item = repos.find((repo) => repo.sourceId === source); if (!item) return
    const next = repos.filter((repo) => repo.sourceId !== source)
    next.splice(Math.max(0, Math.min(index, next.length)), 0, item); setRepos(next)
    try { localStorage.setItem(repoOrderKey, JSON.stringify(next.map((repo) => repo.sourceId))) } catch { /* only valid for this session */ }
  }
  const [worktree, setWorktree] = useState<string | null>(null), [prOpen, setPrOpen] = useState(false), [prFocus, setPrFocus] = useState<{ number: number; at: number }>(), [prShown, setPrShown] = useState<PullRequestSummary>()
  const [renameStash, setRenameStash] = useState<{ ref: string; commit: string; message: string }>()
  const [renameCommit, setRenameCommit] = useState<{ hash: string; message: string; confirm: boolean }>()
  const [picked, setPicked] = useState<string>()
  const [focus, setFocus] = useState<string | null>(null), [sel, setSel] = useState<string | null>(null), [open, setOpen] = useState(false), [cols, setCols] = useState(loadCols), [summaries, setSummaries] = useState<Record<string, string>>({})
  const list = useRef<HTMLDivElement>(null)
  const [panes, setPanes] = useState(loadPanes), page = useRef<HTMLElement>(null)
  const gripPane = (pane: 'side' | 'detail') => (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const start = event.clientX, w0 = panes[pane], total = page.current?.getBoundingClientRect().width ?? 0, other = pane === 'side' ? panes.detail : panes.side
    // The center (graph) is never smaller than 320px.
    const room = total ? total - other - 320 : paneLimits[pane].max
    const move = (ev: PointerEvent): void => { const delta = pane === 'side' ? ev.clientX - start : start - ev.clientX; setPanes((current) => ({ ...current, [pane]: Math.min(clamp(w0 + delta, pane), Math.max(paneLimits[pane].min, room)) })) }
    const up = (): void => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.classList.remove('gresizing')
      setPanes((current) => { try { localStorage.setItem(paneKey, JSON.stringify(current)) } catch { /* only valid for this session */ } return current })
    }
    document.body.classList.add('gresizing'); document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
  }
  const resetPane = (pane: 'side' | 'detail') => (): void => setPanes((current) => { const next = { ...current, [pane]: paneLimits[pane].def }; try { localStorage.setItem(paneKey, JSON.stringify(next)) } catch { /* only valid for this session */ } return next })
  const pullOptions = pullModes.map((id) => ({ id, label: t.pullMode[id] }))
  const [pullMode, setPullMode] = useState<PullMode>(loadPull), [pullMenu, setPullMenu] = useState(false), pullBox = useRef<HTMLSpanElement>(null)
  useEffect(() => { if (!pullMenu) return; const out = (e: MouseEvent): void => { if (!pullBox.current?.contains(e.target as Node)) setPullMenu(false) }; document.addEventListener('mousedown', out); return () => document.removeEventListener('mousedown', out) }, [pullMenu])
  const [viewer, setViewer] = useState<{ sourceId: string; cardId: string | null; hash?: string; file: GitChange }>()
  useEffect(() => { if (!viewer) return; const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') setViewer(undefined) }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key) }, [viewer])
  useEffect(() => { if (focusRequest) setFocus(focusRequest.cardId) }, [focusRequest])
  const title = (cardId: string | null): string => board.cards.find((card) => card.id === cardId)?.title ?? common.card
  // Infinite scroll: starts with 100 commits and, when near the end, asks for 100 more (again and again, until the history ends).
  const pageCommits = 100
  const [limit, setLimit] = useState(pageCommits), [more, setMore] = useState(false)
  const load = useCallback(async (id = repoId): Promise<void> => {
    if (!id) return
    try { setGraph(await window.gearmod.invoke('git:graph', { projectId, sourceId: id, cardId: worktree, limit })); setError('') } catch (reason) { setError(plainError(reason)) } finally { setMore(false) }
  }, [projectId, repoId, limit, worktree])
  useEffect(() => { setLimit(pageCommits) }, [repoId])
  const onListScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget
    if (!graph?.truncated || more) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) { setMore(true); setLimit((current) => current + pageCommits) }
  }
  useEffect(() => { const cached = cachedRepos(projectId); if (cached) setRepos(sortRepos(cached)) }, [projectId])
  useEffect(() => { void window.gearmod.invoke('git:detect', { projectId }).then(({ repos: items, changed }) => { if (changed) window.dispatchEvent(new Event(gitChangedEvent)); setRepos(sortRepos(items)); try { if (items.length) localStorage.setItem(reposCacheKey(projectId), JSON.stringify(items)); else localStorage.removeItem(reposCacheKey(projectId)) } catch { /* only valid for this session */ } setRepoId((current) => { const saved = (() => { try { return localStorage.getItem(`gearmod.gitRepo.${projectId}`) } catch { return null } })(); return current && items.some((item) => item.sourceId === current) ? current : items.find((item) => item.sourceId === saved)?.sourceId ?? items[0]?.sourceId }) }).catch((reason: unknown) => setError(plainError(reason))) }, [projectId])
  useEffect(() => { setGraph(undefined); setSel(null); setOpen(false); setPicked(undefined) }, [repoId])
  useEffect(() => { void load(repoId) }, [repoId, load])
  // On opening the repository, refreshes the remote behind the scenes: so Push already knows whether it is behind before trying.
  useEffect(() => { if (repoId) void window.gearmod.invoke('git:sync', { sourceId: repoId, cardId: null, action: 'fetch' }).then(() => load(repoId)).catch(() => undefined) }, [repoId])
  useEffect(() => window.gearmod.onRunEvent((event) => { if (['gearmod/card-updated', 'gearmod/run-completed'].includes(event.eventType)) void load() }), [load])
  useEffect(() => { const again = (): void => void load(); window.addEventListener('focus', again); return () => window.removeEventListener('focus', again) }, [load])
  useEffect(() => { if (graph && sel && !graph.rows.some((row) => row.hash === sel)) { setSel(null); setOpen(false) } }, [graph, sel])
  useEffect(() => { const key = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !document.querySelector('.overlay')) { if (focus) setFocus(null); else setPicked((current) => (current && !current.startsWith('stash:') ? undefined : current)) } }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key) }, [focus])

  const rows = graph?.rows ?? []
  // Branch clicked in the sidebar: only the commits reachable from its tip stay lit; the rest of the graph fades.
  const branchReach = useMemo(() => {
    const [kind, ...rest] = (picked ?? '').split(':'), name = rest.join(':')
    if (!name || (kind !== 'local' && kind !== 'remote')) return null
    const tip = rows.find((item) => item.refs.some((ref) => ref.name === name && (kind === 'remote' ? ref.kind === 'remote' : ref.kind !== 'remote' && ref.kind !== 'tag')))
    if (!tip) return null
    const byHash = new Map(rows.map((item) => [item.hash, item])), reach = new Set<string>(), stack = [tip.hash]
    while (stack.length) { const hash = stack.pop()!; if (reach.has(hash)) continue; reach.add(hash); for (const parent of byHash.get(hash)?.parents ?? []) stack.push(parent) }
    return reach
  }, [picked, rows])
  const dimmed = useCallback((row: GitRow): boolean => focus ? row.cardId !== focus : branchReach ? !branchReach.has(row.hash) && !(isWip(row) && row.wip?.branch === (picked ?? '').replace(/^[^:]+:/, '')) : false, [focus, branchReach, picked])
  const lanes = rows.reduce((max, row) => Math.max(max, row.lane), 0) + 1, autoWidth = Math.max(64, 20 + lanes * laneSpacing)
  // Narrow graph column: the lanes get closer and, at the minimum, become a single line.
  const width = Math.max(graphMin, Math.min(cols.cg ?? autoWidth, autoWidth)), spacing = lanes > 1 ? Math.max(0, Math.min(laneSpacing, (width - 32) / (lanes - 1))) : laneSpacing
  const edges = useMemo(() => graphEdges(rows, dimmed, rowHeight, spacing), [rows, dimmed, spacing])
  const selected = rows.find((row) => row.hash === sel)
  // Each operation ends with a floating notice (green if it worked, red if it failed) and with the text also kept in `notice`.
  const opTitle = t.opTitle
  const report = (action: string, ok: boolean | 'warn', text: string, warnTitle?: string): void => {
    setNotice(text)
    const name = opTitle[action] ?? action
    // The repository and branch appear in small type: with several repositories open, it says where the operation ran.
    const meta = graph ? `${graph.repo.name}${graph.repo.head ? ` · ${graph.repo.head}` : ''}` : undefined
    if (ok === 'warn') toast.warning(warnTitle ?? name, text, { meta }); else if (ok) toast.success(t.opDone(name), text, { meta }); else toast.error(t.opFailed(name), text, { meta })
  }
  // false = closed; a string = open (with a note when a force push was refused because the remote changed).
  const [pushRejected, setPushRejected] = useState<false | string>(false)
  // Push/Pull act on the branch picked in the side list when it is a local branch other than the checked-out one (otherwise on the current branch, as before).
  const otherBranch = ((): string | undefined => { const name = picked?.startsWith('local:') ? picked.slice(6) : undefined; return name && name !== graph?.branches.local.find((item) => item.head)?.name ? name : undefined })()
  const sync = async (action: 'fetch' | 'pull' | 'push' | 'stash' | 'pop', pull?: 'ff' | 'ff-only' | 'rebase', force?: boolean): Promise<void> => {
    if (!graph) return
    setBusy(action); setNotice('')
    try { const out = await window.gearmod.invoke('git:sync', { sourceId: graph.repo.sourceId, cardId: worktree, action, pull, force, ...(otherBranch && (action === 'push' || action === 'pull') ? { branch: otherBranch } : {}) }); if (out.conflicts) report(action, 'warn', out.output, t.stashConflictTitle); else report(action, true, out.output.split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? t.done); await load() } catch (reason) {
      const text = plainError(reason)
      // Push rejected (e.g. after an amend): instead of just showing the error, offers Pull or Force push.
      if (action === 'push' && !force && errorCodeOf(text) === 'git-push-rejected') setPushRejected('')
      // Force refused (stale lease): the main process already fetched the branch; the dialog reopens saying where the remote is now.
      else if (action === 'push' && force && errorCodeOf(text) === 'git-push-stale') { setPushRejected(withoutErrorCode(text)); void load() }
      else report(action, false, withoutErrorCode(text))
    } finally { setBusy('') }
  }
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'local' | 'remote' | 'commit' | 'stash'; name: string }>(), [extMenu, setExtMenu] = useState<{ x: number; y: number; path: string; name: string }>(), [wtMenu, setWtMenu] = useState<{ x: number; y: number; cardId: string; branch: string }>(), [wtDelete, setWtDelete] = useState<{ cardId: string; sourceId?: string }>(), [extDelete, setExtDelete] = useState<{ sourceId: string; path: string }>(), [folderMenu, setFolderMenu] = useState<{ x: number; y: number; folder: string; names: string[]; remote?: boolean }>(), [allConflicts, setAllConflicts] = useState<Array<ConflictTarget & { operation: keyof typeof operationLabel; files: string[] }>>([]), [resolveTarget, setResolveTarget] = useState<ConflictTarget>(), [ask, setAsk] = useState<{ kind: 'create' | 'rename' | 'delete' | 'delete-folder' | 'delete-remote' | 'delete-remote-folder' | 'commit-branch' | 'commit-tag' | 'reset-hard'; name: string; names?: string[] }>(), [newName, setNewName] = useState(''), [createError, setCreateError] = useState(''), [creating, setCreating] = useState(false)
  const refreshConflicts = useCallback(() => { void window.gearmod.invoke('git:conflicts-all', { projectId }).then(setAllConflicts).catch(() => undefined) }, [projectId])
  useEffect(() => { refreshConflicts() }, [graph, notice, resolveTarget, refreshConflicts])
  // Undo and redo: the stack lives in the main process (one per folder); reloads with the graph and when switching repository or worktree.
  const [undoInfo, setUndoInfo] = useState<{ undo: { label: string } | null; redo: { label: string } | null }>({ undo: null, redo: null }), undoSource = graph?.repo.sourceId
  const loadUndo = useCallback(async (): Promise<void> => {
    if (!undoSource) { setUndoInfo({ undo: null, redo: null }); return }
    try { setUndoInfo(await window.gearmod.invoke('git:undo-state', { sourceId: undoSource, cardId: worktree })) } catch { setUndoInfo({ undo: null, redo: null }) }
  }, [undoSource, worktree])
  useEffect(() => { void loadUndo() }, [loadUndo, graph])
  const stepUndo = async (redo: boolean): Promise<void> => {
    if (!graph || busy || !(redo ? undoInfo.redo : undoInfo.undo)) return
    setBusy(redo ? 'redo' : 'undo'); setNotice('')
    const meta = `${graph.repo.name}${graph.repo.head ? ` · ${graph.repo.head}` : ''}`
    try { const out = await window.gearmod.invoke(redo ? 'git:redo' : 'git:undo', { sourceId: graph.repo.sourceId, cardId: worktree }); toast.success(out.output, undefined, { meta }); await load(); window.dispatchEvent(new Event(gitChangedEvent)) } catch (reason) { toast.error(redo ? t.redoFailed : t.undoFailed, plainError(reason), { meta }); void loadUndo() } finally { setBusy('') }
  }
  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y on the page; does not steal text undo (fields and editors) nor act with a dialog open.
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      const letter = event.key.toLowerCase(), redo = (letter === 'z' && event.shiftKey) || (letter === 'y' && !event.shiftKey)
      if (!(event.ctrlKey || event.metaKey) || event.altKey || !(redo || (letter === 'z' && !event.shiftKey))) return
      if (event.defaultPrevented || busy || resolveTarget || document.querySelector('.overlay') || !(redo ? undoInfo.redo : undoInfo.undo)) return
      const typing = [event.target, document.activeElement].some((node) => node instanceof Element && node.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor, .monaco-editor'))
      if (typing) return
      event.preventDefault(); void stepUndo(redo)
    }
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key)
  })
  const conflictDirty = useRef(false)
  /** Leaving the conflicts view with unsaved edits asks for confirmation. */
  const { ask: confirmAsk, dialog: confirmDialog } = useAsk()
  useEscape(() => { if (!creating) setAsk(undefined) }, ask?.kind === 'create' || ask?.kind === 'rename' || ask?.kind === 'commit-branch' || ask?.kind === 'commit-tag')
  const nameProblem = branchNameProblem(newName.trim())
  const leaveConflicts = async (): Promise<boolean> => !conflictDirty.current || confirmAsk({ eyebrow: t.resolveConflicts, title: t.discardEditTitle, text: t.discardEditText, ok: t.discard, danger: true })
  const resolve = async (entry: ConflictTarget): Promise<void> => { if (resolveTarget && !(await leaveConflicts())) return; setRepoId(entry.sourceId); setViewer(undefined); setResolveTarget(entry) }
  /** Returns the error (or `null` on success) for the name dialog to show in place and stay open. */
  const branchAction = async (action: Exclude<BranchAction, 'copy'>, name: string, extra?: { newName?: string; force?: boolean }): Promise<string | null> => {
    if (!graph) return null
    setBusy(action); setNotice('')
    let retryForce = false
    try { const out = await window.gearmod.invoke('git:branch-action', { sourceId: graph.repo.sourceId, cardId: worktree, action, name, ...extra }); report(action, true, out.output.split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? t.done); await load(); return null } catch (reason) {
      const message = plainError(reason)
      // Branch with commits that are in no other branch: instead of just failing, asks whether to delete anyway.
      if (action === 'delete' && !extra?.force && errorCodeOf(message) === 'branch-not-merged') retryForce = true
      else { report(action, false, withoutErrorCode(message)); return withoutErrorCode(message) }
    } finally { setBusy('') }
    if (retryForce && await confirmAsk({ eyebrow: t.deleteBranchEyebrow, title: t.deleteUnmergedTitle(name), text: t.deleteUnmergedText, ok: t.deleteUnmergedOk, danger: true })) return branchAction(action, name, { ...extra, force: true })
    return null
  }
  const deleteFolderBranches = async (names: string[]): Promise<void> => {
    if (!graph || !names.length) return
    setBusy('delete'); setNotice('')
    let failed: string[] = []
    const unmerged: string[] = []
    for (const name of names) {
      try { await window.gearmod.invoke('git:branch-action', { sourceId: graph.repo.sourceId, cardId: worktree, action: 'delete', name }) } catch (reason) { if (errorCodeOf(plainError(reason)) === 'branch-not-merged') unmerged.push(name); else failed.push(name) }
    }
    // Branches with commits that are in no other branch: asks once whether to delete them anyway.
    if (unmerged.length && await confirmAsk({ eyebrow: t.deleteBranchEyebrow, title: t.deleteUnmergedTitle(unmerged.join(', ')), text: t.deleteUnmergedText, ok: t.deleteUnmergedOk, danger: true })) {
      for (const name of unmerged) {
        try { await window.gearmod.invoke('git:branch-action', { sourceId: graph.repo.sourceId, cardId: worktree, action: 'delete', name, force: true }) } catch { failed.push(name) }
      }
    } else failed = [...failed, ...unmerged]
    const deleted = names.length - failed.length
    const text = failed.length ? t.foldersPartial(deleted, failed.length) : t.branchesDeleted(deleted)
    report('delete', !failed.length ? true : deleted ? 'warn' : false, text, t.someBranchesNotDeleted); await load(); setBusy('')
  }
  const deleteRemoteFolderBranches = async (names: string[]): Promise<void> => {
    if (!graph || !names.length) return
    setBusy('delete-remote'); setNotice('')
    const failed: string[] = []
    for (const name of names) {
      try { await window.gearmod.invoke('git:branch-action', { sourceId: graph.repo.sourceId, cardId: worktree, action: 'delete-remote', name }) } catch { failed.push(name) }
    }
    const deleted = names.length - failed.length
    report('delete-remote', !failed.length ? true : deleted ? 'warn' : false, failed.length ? t.foldersPartial(deleted, failed.length) : t.branchesDeleted(deleted), t.someBranchesNotDeleted); await load(); setBusy('')
  }
  const openRemoteBranch = async (name: string): Promise<void> => {
    if (!graph || busy) return
    setBusy('checkout'); setNotice('')
    try { const out = await window.gearmod.invoke('git:checkout-remote', { sourceId: graph.repo.sourceId, cardId: worktree, name }); report('checkout', true, out.output) } catch (reason) { report('checkout', false, plainError(reason)) } finally { await load(); setBusy('') }
  }
  const commitAction = async (action: Exclude<CommitMenuAction, 'copy'>, hash: string, name?: string): Promise<string | null> => {
    if (!graph) return null
    setBusy(action); setNotice('')
    try { const out = await window.gearmod.invoke('git:commit-action', { sourceId: graph.repo.sourceId, cardId: worktree, action, hash, name }); report(action, true, out.output); await load(); return null } catch (reason) { const message = plainError(reason); report(action, false, message); return message } finally { setBusy('') }
  }
  const stashAction = async (action: StashMenuAction, ref: string): Promise<void> => {
    if (!graph) return
    setBusy(action); setNotice('')
    try { const out = await window.gearmod.invoke('git:stash-action', { sourceId: graph.repo.sourceId, cardId: worktree, action, ref }); if (out.conflicts) report(action, 'warn', out.output, t.stashConflictTitle); else report(action, true, out.output); await load() } catch (reason) { report(action, false, plainError(reason)) } finally { setBusy('') }
  }
  const beginRenameStash = (ref: string): void => { const row = rows.find((item) => item.stash?.ref === ref); if (row?.stash) setRenameStash({ ref, commit: row.stash.commit, message: row.subject }) }
  const saveStashName = async (): Promise<void> => {
    if (!graph || !renameStash) return
    try { const result = await window.gearmod.invoke('git:stash-rename', { sourceId: graph.repo.sourceId, cardId: worktree, ...renameStash }); const hash = `stash:${result.commit}:${result.ref}`; setRenameStash(undefined); await load(); setSel(hash); setOpen(true); setPicked(`stash:${result.ref}`); toast.info(t.stashRenamed) } catch (reason) { toast.error(t.stashRenameFailed, plainError(reason)) }
  }
  const saveCommitName = async (): Promise<void> => {
    if (!graph || !renameCommit) return
    try { const result = await window.gearmod.invoke('git:rename-commit', { sourceId: graph.repo.sourceId, cardId: worktree, hash: renameCommit.hash, message: renameCommit.message }); setRenameCommit(undefined); await load(); setSel(result.hash); setOpen(true); toast.info(t.commitMessageUpdated) } catch (reason) { toast.error(t.commitMessageFailed, plainError(reason)) }
  }
  const runCommitMenu = (action: CommitMenuAction): void => {
    const current = menu; setMenu(undefined)
    if (!current) return
    if (action === 'copy') { void navigator.clipboard.writeText(current.name).then(() => toast.info(t.shaCopied)).catch(() => toast.error(t.copyFailed, t.clipboardDenied)); return }
    if (action === 'branch' || action === 'tag') { setNewName(''); setCreateError(''); setAsk({ kind: action === 'branch' ? 'commit-branch' : 'commit-tag', name: current.name }); return }
    if (action === 'reset-hard') { setAsk({ kind: 'reset-hard', name: current.name }); return }
    void commitAction(action, current.name)
  }
  const runMenu = (action: BranchAction): void => {
    const current = menu; setMenu(undefined)
    if (!current) return
    if (action === 'copy') { void navigator.clipboard.writeText(current.name).then(() => toast.info(t.nameCopied)).catch(() => toast.error(t.copyFailed, t.clipboardDenied)); return }
    if (action === 'create') { setNewName(''); setCreateError(''); setAsk({ kind: 'create', name: current.name }); return }
    if (action === 'rename') { setNewName(current.name); setCreateError(''); setAsk({ kind: 'rename', name: current.name }); return }
    if (action === 'delete') {
      const owner = graph?.branches.local.find((item) => item.name === current.name)?.cardId
      if (owner) { toast.error(t.deleteBranchFailed, t.branchOwnedByCard(current.name, title(owner))); return }
      setAsk({ kind: 'delete', name: current.name }); return
    }
    if (action === 'delete-remote') { setAsk({ kind: 'delete-remote', name: current.name }); return }
    void branchAction(action, current.name)
  }
  // Clicking a branch in the sidebar selects the commit at its tip: the graph scrolls there and the detail opens on the right.
  const pickBranch = (kind: 'local' | 'remote', name: string): void => {
    setPicked(`${kind}:${name}`)
    const row = rows.find((item) => item.refs.some((ref) => ref.name === name && (kind === 'remote' ? ref.kind === 'remote' : ref.kind !== 'remote' && ref.kind !== 'tag')))
    if (!row) { toast.info(t.branchNotInHistory, t.branchNotInHistoryText); return }
    setSel(row.hash); setOpen(true)
    window.requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-hash="${row.hash}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  }
  // Column edges (for the resize handles that run through all rows, not just the header).
  const [colEdges, setColEdges] = useState<number[]>([])
  useEffect(() => {
    const box = list.current; if (!box) return
    const measure = (): void => {
      const next = Array.from(box.querySelectorAll<HTMLElement>('.ghead > span'), (cell) => Math.round(cell.offsetLeft + cell.offsetWidth))
      setColEdges((current) => current.length === next.length && current.every((value, index) => value === next[index]) ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure); observer.observe(box); const head = box.querySelector('.ghead'); if (head) observer.observe(head)
    return () => observer.disconnect()
  })
  const clickRow = (row: GitRow): void => { setRenameCommit((current) => (current && !current.confirm ? undefined : current)); if (open && sel === row.hash) setOpen(false); else { setSel(row.hash); setOpen(true) } }
  const grip = (key: 'cr' | 'cg' | 'cm' | 'cc' | 'cd', min: number, cell: number) => (e: React.PointerEvent<HTMLElement>): void => {
    e.preventDefault(); e.stopPropagation()
    const box = list.current, head = box?.querySelectorAll<HTMLElement>('.ghead > span')[cell]
    if (!head) return
    const start = e.clientX, w0 = head.getBoundingClientRect().width
    document.body.classList.add('gresizing')
    const move = (ev: PointerEvent): void => { const value = Math.max(min, Math.min(key === 'cg' ? autoWidth : Infinity, Math.round(w0 + ev.clientX - start))); if (key !== 'cg') box?.style.setProperty(`--${key}`, `${value}px`); if (key === 'cm') box?.classList.add('fixedcm'); setCols((current) => ({ ...current, [key]: value })) }
    const up = (): void => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.classList.remove('gresizing'); setCols((current) => { try { localStorage.setItem(colKey, JSON.stringify(current)) } catch { /* only valid for this session */ } return current }) }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
  }

  // Pull without a linked remote branch: asks which remote/branch the current branch pulls from and pushes to, links it and then pulls.
  // Sits before the empty screen's return: no hook can come after a return.
  const [upstreamAsk, setUpstreamAsk] = useState<{ branch: string; remotes: string[]; mode: 'ff' | 'ff-only' | 'rebase' }>()
  if (repos && !repos.length) return <div className="gwrap"><GitEmpty projectId={projectId} done={(items) => { setRepos(items); setRepoId(items[0]?.sourceId) }} /></div>
  const labels = rows.map((row) => agoLabel(row.date))
  const goWorktree = (id: string | null): void => { if (id !== worktree) setGraph(undefined); setWorktree(id); setFocus(null); setSel(null); setOpen(false); setViewer(undefined) }
  // Git does not open the same branch in two folders. Branch already open in a card's worktree: double click takes you to that worktree;
  // branch open in the main folder (e.g. develop) while you are in a worktree: takes you back to the main folder.
  const openLocalBranch = (name: string): void => {
    const owner = graph?.worktrees.find((wt) => wt.branch === name)
    if (owner && owner.cardId !== worktree) { goWorktree(owner.cardId); toast.info(t.switchedToWorktree(name)); return }
    // Asks Git for the main folder's branch now (the repository list can be cached and out of date).
    if (!owner && worktree && graph) {
      const sourceId = graph.repo.sourceId
      void window.gearmod.invoke('git:upstream', { sourceId, cardId: null }).then(({ branch }) => { if (branch === name) { goWorktree(null); toast.info(t.switchedToMainFolder(name)) } else void branchAction('checkout', name) }, () => void branchAction('checkout', name))
      return
    }
    void branchAction('checkout', name)
  }
  const side = <GitSide graph={graph} worktree={worktree} selectWorktree={goWorktree} title={title} icons={gitIcons} picked={picked} onPick={pickBranch} onPickStash={(ref) => { const row = rows.find((item) => item.stash?.ref === ref); if (!row) return; setPicked(`stash:${ref}`); setSel(row.hash); setOpen(true); window.requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-hash="${row.hash}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })) }} onOpen={(kind, name, current) => { if (current) toast.info(t.alreadyOn(name)); else openLocalBranch(name) }} onMenu={(kind, name, event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, kind, name }) }} onFolderMenu={(kind, folder, names, event) => setFolderMenu({ x: event.clientX, y: event.clientY, folder, names, remote: kind === 'remote' })} onWorktreeMenu={(cardId, branch, event) => setWtMenu({ x: event.clientX, y: event.clientY, cardId, branch })} onExternalMenu={(path, name, event) => setExtMenu({ x: event.clientX, y: event.clientY, path, name })} prs={repoId ? { list: prs.lists[repoId], isUnread: (pr) => prs.isUnread(repoId, pr), open: (pr) => { setPrFocus(pr ? { number: pr.number, at: Date.now() } : undefined); setPrOpen(true) } } : undefined} />
  const tool = (icon: React.JSX.Element, label: string, action: 'push' | 'stash' | 'pop', remote = true): React.JSX.Element => <button type="button" className="gtool" disabled={Boolean(busy) || (remote && !graph?.repo.hasRemote)} data-tip={remote && !graph?.repo.hasRemote ? T.git.view.noRemote : undefined} onClick={() => { if (action === 'push' && (graph?.branches.local.find((item) => otherBranch ? item.name === otherBranch : item.head)?.behind ?? 0) > 0) setPushRejected(''); else void sync(action) }}>{icon}{busy === action ? '…' : label}</button>
  // The outer button runs the default; each menu option runs its own right away (without changing the default).
  const pullNow = (mode: PullMode = pullMode): void => {
    if (mode === 'fetch-all') { void sync('fetch'); return }
    if (!graph) return
    if (otherBranch) { void sync('pull', mode); return }
    void window.gearmod.invoke('git:upstream', { sourceId: graph.repo.sourceId, cardId: worktree }).then((info) => {
      if (info.branch && !info.upstream && info.remotes.length) setUpstreamAsk({ branch: info.branch, remotes: info.remotes, mode })
      else void sync('pull', mode)
    }).catch(() => { void sync('pull', mode) })
  }
  const pullTool = <span className="gsplit" ref={pullBox}><button type="button" className="gtool" disabled={Boolean(busy) || !graph?.repo.hasRemote} data-tip={graph?.repo.hasRemote ? pullOptions.find((item) => item.id === pullMode)?.label : T.git.view.noRemote} onClick={() => pullNow()}>{gitIcons.pull}{busy === 'pull' || busy === 'fetch' ? '…' : 'Pull'}</button>
    <button type="button" className="gtool gcaret" aria-label={t.pullOptions} aria-expanded={pullMenu} onClick={() => setPullMenu(!pullMenu)}>▾</button>
    {pullMenu && <div className="gpullmenu" role="menu"><p>{t.pullMenuHint}</p>{pullOptions.map((item) => <div className={`gpullrow ${pullMode === item.id ? 'on' : ''}`} key={item.id}>
      <button type="button" role="menuitemradio" aria-checked={pullMode === item.id} className="gpulldef" data-tip={t.setPullDefault} aria-label={t.setPullDefaultOf(item.label)} onClick={() => { setPullMode(item.id); try { localStorage.setItem(pullKey, item.id) } catch { /* only valid for this session */ } }}><i /></button>
      <button type="button" role="menuitem" className="gpullrun" disabled={Boolean(busy) || !graph?.repo.hasRemote} onClick={() => { setPullMenu(false); pullNow(item.id) }}>{item.label}{pullMode === item.id && <small>{t.defaultBadge}</small>}</button></div>)}</div>}</span>
  const colStyle = { '--gw': `${width}px`, ...Object.fromEntries(Object.entries(cols).map(([k, v]) => [`--${k}`, `${v}px`])) } as React.CSSProperties
  const undoTool = (redo: boolean): React.JSX.Element => { const info = redo ? undoInfo.redo : undoInfo.undo; return <button type="button" className="gtool" aria-label={redo ? t.redo : t.undo} disabled={!info || Boolean(busy)} data-tip={info ? (redo ? t.redoTip(info.label) : t.undoTip(info.label)) : redo ? t.nothingToRedo : t.nothingToUndo} onClick={() => void stepUndo(redo)}>{redo ? gitIcons.redo : gitIcons.undo}</button> }
  const center = <section className="gcenter" onMouseDown={(event) => { if (!(event.target as HTMLElement).closest('.gtools')) setPicked(undefined) }}><div className="gtools">{undoTool(false)}{undoTool(true)}<span className="sep" />{pullTool}{tool(gitIcons.push, 'Push', 'push')}{tool(gitIcons.stash, 'Stash', 'stash', false)}{tool(gitIcons.stash, 'Pop', 'pop', false)}<span className="sep" />
    <button type="button" className={`gtool ${prOpen ? 'on' : ''}`} aria-pressed={prOpen} data-tip={t.prsTip} onClick={() => { setPrFocus(undefined); setPrOpen(!prOpen) }}>{t.prsButton}{repoId && prs.unread(repoId).length > 0 && <i className="ydot" />}</button><span className="sep" />
    {focus ? <button type="button" className="gonly on" onClick={() => setFocus(null)}>{gitIcons.graph}{t.onlyCard(title(focus))}</button> : <span className="gonly">{gitIcons.graph}{t.allBranches}</span>}
    <span className="gcur">{worktree ? t.worktreeOfIn(title(worktree)) : t.mainFolderIn}<b>{graph?.repo.head ?? '—'}</b></span></div>
    {error && <p className="error" style={{ margin: '10px 14px' }}>{error}</p>}
    <div className={`glist ${cols.cm ? 'fixedcm' : ''}`} style={colStyle} ref={list} onScroll={onListScroll} onClick={(e) => { if (!(e.target as HTMLElement).closest('.grow,.ghead')) { if (focus) setFocus(null); else if (branchReach) setPicked(undefined) } }}>
      <div className="ghead">{t.columns.map((label) => <span key={label}>{label}</span>)}</div>
      {colEdges.length === 5 && ([['cr', 90], ['cg', graphMin], ['cm', 160], ['cc', 120], ['cd', 110]] as const).map(([key, min], cell) => <i key={key} className="gcolfull" data-tip={t.dragToResize} style={{ left: colEdges[cell]! - 4, height: 28 + rows.length * rowHeight }} onPointerDown={grip(key, min, cell)} />)}
      <svg className="gsvg" width={width} height={rows.length * rowHeight} aria-hidden="true">{edges.map((edge, i) => <path key={i} d={edge.d} stroke={edge.color} strokeWidth={1.5} fill="none" strokeDasharray={edge.wip ? '3 3' : undefined} opacity={edge.dim ? 0.3 : 1} />)}</svg>
      {!graph && !error && <div className="gskel" aria-busy="true" aria-label={t.loadingHistory}>{Array.from({ length: 16 }, (_, index) => <div className="gskel-row" key={index} style={{ '--w': `${46 + ((index * 37) % 44)}%` } as React.CSSProperties}><span className="gskel-chip" /><span className="gskel-dot" /><span className="gskel-bar" /><span className="gskel-tag" /></div>)}</div>}
      {rows.map((row, i) => {
        const last = !rows[i + 1] || labels[i + 1] !== labels[i], wip = row.wip
        const cardTitle = row.cardId ? title(row.cardId) : ''
        return <button type="button" key={row.hash} data-hash={row.hash} className={`grow ${last && rows[i + 1] ? 'gbreak' : ''} ${wip ? 'wip' : ''} ${open && row.hash === sel ? 'on' : ''} ${dimmed(row) ? 'dim' : ''}`} onClick={() => clickRow(row)} onContextMenu={wip ? undefined : (event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, kind: row.stash ? 'stash' : 'commit', name: row.stash?.ref ?? row.hash }) }}>
          <RefsCell row={row} ghost={ghostChip(rows, i, graph?.repo.head ?? null)} spacing={spacing} worktrees={[...(graph?.worktrees ?? []), ...(graph?.externalWorktrees ?? []).flatMap((wt) => wt.branch ? [{ cardId: '', title: wt.path.split(/[\\/]/).filter(Boolean).pop() ?? wt.path, branch: wt.branch, path: wt.path }] : [])]} act={(kind, name, open) => { if (!open) pickBranch(kind, name); else if (kind === 'remote') void openRemoteBranch(name); else if (name === graph?.repo.head) toast.info(t.alreadyOn(name)); else openLocalBranch(name) }} /><span className="ggraph"><Dot row={row} profiles={profiles} spacing={spacing} /></span>
          <span className="gmsg">{wip ? <><span className="gwipbox">{summaries[row.hash] || '// WIP'}</span><span className="gwipcnt">{wip.modified > 0 && <span className="m">{gitIcons.pen}{wip.modified}</span>}{wip.added > 0 && <span className="a">+{wip.added}</span>}{wip.deleted > 0 && <span className="d">−{wip.deleted}</span>}</span></> : <span className="t">{row.stash && <b className="gstashlabel">{row.stash.ref} · </b>}{row.subject}</span>}</span>
          <span className="gcardc">{row.cardId && <span className="ctag" role="link" data-tip={t.openCardGitTip} onClick={(e) => { e.stopPropagation(); openCardGit(row.cardId!) }}>{cardTitle}</span>}</span>
          <span className="gdate">{row.date && !wip && <time dateTime={row.date} data-tip={commitDateLong(row.date)}>{commitDateTime(row.date)}</time>}</span></button>
      })}
      {rows.map((row, i) => (!rows[i + 1] || labels[i + 1] !== labels[i]) ? <span key={`ago-${row.hash}`} className="gago gago2" style={{ top: 28 + (i + 1) * rowHeight }}>{labels[i]}</span> : null)}
      {graph?.truncated && <div className="gempty" style={{ padding: '10px 14px', position: 'absolute', top: 28 + rows.length * rowHeight }}>{more ? t.loadingMoreCommits : t.commitsLoaded(rows.filter((row) => !isWip(row)).length)}</div>}
    </div></section>
  const detail = open && selected && graph ? <aside className="gdetail" onMouseDown={() => setPicked(undefined)}>
    {isWip(selected) ? <><div className="gmeta"><span>{t.uncommittedChanges}</span></div><h3>{selected.cardId ? t.worktreeChanges : t.mainFolderChanges}</h3>
      {selected.cardId && <CardButton cardId={selected.cardId} title={title(selected.cardId)} branch={selected.wip?.branch} focus={focus} setFocus={setFocus} openCardGit={openCardGit} />}
      <WipForm key={selected.hash} row={selected} graph={graph} summary={summaries[selected.hash] ?? ''} setSummary={(value) => setSummaries((current) => ({ ...current, [selected.hash]: value }))} changed={() => void load()} openDiff={(file) => setViewer({ sourceId: graph.repo.sourceId, cardId: selected.cardId, file })} /></>
      : selected.stash ? <StashDetail row={selected} sourceId={graph.repo.sourceId} cardId={worktree} busy={Boolean(busy)} action={(action, ref) => void stashAction(action, ref)} rename={() => beginRenameStash(selected.stash!.ref)} />
      : <CommitDetail row={selected} graph={graph} profiles={profiles} board={board} focus={focus} setFocus={setFocus} openCardGit={openCardGit} {...(selected.refs.some((ref) => ref.kind === 'head') ? { editMessage: () => setRenameCommit({ hash: selected.hash, message: selected.subject, confirm: false }) } : {})} {...(renameCommit && !renameCommit.confirm && renameCommit.hash === selected.hash ? { renaming: { value: renameCommit.message, change: (value: string) => setRenameCommit({ ...renameCommit, message: value }), submit: () => setRenameCommit({ ...renameCommit, confirm: true }), cancel: () => setRenameCommit((current) => (current && !current.confirm ? undefined : current)) } } : {})} openFile={(file) => setViewer({ sourceId: graph.repo.sourceId, cardId: selected.cardId, hash: selected.hash, file: { ...file, staged: false } })} />}
  </aside> : null
  const prPane = prOpen && repoId ? <PrPanel sourceId={repoId} repoName={repos?.find((item) => item.sourceId === repoId)?.name ?? ''} branches={graph?.branches.local.map((branch) => branch.name) ?? []} head={graph?.repo.head ?? null} prs={prs} focus={prFocus} shown={prShown?.number} show={(pr) => { setViewer(undefined); setPrShown(pr) }} close={() => { setPrOpen(false); setPrShown(undefined) }} /> : null
  const right = prPane ?? detail
  return <div className="gwrap">{confirmDialog}<RepoTabs repos={repos ?? []} selected={repoId} alerts={(id) => prs.unread(id).length} conflicts={allConflicts} reorder={dropRepo} select={async (id) => { if (resolveTarget && !(await leaveConflicts())) return; setRepoId(id); setWorktree(null); setFocus(null); setViewer(undefined); setPrShown(undefined); setResolveTarget(undefined); try { localStorage.setItem(`gearmod.gitRepo.${projectId}`, id) } catch { /* only valid for this session */ } }} />{allConflicts.length > 0 && <div className="cfl-banner" role="status"><WarningIcon className="cfl-ico" />
    <div className="cfl-info"><b>{t.conflictInRepos(allConflicts.length)}</b>{allConflicts.length === 1 && <small>{t.operationInProgress(operationLabel[allConflicts[0]!.operation])} · {allConflicts[0]!.files.length ? t.conflictFiles(allConflicts[0]!.files.length) : t.conflictsResolvedPending}</small>}</div>
    <div className="cfl-targets">{allConflicts.map((entry) => <button key={`${entry.sourceId}:${entry.cardId ?? ''}`} type="button" className="cfl-target" data-tip={t.conflictTarget(operationLabel[entry.operation], entry.repo, entry.cardTitle)} onClick={() => resolve(entry)}><span className="cfl-where"><b>{entry.repo}</b>{entry.cardTitle && <small>{entry.cardTitle}</small>}</span><span className="cfl-go">{entry.files.length ? t.resolve : common.continue}</span></button>)}</div></div>}<section ref={page} className={`gitpage ${right ? '' : 'nodetail'}`} style={{ '--gside': `${panes.side}px`, '--gdetail': `${panes.detail}px` } as React.CSSProperties} aria-label={t.projectGit}>{resolveTarget ? <ConflictsView key={`${resolveTarget.sourceId}:${resolveTarget.cardId ?? ''}`} target={resolveTarget} profiles={profiles.filter((profile) => board.project.allowedProfileIds.includes(profile.id))} setDirty={(value) => { conflictDirty.current = value }} changed={() => { void load(); refreshConflicts() }} back={() => { setResolveTarget(undefined); refreshConflicts() }} /> : prShown && prOpen && repoId ? <>{side}<PrScreen key={`${repoId}#${prShown.number}`} sourceId={repoId} provider={prs.lists[repoId]?.provider ?? null} pr={prs.lists[repoId]?.prs.find((item) => item.number === prShown.number) ?? prShown} close={() => setPrShown(undefined)} changed={() => { void prs.refresh(repoId) }} /></> : viewer ? <DiffView viewer={viewer} close={() => setViewer(undefined)} changed={() => void load()} /> : <>{side}{center}</>}{!resolveTarget && right}{!viewer && !resolveTarget && <div className="gpanegrip side" role="separator" aria-orientation="vertical" data-tip={t.dragPaneTip} onPointerDown={gripPane('side')} onDoubleClick={resetPane('side')} />}{right && !resolveTarget && <div className="gpanegrip detail" role="separator" aria-orientation="vertical" data-tip={t.dragPaneTip} onPointerDown={gripPane('detail')} onDoubleClick={resetPane('detail')} />}</section>
    {extMenu && <GitMenu x={extMenu.x} y={extMenu.y} title={extMenu.name} label={t.externalMenuLabel(extMenu.name)} items={[{ key: 'folder' as const, label: t.openFolder }, { key: 'vscode' as const, label: t.openVsCode }, { key: 'copy' as const, label: t.copyPath }, ...(graph ? [{ key: 'delete' as const, label: T.git.worktreeDelete.externalMenu, danger: true }] : [])]} run={(kind) => {
      const { path } = extMenu; setExtMenu(undefined)
      if (kind === 'delete') { if (graph) setExtDelete({ sourceId: graph.repo.sourceId, path }); return }
      if (kind === 'copy') { void navigator.clipboard.writeText(path).then(() => toast.info(t.pathCopied)).catch(() => toast.error(t.copyFailed, t.clipboardDenied)); return }
      void window.gearmod.invoke('git:external-worktree-open', { projectId: board.project.id, path, target: kind }).catch((reason: unknown) => toast.error(t.openFailed, plainError(reason)))
    }} close={() => setExtMenu(undefined)} />}
    {wtMenu && <GitMenu x={wtMenu.x} y={wtMenu.y} title={wtMenu.branch} label={T.git.worktreeDelete.menuLabel(wtMenu.branch)} items={[{ key: 'one' as const, label: T.git.worktreeDelete.menuOne, danger: true }, { key: 'all' as const, label: T.git.worktreeDelete.menuItem, danger: true }]} run={(kind) => { const id = wtMenu.cardId; setWtMenu(undefined); setWtDelete(kind === 'one' && graph ? { cardId: id, sourceId: graph.repo.sourceId } : { cardId: id }) }} close={() => setWtMenu(undefined)} />}
    {extDelete && <ExternalWorktreeDeleteDialog sourceId={extDelete.sourceId} path={extDelete.path} close={() => setExtDelete(undefined)} done={() => { setExtDelete(undefined); void load(); window.dispatchEvent(new Event(gitChangedEvent)) }} />}
    {wtDelete && <WorktreeDeleteDialog projectId={projectId} cardId={wtDelete.cardId} sourceId={wtDelete.sourceId} close={() => setWtDelete(undefined)} done={() => { const id = wtDelete.cardId; setWtDelete(undefined); if (worktree === id) { setGraph(undefined); setWorktree(null) } else void load(); window.dispatchEvent(new Event(gitChangedEvent)) }} />}
    {folderMenu && <GitMenu x={folderMenu.x} y={folderMenu.y} title={folderMenu.folder} label={t.folderActions(folderMenu.folder)} items={[{ key: 'delete-folder', label: folderMenu.remote ? t.deleteAllRemoteBranches(folderMenu.names.length) : t.deleteAllBranches(folderMenu.names.length), danger: true }]} run={() => { const current = folderMenu; setFolderMenu(undefined); setAsk({ kind: current.remote ? 'delete-remote-folder' : 'delete-folder', name: current.folder, names: current.names }) }} close={() => setFolderMenu(undefined)} />}
    {menu && (menu.kind === 'commit' ? <GitMenu x={menu.x} y={menu.y} title={menu.name.slice(0, 7)} label={t.commitActions(menu.name.slice(0, 7))} items={commitItems(graph?.repo.head ?? null)} run={runCommitMenu} close={() => setMenu(undefined)} />
      : menu.kind === 'stash' ? <GitMenu x={menu.x} y={menu.y} title={menu.name} label={t.stashActions(menu.name)} items={[...stashItems(), { key: 'rename' as const, label: t.renameStash }]} run={(action) => { const ref = menu.name; setMenu(undefined); if (action === 'rename') beginRenameStash(ref); else void stashAction(action, ref) }} close={() => setMenu(undefined)} />
      : <GitMenu x={menu.x} y={menu.y} title={menu.name} label={t.branchActions(menu.name)} items={branchItems(menu.kind, menu.kind === 'local' && graph?.branches.local.find((item) => item.name === menu.name)?.head === true, graph?.repo.head ?? null)} run={runMenu} close={() => setMenu(undefined)} />)}
    {ask?.kind === 'reset-hard' && <ConfirmDialog eyebrow={t.resetHardEyebrow} title={t.resetHardTitle(ask.name.slice(0, 7))} text={`${t.resetHardText} ${t.undoHint}`} ok={t.resetHardOk} danger cancel={() => setAsk(undefined)} confirm={() => { const hash = ask.name; setAsk(undefined); void commitAction('reset-hard', hash) }} />}
    {pushRejected !== false && graph && <PushRejectedDialog branch={otherBranch ?? graph.repo.head ?? ''} note={pushRejected || undefined} cancel={() => setPushRejected(false)} pull={(mode) => { setPushRejected(false); void sync('pull', mode) }} force={() => { setPushRejected(false); void sync('push', undefined, true) }} />}
    {renameStash && <ConfirmDialog eyebrow={t.stashEyebrow} title={t.renameStashTitle} text={t.renameStashText} extra={<label className="f"><span>{common.name}</span><input className="in" autoFocus maxLength={500} value={renameStash.message} onChange={(event) => setRenameStash({ ...renameStash, message: event.target.value })} /></label>} ok={t.saveName} okDisabled={!renameStash.message.trim()} cancel={() => setRenameStash(undefined)} confirm={() => void saveStashName()} />}
    {renameCommit?.confirm && <ConfirmDialog eyebrow={t.changeCommit} title={t.updateMessageTitle} text={t.updateMessageText} ok={t.updateMessageOk} danger cancel={() => setRenameCommit({ ...renameCommit, confirm: false })} confirm={() => void saveCommitName()} />}
    {upstreamAsk && graph && <UpstreamDialog sourceId={graph.repo.sourceId} cardId={worktree} branch={upstreamAsk.branch} remotes={upstreamAsk.remotes} close={() => setUpstreamAsk(undefined)} done={() => { const mode = upstreamAsk.mode; setUpstreamAsk(undefined); void sync('pull', mode) }} />}
    {ask?.kind === 'delete-remote' && <ConfirmDialog eyebrow={t.deleteRemoteEyebrow} title={t.deleteRemoteTitle(ask.name)} text={t.deleteRemoteText} ok={t.deleteRemoteOk} danger cancel={() => setAsk(undefined)} confirm={() => { const name = ask.name; setAsk(undefined); void branchAction('delete-remote', name) }} />}
    {ask?.kind === 'delete' && <ConfirmDialog eyebrow={t.deleteBranchEyebrow} title={t.deleteBranchTitle(ask.name)} text={`${t.deleteBranchText} ${t.undoHint}`} ok={t.deleteBranchOk} danger cancel={() => setAsk(undefined)} confirm={() => { const name = ask.name; setAsk(undefined); void branchAction('delete', name) }} />}
    {ask?.kind === 'delete-remote-folder' && <ConfirmDialog eyebrow={t.deleteRemoteFolderEyebrow} title={t.deleteRemoteFolderTitle(ask.names?.length ?? 0, ask.name)} text={t.deleteRemoteFolderText(ask.names ?? [])} ok={t.deleteRemoteOk} danger cancel={() => setAsk(undefined)} confirm={() => { const names = ask.names ?? []; setAsk(undefined); void deleteRemoteFolderBranches(names) }} />}
    {ask?.kind === 'delete-folder' && <ConfirmDialog eyebrow={t.deleteFolderEyebrow} title={t.deleteFolderTitle(ask.names?.length ?? 0, ask.name)} text={t.deleteFolderText} ok={t.deleteFolderOk} danger cancel={() => setAsk(undefined)} confirm={() => { const names = ask.names ?? []; setAsk(undefined); void deleteFolderBranches(names) }} />}
    {(ask?.kind === 'create' || ask?.kind === 'rename' || ask?.kind === 'commit-branch' || ask?.kind === 'commit-tag') && <div className="overlay top" role="dialog" aria-label={ask.kind === 'rename' ? t.renameBranch : t.newBranch}><form className="modal" style={{ width: 'min(430px,100%)' }} onSubmit={(event) => {
      event.preventDefault(); const wanted = newName.trim(); if (!wanted || creating || nameProblem) return
      const name = ask.name, kind = ask.kind; setCreating(true); setCreateError('')
      // Stays open until it succeeds: on a Git error, the typed text stays there with the message below.
      void (kind === 'create' || kind === 'rename' ? branchAction(kind, name, { newName: wanted }) : commitAction(kind === 'commit-branch' ? 'branch' : 'tag', name, wanted)).then((failure) => { setCreating(false); if (failure) setCreateError(failure); else setAsk(undefined) })
    }}><header><div><div className="eyebrow">{ask.kind === 'commit-tag' ? t.newTag : ask.kind === 'rename' ? t.renameBranch : t.newBranch}</div><h2>{ask.kind === 'rename' ? ask.name : ask.kind === 'create' ? t.fromName(ask.name) : t.atCommit(ask.name.slice(0, 7))}</h2></div></header><label className="f"><span>{common.name}</span><input className="in" autoFocus value={newName} aria-invalid={Boolean(nameProblem || createError)} onChange={(event) => { setNewName(event.target.value); setCreateError('') }} placeholder={t.branchPlaceholder} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); if (!creating) setAsk(undefined) } }} /></label>{(nameProblem || createError) && <p className="error" role="alert">{nameProblem ? t.nameProblem[nameProblem] : createError}</p>}{ask.kind === 'rename' ? <p className="hint">{t.renameRemoteKept}</p> : ask.kind !== 'commit-tag' && <p className="hint">{t.mainFolderMoves}</p>}<div className="actions"><button type="button" className="secondary" disabled={creating} onClick={() => setAsk(undefined)}>{common.cancel}</button><button type="submit" disabled={!newName.trim() || Boolean(nameProblem) || creating || (ask.kind === 'rename' && newName.trim() === ask.name)}>{ask.kind === 'rename' ? (creating ? t.renaming : t.renameOk) : creating ? t.creating : common.create}</button></div></form></div>}
  </div>
}
