import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useEscape } from './useEscape'
import { tr } from './i18n'

export interface MenuItem<K extends string = string> { key: K; label: string; danger?: boolean; off?: string }
export type BranchAction = 'checkout' | 'pull' | 'pull-rebase' | 'push' | 'rebase-onto' | 'merge' | 'create' | 'rename' | 'delete' | 'delete-remote' | 'copy'
export type CommitMenuAction = 'checkout' | 'cherry-pick' | 'revert' | 'rebase' | 'reset-soft' | 'reset-mixed' | 'reset-hard' | 'branch' | 'tag' | 'copy'
export type StashMenuAction = 'apply' | 'pop' | 'drop'

/** Git right-click menu (branches, commits, stashes): list of actions with arrows, Enter and Esc. */
export function GitMenu<K extends string>({ x, y, title, label, items, run, close }: { x: number; y: number; title: string; label: string; items: Array<MenuItem<K>>; run(key: K): void; close(): void }): React.JSX.Element {
  const list = items.filter((item) => !item.off)
  const root = useRef<HTMLDivElement>(null), [pos, setPos] = useState({ left: x, top: y }), [active, setActive] = useState(0)
  const go = (item: MenuItem<K>): void => { if (!item.off) run(item.key) }
  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect(); if (!box) return
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) })
  }, [x, y])
  useEscape(close)
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => (value + 1) % Math.max(1, list.length)); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => (value + list.length - 1) % Math.max(1, list.length)); return }
      if (event.key === 'Enter') { event.preventDefault(); if (list[active]) go(list[active]!) }
    }
    const away = (event: MouseEvent): void => { if (!root.current?.contains(event.target as Node)) close() }
    document.addEventListener('keydown', key, true); document.addEventListener('mousedown', away); window.addEventListener('resize', close)
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', away); window.removeEventListener('resize', close) }
  })
  return <div className="ctxmenu" ref={root} role="menu" aria-label={label} style={pos} onContextMenu={(event) => event.preventDefault()}>
    <div className="ctxtitle" data-tip={title}>{title}</div>
    {list.map((item, index) => <React.Fragment key={item.key}>
      {item.danger && index > 0 &&<div className="ctxsep" />}
      <button type="button" role="menuitem" disabled={Boolean(item.off)} className={`ctxitem ${item.danger ? 'danger' : ''} ${index === active ? 'on' : ''}`} onMouseEnter={() => setActive(index)} onClick={() => go(item)}><span>{item.label}</span>{item.off && <kbd>{item.off}</kbd>}</button>
    </React.Fragment>)}
  </div>
}

/** Branch actions (as in GitKraken): switch, pull, push, rebase, merge, create from it and delete. */
export function branchItems(kind: 'local' | 'remote', head: boolean, current: string | null): Array<MenuItem<BranchAction>> {
  const m = tr().git.menu
  const local = kind === 'local', other = head ? m.isCurrent : current ? undefined : m.noCurrent
  return [
    { key: 'checkout', label: head ? m.alreadyHere : m.checkout, off: head ? m.currentBranch : undefined },
    ...(local ? [
      { key: 'pull', label: m.pullFf } as MenuItem<BranchAction>,
      { key: 'pull-rebase', label: m.pullRebase, off: head ? undefined : m.checkoutFirst } as MenuItem<BranchAction>,
      { key: 'push', label: m.push } as MenuItem<BranchAction>
    ] : []),
    { key: 'rebase-onto', label: m.rebaseOnto(current), off: other },
    { key: 'merge', label: m.mergeInto(current), off: other },
    { key: 'create', label: m.createFromHere },
    ...(local ? [{ key: 'rename', label: m.renameBranch } as MenuItem<BranchAction>] : []),
    ...(local ? [{ key: 'delete', label: m.deleteBranch, danger: true, off: head ? m.isCurrent : undefined } as MenuItem<BranchAction>] : []),
    ...(local ? [] : [{ key: 'delete-remote', label: m.deleteRemote, danger: true } as MenuItem<BranchAction>]),
    { key: 'copy', label: m.copyName }
  ]
}

/** Commit actions: cherry-pick or revert onto the current branch, move the branch (reset), create a branch or tag there. */
export function commitItems(current: string | null): Array<MenuItem<CommitMenuAction>> {
  const m = tr().git.menu
  const none = current ? undefined : m.noCurrent
  return [
    { key: 'checkout', label: m.openCommit },
    { key: 'cherry-pick', label: m.cherryPick(current), off: none },
    { key: 'revert', label: m.revert(current), off: none },
    { key: 'rebase', label: m.rebaseHere(current), off: none },
    { key: 'branch', label: m.branchHere },
    { key: 'tag', label: m.tagHere },
    { key: 'reset-soft', label: m.resetSoft, off: none },
    { key: 'reset-mixed', label: m.resetMixed, off: none },
    { key: 'reset-hard', label: m.resetHard, danger: true, off: none },
    { key: 'copy', label: m.copySha }
  ]
}

export const stashItems = (): Array<MenuItem<StashMenuAction>> => {
  const m = tr().git.menu
  return [
    { key: 'apply', label: m.stashApply },
    { key: 'pop', label: m.stashPop },
    { key: 'drop', label: m.stashDrop, danger: true }
  ]
}
