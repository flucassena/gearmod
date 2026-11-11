import React, { useEffect, useRef, useState } from 'react'
import type { GitGraph, PullRequestList, PullRequestSummary } from '@gearmod/contracts'
import { useT } from './i18n'
import { PrAccessNotice } from './PrPanel'
import { PullIcon, PushIcon } from './icons'

type Node<T> = { type: 'item'; item: T; label: string } | { type: 'folder'; name: string; entries: Array<{ item: T; label: string }> }
type LocalBranch = GitGraph['branches']['local'][number]
type RemoteBranch = GitGraph['branches']['remote'][number]
type Icons = Record<'branch' | 'cloud' | 'pc' | 'folder' | 'stash' | 'tree', React.JSX.Element>
const heightsKey = 'gearmod.gitSideHeights', openKey = 'gearmod.gitSideOpen'
const loadOpen = (): { shut: Record<string, boolean>; folders: Record<string, boolean> } => { try { const saved = JSON.parse(localStorage.getItem(openKey) ?? '{}') as { shut?: Record<string, boolean>; folders?: Record<string, boolean> }; return { shut: saved.shut ?? {}, folders: saved.folders ?? {} } } catch { return { shut: {}, folders: {} } } }
const loadHeights = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(heightsKey) ?? '{}') as Record<string, number> } catch { return {} } }
const syncArrow = (direction: 'up' | 'down'): React.JSX.Element => direction === 'down' ? <PullIcon /> : <PushIcon />
const withoutRemote = (name: string): string => name.replace(/^[^/]+\//, '')

/** Groups by the first part of the name (feature/x becomes the "feature" folder); without a slash it stays loose. Keeps the original order. */
function group<T>(items: T[], nameOf: (item: T) => string): Array<Node<T>> {
  const out: Array<Node<T>> = [], folders = new Map<string, Extract<Node<T>, { type: 'folder' }>>()
  for (const item of items) {
    const name = nameOf(item), slash = name.indexOf('/')
    if (slash <= 0) { out.push({ type: 'item', item, label: name }); continue }
    const folder = name.slice(0, slash)
    let node = folders.get(folder)
    if (!node) { node = { type: 'folder', name: folder, entries: [] }; folders.set(folder, node); out.push(node) }
    node.entries.push({ item, label: name.slice(slash + 1) })
  }
  return out
}

/**
 * Git sidebar: Local, Remote, Worktrees and Stashes. Branches grouped by folder (closed, except the one with the current branch or the focused card),
 * sections that open/close and lines between them that can be dragged to change each one's height.
 */
export function GitSide({ graph, worktree, selectWorktree, title, icons, picked, onPick, onPickStash, onOpen, onMenu, onFolderMenu, onWorktreeMenu, onExternalMenu, prs }: { prs?: { list?: PullRequestList; isUnread(pr: PullRequestSummary): boolean; open(pr?: PullRequestSummary): void }; graph?: GitGraph; worktree: string | null; selectWorktree(id: string | null): void; title(cardId: string | null): string; icons: Icons; picked?: string; onPick(kind: 'local' | 'remote', name: string): void; onPickStash(ref: string): void; onOpen(kind: 'local' | 'remote', name: string, current: boolean): void; onMenu(kind: 'local' | 'remote' | 'stash', name: string, event: React.MouseEvent): void; onFolderMenu(kind: 'local' | 'remote', folder: string, names: string[], event: React.MouseEvent): void; onWorktreeMenu(cardId: string, branch: string, event: React.MouseEvent): void; onExternalMenu(path: string, name: string, event: React.MouseEvent): void }): React.JSX.Element {
  const T = useT(), t = T.git.side, common = T.common
  const saved = useRef(loadOpen()), [shut, setShut] = useState<Record<string, boolean>>(saved.current.shut), [folders, setFolders] = useState<Record<string, boolean>>(saved.current.folders), [heights, setHeights] = useState(loadHeights)
  useEffect(() => { try { localStorage.setItem(openKey, JSON.stringify({ shut, folders })) } catch { /* only valid for this session */ } }, [shut, folders])
  const tree = useRef<HTMLDivElement>(null)
  const localNodes = group<LocalBranch>(graph?.branches.local ?? [], (branch) => branch.name), remoteNodes = group<RemoteBranch>(graph?.branches.remote ?? [], (branch) => withoutRemote(branch.name))
  const localActive = (branch: LocalBranch): boolean => picked === `local:${branch.name}` || (!picked && branch.head)
  const remoteActive = (branch: RemoteBranch): boolean => picked === `remote:${branch.name}`

  const folderRow = <T,>(scope: 'local' | 'remote', node: Extract<Node<T>, { type: 'folder' }>, active: (item: T) => boolean, row: (entry: { item: T; label: string }) => React.ReactNode): React.JSX.Element => {
    const key = `${scope}:${node.name}`, open = folders[key] ?? node.entries.some((entry) => active(entry.item))
    return <div className="gfolder" key={key}>
      <button type="button" className="gfold" aria-expanded={open} onClick={() => setFolders({ ...folders, [key]: !open })} onContextMenu={(event) => { event.preventDefault(); onFolderMenu(scope, node.name, node.entries.map((entry) => (entry.item as LocalBranch | RemoteBranch).name), event) }}><span className="gchev">{open ? '▾' : '▸'}</span>{icons.folder}<span className="gn">{node.name}</span><small>{node.entries.length}</small></button>
      {open && <div className="gfin">{node.entries.map(row)}</div>}
    </div>
  }
  const localRow = (entry: { item: LocalBranch; label: string }): React.JSX.Element => {
    const { item: branch, label } = entry
    return <button type="button" key={branch.name} data-tip={branch.head ? t.checkoutTip(branch.name) : branch.name} className={`gref ${picked === `local:${branch.name}` ? 'on' : ''} ${branch.head ? 'head' : ''}`} onClick={() => onPick('local', branch.name)} onDoubleClick={() => onOpen('local', branch.name, branch.head)} onContextMenu={(event) => onMenu('local', branch.name, event)}>{icons.branch}<span className="gwt"><span className="gn">{label}</span>{!branch.head && branch.cardId && <small style={{ fontFamily: 'var(--sans)' }}>{title(branch.cardId)}</small>}</span>{(branch.behind > 0 || branch.ahead > 0) && <span className="gsync tip" data-tip={branch.behind > 0 ? t.toPull(branch.behind) : t.toPush(branch.ahead)}>{branch.behind > 0 && <b>{syncArrow('down')}{branch.behind}</b>}{branch.ahead > 0 && <b>{syncArrow('up')}{branch.ahead}</b>}</span>}</button>
  }
  const remoteRow = (entry: { item: RemoteBranch; label: string }): React.JSX.Element => <button type="button" key={entry.item.name} data-tip={entry.item.name} className={`gref ${picked === `remote:${entry.item.name}` ? 'on' : ''}`} onClick={() => onPick('remote', entry.item.name)} onDoubleClick={() => onOpen('remote', entry.item.name, false)} onContextMenu={(event) => onMenu('remote', entry.item.name, event)}>{icons.branch}<span className="gwt"><span className="gn">{entry.label}</span>{entry.item.cardId && <small style={{ fontFamily: 'var(--sans)' }}>{title(entry.item.cardId)}</small>}</span></button>

  const sections: Array<{ key: string; label: string; icon: React.JSX.Element; count: number; body: React.ReactNode }> = [
    { key: 'local', label: t.local, icon: icons.pc, count: graph?.branches.local.length ?? 0, body: localNodes.map((node) => node.type === 'item' ? localRow(node) : folderRow('local', node, localActive, (entry) => localRow(entry))) },
    { key: 'remote', label: t.remote, icon: icons.cloud, count: graph?.branches.remote.length ?? 0, body: remoteNodes.map((node) => node.type === 'item' ? remoteRow(node) : folderRow('remote', node, remoteActive, remoteRow)) },
    { key: 'wt', label: t.worktrees, icon: icons.tree, count: (graph?.worktrees.length ?? 0) + (graph?.externalWorktrees.length ?? 0) + 1, body: <><button type="button" className={`gref ${worktree === null ? 'on' : ''}`} data-tip={t.useMainTip} onDoubleClick={() => selectWorktree(null)}>{icons.folder}<span className="gwt"><span>{t.mainFolder(graph?.repo.name)}</span></span></button>{graph?.worktrees.map((wt) => <button type="button" key={wt.cardId} data-tip={t.useWorktreeTip(wt.path)} className={`gref ${worktree === wt.cardId ? 'on' : ''}`} onDoubleClick={() => selectWorktree(wt.cardId)} onContextMenu={(event) => { event.preventDefault(); onWorktreeMenu(wt.cardId, wt.branch, event) }}>{icons.folder}<span className="gwt"><span>{wt.branch}</span><small>{title(wt.cardId) || wt.title}</small></span></button>)}{graph?.externalWorktrees.map((wt) => <div key={wt.path} className="gref" data-tip={t.externalWorktreeTip(wt.path)} onContextMenu={(event) => { event.preventDefault(); onExternalMenu(wt.path, wt.branch ?? t.detachedHead, event) }}>{icons.folder}<span className="gwt"><span>{wt.branch ?? t.detachedHead}</span><small>{wt.path.split(/[\\/]/).filter(Boolean).pop()}</small></span></div>)}</> },
    { key: 'prs', label: t.pullRequests, icon: icons.branch, count: prs?.list?.prs.length ?? 0, body: !prs?.list ? <small className="hint gside-note">{common.loading}</small> : prs.list.error ? <div className="gside-note"><PrAccessNotice list={prs.list} /></div> : !prs.list.supported ? <small className="hint gside-note">{prs.list.error}</small> : !prs.list.prs.length ? <small className="hint gside-note">{t.noPrs}</small>
      : <>{prs.list.prs.map((pr) => <button type="button" key={pr.number} className="gref" data-tip={pr.title} onClick={() => prs.open(pr)}>{icons.branch}<span className="gwt"><span className="gn">{prs.isUnread(pr) && <i className="ydot" />}#{pr.number} {pr.title}</span><small style={{ fontFamily: 'var(--sans)' }}>{pr.author} · {pr.head}{pr.draft ? ` · ${t.draftTag}` : ''}</small></span></button>)}<button type="button" className="gref" onClick={() => prs.open()}><span className="gwt"><span className="gn">{t.openPrPanel}</span></span></button></> },
    { key: 'stash', label: t.stashes, icon: icons.stash, count: graph?.stashes.length ?? 0, body: <>{graph?.stashes.map((stash) => <button type="button" key={stash.ref} className={`gref ${picked === `stash:${stash.ref}` ? 'on' : ''}`} data-tip={stash.ref} onClick={() => onPickStash(stash.ref)} onContextMenu={(event) => onMenu('stash', stash.ref, event)}><span className="gn" style={{ fontFamily: 'var(--sans)' }}>{stash.message}</span></button>)}{graph && !graph.stashes.length && <div className="gempty" style={{ padding: 8 }}>{t.noStash}</div>}</> }
  ]
  // Fixed order: each section stays in its place, open or closed; Local is always open and the open ones share the space.
  const ordered = sections
  const isShut = (key: string): boolean => key !== 'local' && Boolean(shut[key])
  const openKeys = ordered.filter((section) => !isShut(section.key)).map((section) => section.key), lastOpen = openKeys[openKeys.length - 1]
  const dragTarget = (index: number): string | undefined => { const found = ordered.slice(0, index + 1).reverse().find((section) => !isShut(section.key)); return found && found.key !== lastOpen ? found.key : undefined }

  // The line between two sections changes the height of the open section right above; the last open one fills the rest.
  const drag = (index: number) => (event: React.PointerEvent<HTMLDivElement>): void => {
    const key = dragTarget(index), el = key ? tree.current?.querySelector<HTMLElement>(`[data-sec="${key}"]`) : null
    if (!key || !el) return
    event.preventDefault()
    const start = event.clientY, h0 = el.getBoundingClientRect().height
    const move = (ev: PointerEvent): void => setHeights((current) => ({ ...current, [key]: Math.max(60, Math.round(h0 + ev.clientY - start)) }))
    const up = (): void => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.classList.remove('gresizing-v')
      setHeights((current) => { try { localStorage.setItem(heightsKey, JSON.stringify(current)) } catch { /* only valid for this session */ } return current })
    }
    document.body.classList.add('gresizing-v'); document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
  }
  // Open: starts from an equal slice of the space (or the height you dragged) and shrinks if room runs out; the content scrolls inside it.
  const styleOf = (key: string): React.CSSProperties => isShut(key) ? { flex: 'none' } : key === lastOpen ? { flex: '1 1 0' } : heights[key] ? { flex: `0 1 ${heights[key]}px` } : { flex: '1 1 0' }

  if (!graph) return <aside className="gside"><div className="gtree gcol gskel-side" aria-busy="true" aria-label={t.loadingBranches}>{[0, 1, 2, 3].map((section) => <div className="gskel-sec" key={section}><span className="gskel-bar head" />{Array.from({ length: section === 0 ? 5 : 3 }, (_, index) => <span className="gskel-bar" key={index} style={{ width: `${55 + ((index * 23 + section * 11) % 40)}%` }} />)}</div>)}</div></aside>
  return <aside className="gside"><div className="gtree gcol" ref={tree}>
    {ordered.map((section, index) => {
      const open = !isShut(section.key), locked = section.key === 'local', toggle = (): void => { if (!locked) setShut({ ...shut, [section.key]: open }) }
      return <React.Fragment key={section.key}>
        {index > 0 && <div className={`gsepline ${dragTarget(index - 1) ? 'can' : ''}`} role="separator" aria-orientation="horizontal" onPointerDown={drag(index - 1)} />}
        <div className={`gsec ${open ? 'open' : ''}`} data-sec={section.key} style={styleOf(section.key)}>
          <b role="button" tabIndex={0} aria-expanded={open} aria-disabled={locked || undefined} className={`gsech ${locked ? 'locked' : ''}`} onClick={toggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}><span className="gchev">{locked ? '' : open ? '▾' : '▸'}</span><span className="gsico">{section.icon}</span>{section.label}<span>{section.count}</span></b>
          {open && <div className="gsecbody">{section.body}</div>}
        </div>
      </React.Fragment>
    })}
  </div></aside>
}
