import { toast } from './toasts'
import { ColumnMenu } from './ColumnMenu'
import { useToolsPending } from './ToolsPanel'
import React, { useEffect, useRef, useState } from 'react'
import { shortcutEvent } from './shortcuts'
import { createPortal } from 'react-dom'
import { errorCodeOf, withoutErrorCode, type AgentConfig, type AgentProfile, type AgentPurpose, type Card, type CardTypeDef, type Chat, type ProjectBoard } from '@gearmod/contracts'
import { AgentIcon } from './AgentIcon'
import { CardChat } from './CardChat'
import { CardContextMenu } from './CardContextMenu'
import { ChatsPage } from './ChatsPage'
import { GitPage } from './GitPage'
import { usePullRequests } from './usePullRequests'
import { DatabasePage } from './DatabasePage'
import { PopMenu } from './PopMenu'
import { pop } from './popout'
import { terminal } from './terminalStore'
import { worktreeName } from './workspace'
import { FreeChat } from './FreeChat'
import { blankDraft, CardEditor, type Draft } from './CardEditor'
import { ConfirmDialog } from './ConfirmDialog'
import { DoneCleanupDialog } from './DoneCleanup'
import { DeleteCardDialog } from './DeleteCardDialog'
import { ArchiveIcon, BoardIcon, BranchIcon, ChatIcon, DatabaseIcon, FinishIcon, GearIcon, PlanIcon, PlayIcon, StopIcon } from './icons'
import { NewCardDialog, type StartChoice } from './NewCardDialog'
import { PendingDialog } from './PendingDialog'
import { NoAgentDialog } from './ProjectDialogs'
import { WindowIcon } from './WindowLayoutMenu'
import { StartDialog } from './StartDialog'
import { AssessmentDialog, ComplexityBadge } from './Assessment'
import { plainError } from './NoticeDialog'
import { Select } from './Select'
import { useT } from './i18n'
import { CardTypePill, cardTypeOptions } from './CardTypes'
import { plainSummary as plain } from './cardText'
import { recordInitialChatEvent } from './initialChatPref'
import { settingsChangedEvent } from './SettingsDialog'


type State = 'backlog' | 'todo' | 'doing' | 'test' | 'done'
/** Chat stage when opening the card: the one that is running; otherwise the column's (Test = test, Doing/Done = implementation, the rest = planning). */
export function chatMode(board: ProjectBoard, card: Card): AgentPurpose {
  const fresh = board.cards.find((item) => item.id === card.id) ?? card, state = board.columns.find((column) => column.id === fresh.columnId)?.semanticState
  if (fresh.run.state === 'planning') return 'planning'
  if (fresh.run.state !== 'idle' && fresh.run.purpose) return fresh.run.purpose
  if (state === 'test') return 'test'
  return state === 'doing' || state === 'done' ? 'execution' : 'planning'
}

/** "Virtual" card (does not exist in the database yet) for planning opened without a card: empty id until the first message. */
function draftCard(board: ProjectBoard, columnId: string): Card {
  const now = new Date().toISOString()
  return { id: '', projectId: board.project.id, columnId, sourceId: null, type: board.project.cardTypes[0]?.id ?? 'feature', title: '', description: '', priority: 'medium', orderKey: 0, createdAt: now, updatedAt: now, archivedAt: null, acceptanceCriteria: [], tasks: { done: 0, total: 0 }, run: { state: 'idle', runId: null, profileId: null, purpose: null }, hasPlan: false, planningOpen: false, workspace: null, pending: { changes: 0, questions: 0, commits: 0, toSend: 0, testFailures: 0 }, execProfileId: null, execModel: null, agentIds: [], complexity: null, repoIds: null, workflow: null, sddMethod: null } as Card
}

function CardTile({ card, types, state, agent, agents, dropLabel, dragProps, onPending, onSend, onSendFailures, onGit, onOpen, onChat, onPlan, onStart, onTest, onStop, onResume, onRetry, onArchive, onFinalize, onComplexity }: { card: Card; types: CardTypeDef[]; state: State; agent?: AgentProfile; agents: AgentProfile[]; dropLabel?: string; dragProps: React.HTMLAttributes<HTMLElement>; onPending(): void; onSend(): void; onSendFailures(): void; onGit(): void; onOpen(): void; onChat(): void; onPlan(): void; onStart(): void; onTest(): void; onStop(): void; onResume(): void; onRetry(): void; onArchive(): void; onFinalize(): void; onComplexity(): void }): React.JSX.Element {
  const { board: t, common } = useT()
  const run = card.run.state, open = card.planningOpen, ready = run === 'idle' && card.hasPlan && (state === 'backlog' || state === 'todo')
  // Something waits for the user (question, change or approval to decide, agent asking permission): the card glows like a finished one, in the warning color.
  const waiting = card.waiting ?? 0, unlisted = waiting - card.pending.questions - card.pending.changes - card.pending.commits
  const { done, total } = card.tasks
  // Something left over that "Finalize" clears: a stopped, failed or finished run, an approval nobody will answer, a pending commit.
  const dirty = run === 'paused' || run === 'failed' || run === 'finished' || unlisted > 0 || card.pending.commits > 0
  const button = (cls: string, tip: string, click: () => void, icon: React.ReactNode): React.JSX.Element => <button type="button" className={`ib ${cls} tip`} data-tip={tip} aria-label={tip} onClick={(e) => { e.stopPropagation(); click() }}>{icon}</button>
  const runLine = (purpose: string, tip: string, who?: AgentProfile, model?: string | null): React.JSX.Element => <div className="running" data-purpose={purpose} data-tip={tip} role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); onChat() }} onKeyDown={(e) => { if (e.key === 'Enter') onChat() }}><span className="who">{who && <AgentIcon profile={who} />}{model && <span className="model">{model}</span>}</span><span className="spin" /></div>
  return <article className={`card ${waiting > 0 ? 'wait' : run === 'finished' ? 'fin' : ''} ${run === 'paused' || run === 'failed' ? 'paused' : ''} ${open ? 'planopen' : ''} ${ready ? 'ready' : ''} ${dropLabel ? 'drop-before' : ''}`} data-plabel={dropLabel} onClick={onOpen} {...dragProps}>
    <div className="pills"><CardTypePill types={types} type={card.type} /><span className={`pill ${card.priority}`}>{t.priority[card.priority]}</span><ComplexityBadge complexity={card.complexity} pendingDecisions={card.pending.decisions} onClick={onComplexity} /></div>
    <button type="button" className="cardchat tip" data-tip={t.tile.openChat} aria-label={t.tile.openChat} onClick={(e) => { e.stopPropagation(); onChat() }}><ChatIcon /></button>
    <h3 className="ctitle" data-tip={card.title || undefined}>{card.title || t.newCard}</h3>
    {card.description && <div className="desc">{plain(card.description)}</div>}
    {unlisted > 0 && <button type="button" className="badge ask" data-tip={t.tile.needsYouTip} onClick={(e) => { e.stopPropagation(); onChat() }}><span className="dot pulse" />{t.tile.needsYou}</button>}
    {card.pending.changes > 0 && <button type="button" className="badge ask" onClick={(e) => { e.stopPropagation(); onPending() }}><span className="dot pulse" />{t.tile.changesWaiting(card.pending.changes)}</button>}
    {card.pending.toSend > 0 && <button type="button" className="badge ask" data-tip={t.tile.sendTip} onClick={(e) => { e.stopPropagation(); onSend() }}><span className="dot pulse" />{t.tile.changesToSend(card.pending.toSend)}</button>}
    {card.pending.testFailures > 0 && run !== 'running' && <button type="button" className="badge ask" data-tip={t.tile.failuresTip} onClick={(e) => { e.stopPropagation(); onSendFailures() }}><span className="dot pulse" />{t.tile.failuresToSend(card.pending.testFailures)}</button>}
    {(card.pending.testBlocked ?? 0) > 0 && card.pending.testFailures === 0 && run !== 'running' && <button type="button" className="badge" data-tip={t.tile.blockedTip} onClick={(e) => { e.stopPropagation(); onChat() }}>{t.tile.testBlocked(card.pending.testBlocked ?? 0)}</button>}
    {card.pending.questions > 0 && <button type="button" className="badge ask" onClick={(e) => { e.stopPropagation(); onPending() }}><span className="dot pulse" />{t.tile.questionsWaiting(card.pending.questions)}</button>}
    {card.pending.commits > 0 && <button type="button" className="badge ask" onClick={(e) => { e.stopPropagation(); onGit() }}><span className="dot pulse" />{t.tile.commitsWaiting(card.pending.commits)}</button>}
    {open && <span className="badge plan"><span className="dot" />{t.tile.inPlanning}</span>}
    {run === 'planning' && runLine('plan', t.tile.planningWithAgent + ' · ' + t.tile.tapToView, agent)}
    {ready && <span className="badge ready"><span className="dot softpulse" />{t.tile.planReady}</span>}
    {run === 'paused' && <span className="badge paused"><span className="dot softpulse" />{t.tile.paused}</span>}
    {run === 'failed' && <button type="button" className="badge paused" data-tip={t.tile.failedTip(card.run.error ?? '')} onClick={(e) => { e.stopPropagation(); onRetry() }}><span className="dot" />{t.tile.failed}</button>}
    {run === 'finished' && <button type="button" className="badge fin" onClick={(e) => { e.stopPropagation(); onChat() }}><span className="dot pulse" />{t.tile.finishedViewChat}</button>}
    {run === 'running' && runLine(card.run.purpose ?? 'execution', card.run.purpose === 'test' ? t.tile.testingTap : t.tile.executionTap, agent, card.execModel)}
    {run !== 'running' && card.testsRunning && runLine('test', t.tile.autoTestsRunningTap)}
    <div className="cfoot">
      <span className="ownr">{(agents.length ? agents : agent ? [agent] : []).length > 0 && <span className="agentstack">{(agents.length ? agents : [agent!]).map((profile) => <AgentIcon key={profile.id} profile={profile} />)}</span>}{!open && <span className="cnt">{card.workflow === 'light' ? t.tile.oneAgentOnly : total ? t.tile.tasksCount(done, total) : t.tile.noTasks}</span>}</span>
      <div className="btns">
        {card.workspace && <button type="button" className="ib view ws tip" data-tip={t.tile.branchTip(card.workspace.branch, worktreeName(card.workspace.path), card.workspace.baseRef)} aria-label={t.tile.branchAria(card.workspace.branch)} onClick={(e) => { e.stopPropagation(); onGit() }}><BranchIcon /></button>}
        {run === 'idle' && !card.hasPlan && (state === 'backlog' || state === 'todo') && button('plan', open ? t.tile.continuePlanning : t.tile.goToPlanning, onPlan, <PlanIcon />)}
        {(state === 'todo' || state === 'backlog') && (run !== 'idle' || card.hasPlan) && button('plan', t.tile.plan, onPlan, <PlanIcon />)}
        {run === 'failed' && button('start', t.tile.chooseAgent, onRetry, <PlayIcon />)}
        {run === 'paused' && button('start', common.continue, onResume, <PlayIcon />)}
        {state === 'doing' && run !== 'running' && run !== 'paused' && run !== 'failed' && button('start', t.tile.start, onStart, <PlayIcon />)}
        {state === 'test' && card.workflow !== 'light' && run !== 'running' && run !== 'paused' && run !== 'failed' && button('start', t.tile.test, onTest, <PlayIcon />)}
        {run === 'running' && button('stop', t.tile.stop, onStop, <StopIcon />)}
        {state === 'done' && dirty && button('view', t.tile.finalize, onFinalize, <FinishIcon />)}
        {state === 'done' && button('view', t.tile.archive, onArchive, <ArchiveIcon />)}
      </div>
    </div>
  </article>
}

type ProjectView = 'board' | 'chats' | 'git' | 'db'
const dockPinKey = 'gearmod.viewDockPinned'
const dockPointKey = 'gearmod.viewDockPoint'
const readDockPoint = (): { x: number; y: number } | null => { try { const value = JSON.parse(localStorage.getItem(dockPointKey) ?? 'null') as { x?: unknown; y?: unknown } | null; return value && typeof value.x === 'number' && typeof value.y === 'number' ? { x: value.x, y: value.y } : null } catch { return null } }

/** Detachable view selector: the menu itself is the handle for moving the dock. */
function ViewDock({ projectId, view, select, databaseEnabled, gitAlert, onDropPreview }: { projectId: string; view: ProjectView; select(value: ProjectView): void; databaseEnabled: boolean; gitAlert?: boolean; onDropPreview?(show: boolean): void }): React.JSX.Element {
  const t = useT().board
  const [pinned, setPinned] = useState(() => { try { return localStorage.getItem(dockPinKey) === '1' } catch { return false } })
  const [point, setPoint] = useState(readDockPoint)
  const [snapping, setSnapping] = useState(false)
  const [dragging, setDragging] = useState(false)
  useEffect(() => onDropPreview?.(dragging && snapping), [dragging, snapping, onDropPreview])
  const [menu, setMenu] = useState<{ x: number; y: number; kind: ProjectView }>()
  const dock = useRef<HTMLDivElement>(null), moved = useRef(false)
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(undefined)
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key) }
  }, [menu])
  const pin = (value: boolean): void => { setPinned(value); setMenu(undefined); try { localStorage.setItem(dockPinKey, value ? '1' : '0') } catch { /* preference for this installation only */ } }
  const beginMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    moved.current = false
    const rect = dock.current?.getBoundingClientRect(); if (!rect) return
    const startX = event.clientX, startY = event.clientY, left = rect.left, top = rect.top, snapLine = 48
    let detached = !pinned, lastY = startY
    if (detached) setDragging(true)
    const move = (next: PointerEvent): void => {
      lastY = next.clientY
      if (!detached && Math.abs(next.clientX - startX) + Math.abs(next.clientY - startY) < 6) return
      if (Math.abs(next.clientX - startX) + Math.abs(next.clientY - startY) >= 6) moved.current = true
      if (!detached) { detached = true; pin(false); setDragging(true) }
      setSnapping(next.clientY <= snapLine)
      const x = Math.round(Math.max(8, Math.min(window.innerWidth - rect.width - 8, left + next.clientX - startX)))
      const y = Math.round(Math.max(44, Math.min(window.innerHeight - rect.height - 8, top + next.clientY - startY)))
      setPoint({ x, y })
    }
    const up = (): void => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); setSnapping(false); setDragging(false)
      if (!detached) return
      if (lastY <= snapLine) { pin(true); return }
      const rectNow = dock.current?.getBoundingClientRect(); if (rectNow) try { localStorage.setItem(dockPointKey, JSON.stringify({ x: Math.round(rectNow.left), y: Math.round(rectNow.top) })) } catch { /* preference for this installation only */ }
    }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
  }
  const openViewWindow = (kind: ProjectView): void => { setMenu(undefined); void window.gearmod.invoke('windows:open', { kind, projectId, placement: 'new' }) }
  const context = (event: React.MouseEvent, kind: ProjectView): void => { event.preventDefault(); event.stopPropagation(); setMenu({ x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 104), kind }) }
  return <div ref={dock} className={`viewdock ${pinned ? 'pinned' : 'floating'} ${!point ? 'default' : ''} ${snapping ? 'snapping' : ''}`} style={!pinned && point ? { left: point.x, top: point.y } : undefined}>
    <div className="viewtoggle" role="group" aria-label={t.dock.projectView} onPointerDown={beginMove} onClickCapture={(event) => { if (moved.current) { event.preventDefault(); event.stopPropagation(); moved.current = false } }}>
      <button type="button" className={view === 'board' ? 'on' : ''} aria-pressed={view === 'board'} onContextMenu={(event) => context(event, 'board')} onClick={() => select('board')}><BoardIcon />{t.dock.board}</button>
      <button type="button" className={view === 'chats' ? 'on' : ''} aria-pressed={view === 'chats'} onContextMenu={(event) => context(event, 'chats')} onClick={() => select('chats')}><ChatIcon />{t.dock.chats}</button>
      <button type="button" className={view === 'git' ? 'on' : ''} aria-pressed={view === 'git'} onContextMenu={(event) => context(event, 'git')} onClick={() => select('git')}><BranchIcon />Git{gitAlert && <i className="ydot" data-tip={t.dock.pullRequestsNews} />}</button>
      {databaseEnabled && <button type="button" className={view === 'db' ? 'on' : ''} aria-pressed={view === 'db'} onContextMenu={(event) => context(event, 'db')} onClick={() => select('db')}><DatabaseIcon />{t.dock.database}</button>}
    </div>
    {menu && createPortal(<div className="popmenu viewdock-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}><button type="button" role="menuitem" className="pm-item pm-ico" onClick={() => openViewWindow(menu.kind)}><WindowIcon />{t.dock.openInNewWindow}</button><button type="button" role="menuitem" className="pm-item" onClick={() => pin(!pinned)}>{pinned ? t.dock.unpinFromHeader : t.dock.pinToHeader}</button></div>, document.body)}
  </div>
}

/** Preview of where the dock will pin when dropped near the top: same buttons as the real dock, so it has the same size. */
function ViewDockDropPreview({ databaseEnabled }: { databaseEnabled: boolean }): React.JSX.Element {
  const t = useT().board
  return <div className="viewdock-dropghost" aria-hidden="true">
    <div className="viewtoggle">
      <button type="button" className="on"><BoardIcon />{t.dock.board}</button>
      <button type="button"><ChatIcon />{t.dock.chats}</button>
      <button type="button"><BranchIcon />Git</button>
      {databaseEnabled && <button type="button"><DatabaseIcon />{t.dock.database}</button>}
    </div>
  </div>
}

export function Board({ board, profiles, history, openInitialChat, refresh, onProjectConfig, openSettings, freeRequest, freeHandled, constitutionRequest, constitutionHandled, openTarget, targetHandled, slots }: { slots?: { view: HTMLElement | null; gear: HTMLElement | null; tray?: HTMLElement | null }; board: ProjectBoard; profiles: AgentProfile[]; history: AgentProfile[]; openInitialChat?: boolean; refresh(): Promise<void>; onProjectConfig(tab?: 'general' | 'git'): void; openSettings(): void; freeRequest?: { projectId: string; at: number }; freeHandled(): void; constitutionRequest?: { projectId: string; prompt?: string; at: number; mode?: 'constitution' | 'test-setup'; config?: AgentConfig }; constitutionHandled(): void; openTarget?: { projectId: string; cardId: string | null; chatId: string | null; purpose: string | null }; targetHandled(): void }): React.JSX.Element {
  const t = useT().board
  const [draft, setDraft] = useState<Draft>(), [chatCard, setChatCardState] = useState<Card>(), [chatPurpose, setChatPurpose] = useState<AgentPurpose>('planning'), [starting, setStartingState] = useState<{ card: Card; purpose: 'execution' | 'test'; retry?: boolean }>(), [choosing, setChoosing] = useState<string>(), [stopping, setStopping] = useState<Card>(), [finalizing, setFinalizing] = useState<Card>(), [cleanup, setCleanup] = useState<Card>(), [pendingCard, setPendingCard] = useState<Card>(), [assessing, setAssessing] = useState<Card>()
  /** Sends the developer each already-authorized card change that has not been sent yet. */
  const sendChanges = async (cardId: string): Promise<void> => {
    try { const { changes } = await window.gearmod.invoke('collab:list', { cardId }); for (const change of changes) if ((change.status === 'accepted' || change.status === 'applied') && !change.sentAt) await window.gearmod.invoke('collab:send-change', { changeId: change.id }); await refresh() } catch (reason) { say(plainError(reason), 'error') }
  }
  /** Sends the developer the failures the tester recorded in the checklist (the app does not do it on its own). */
  const sendFailures = async (cardId: string): Promise<void> => {
    try { await window.gearmod.invoke('collab:send-test-failures', { cardId }); say(t.tile.failuresSent); await refresh() } catch (reason) { say(plainError(reason), 'error') }
  }
  const [gate, setGate] = useState<{ cardId: string; columnId: string; beforeCardId: string | null; stage: 'test' | 'review' }>(), [dragId, setDragId] = useState<string>(), [dropOn, setDropOn] = useState<string>(), [overColumn, setOverColumn] = useState<string>()
  const [boardQuery, setBoardQuery] = useState(''), [priorityFilter, setPriorityFilter] = useState<Card['priority'] | ''>(''), [typeFilter, setTypeFilter] = useState<string>(''), [agentFilter, setAgentFilter] = useState('')
  // Project agents, only the active ones (deleted with history is deactivated and leaves `profiles`). Cards of agents outside it stay on the board.
  const allowed = profiles.filter((profile) => board.project.allowedProfileIds.includes(profile.id))
  const cardTypes = board.project.cardTypes
  // The terminal opens in the project folder (a card's chat switches to its worktree).
  useEffect(() => { terminal.setContext({ projectId: board.project.id, cardId: null }) }, [board.project.id])
  const active = board.cards.filter((card) => !card.archivedAt)
  const filtering = Boolean(boardQuery.trim() || priorityFilter || typeFilter || agentFilter)
  const visibleCards = active.filter((card) => (!priorityFilter || card.priority === priorityFilter) && (!typeFilter || card.type === typeFilter) && (!agentFilter || card.agentIds.includes(agentFilter) || card.execProfileId === agentFilter || card.run.profileId === agentFilter) && `${card.title} ${card.description}`.toLocaleLowerCase().includes(boardQuery.trim().toLocaleLowerCase()))
  const [archivingColumn, setArchivingColumn] = useState<string>(), toolsPending = useToolsPending(board.project.id)
  const archiveColumn = async (columnId: string): Promise<void> => {
    const targets = board.cards.filter((card) => !card.archivedAt && card.columnId === columnId)
    const results = await Promise.allSettled(targets.map((card) => window.gearmod.invoke('cards:archive', { cardId: card.id })))
    const failed = results.filter((item) => item.status === 'rejected').length
    say(failed ? t.view.archivePartial(targets.length - failed, failed) : t.view.cardsArchived(targets.length), failed ? 'error' : undefined)
    await refresh()
  }
  const prs = usePullRequests(board.project.id)
  const [chatsOpen, setChatsOpen] = useState(pop?.kind === 'chats'), [gitOpen, setGitOpen] = useState(pop?.kind === 'git'), [gitCardId, setGitCardId] = useState<string>(), [gitFocus, setGitFocus] = useState<{ cardId: string; at: number }>()
  const [dbOpen, setDbOpen] = useState(pop?.kind === 'db'), [databaseEnabled, setDatabaseEnabled] = useState(false), [dropPreview, setDropPreview] = useState(false)
  useEffect(() => { void window.gearmod.invoke('db:feature-enabled', undefined).then(setDatabaseEnabled).catch(() => undefined) }, [])
  const [menu, setMenu] = useState<{ x: number; y: number; card: Card }>(), [deleting, setDeleting] = useState<Card>()
  // Deleted the card (via the menu, the editor or another path) with its chat open: closes the chat too.
  useEffect(() => { if (chatCard && !board.cards.some((item) => item.id === chatCard.id)) setChatCardState(undefined) }, [board.cards, chatCard])
  // Planning opened without a card: the card is only created on the first message (ensureCard); closing without writing creates nothing.
  const [draftPlan, setDraftPlan] = useState<{ columnId: string; start?: StartChoice }>(), [chatInstance, setChatInstance] = useState(0)
  const [freeChat, setFreeChat] = useState<{ chat?: Chat; key: number; mode?: 'free' | 'constitution' | 'test-setup'; prompt?: string; docked?: boolean; config?: AgentConfig }>(), [openAfterRefresh, setOpenAfterRefresh] = useState<string>(), [suggestDisableInitialChat, setSuggestDisableInitialChat] = useState(false)
  const setChatCard = (card: Card | undefined, purpose?: AgentPurpose): void => {
    const open = (next: AgentPurpose): void => { setChatCardState(card); setDraftPlan(undefined); setFreeChat(undefined); setChatPurpose(next); setChatInstance((value) => value + 1) }
    if (!card) { setChatCardState(undefined); setDraftPlan(undefined); return }
    // A short flow has a single chat: opens the one that exists (the planning one, if it did the work), not a stage that never had a conversation.
    if (card.workflow === 'light' && card.id) { const fallback = purpose ?? chatMode(board, card); void window.gearmod.invoke('chats:list', { projectId: board.project.id, cardId: card.id }).then((items) => { const steps = items.map((item) => item.purpose).filter((value): value is AgentPurpose => value === 'planning' || value === 'execution' || value === 'test'); open(steps.find((value) => value === 'execution') ?? steps[0] ?? fallback) }).catch(() => open(fallback)); return }
    open(purpose ?? chatMode(board, card))
  }
  const openFree = (chat?: Chat): void => { setChatCardState(undefined); setFreeChat({ chat, key: Date.now(), mode: chat?.purpose === 'constitution' || chat?.purpose === 'test-setup' ? chat.purpose : 'free' }) }
  // First view of the board: the planning chat open beside it (only in the main window, with an agent allowed, and nothing else open in the dock).
  const planOpened = useRef(false), hasAgent = allowed.length > 0
  useEffect(() => {
    if (planOpened.current || pop || !hasAgent || openInitialChat === undefined) return
    planOpened.current = true
    if (openInitialChat) setFreeChat((current) => current ?? { key: Date.now(), docked: true })
  }, [hasAgent, openInitialChat])
  // Project "+" in the sidebar: opens a new free chat in this project as soon as its board loads.
  useEffect(() => {
    if (!freeRequest || freeRequest.projectId !== board.project.id) return
    freeHandled(); setChatCardState(undefined); setFreeChat({ key: Date.now() })
  }, [freeRequest, board.project.id, freeHandled])
  // Project Constitution tab: opens its chat (continues the last one, if any), optionally already with a request.
  useEffect(() => {
    if (!constitutionRequest || constitutionRequest.projectId !== board.project.id) return
    const { prompt, config } = constitutionRequest, mode = constitutionRequest.mode ?? 'constitution'
    constitutionHandled()
    void window.gearmod.invoke('chats:list', { projectId: board.project.id, cardId: null }).catch(() => [] as Chat[]).then((items) => {
      setChatsOpen(false); setChatCardState(undefined)
      const found = items.find((item) => item.purpose === mode)
      // Another agent chosen: a new conversation with it (the previous one stays in Chats).
      setFreeChat({ chat: config && found && found.profileId !== config.profileId ? undefined : found, key: Date.now(), mode, prompt, config })
    })
  }, [constitutionRequest, board.project.id, constitutionHandled])
  // Click on a system notification: opens the card's chat (at the right stage) or the free chat.
  useEffect(() => {
    if (!openTarget || openTarget.projectId !== board.project.id) return
    if (openTarget.cardId) {
      const card = board.cards.find((item) => item.id === openTarget.cardId)
      if (!card) return
      targetHandled(); setChatsOpen(false); setChatCard(card, openTarget.purpose === 'planning' || openTarget.purpose === 'execution' || openTarget.purpose === 'test' ? openTarget.purpose : undefined)
    } else if (openTarget.chatId) {
      const chatId = openTarget.chatId
      targetHandled(); void window.gearmod.invoke('chats:list', { projectId: board.project.id }).then((items) => { const chat = items.find((item) => item.id === chatId); if (chat) { setChatsOpen(false); openFree(chat) } })
    }
  }, [openTarget, board.project.id, board.cards])
  // The free chat became planning for a new card: waits for the board to update and opens the card's chat (the same chat, now planning).
  useEffect(() => {
    if (!openAfterRefresh) return
    const card = board.cards.find((item) => item.id === openAfterRefresh)
    if (card) { setOpenAfterRefresh(undefined); setChatCard(card, 'planning') }
  }, [openAfterRefresh, board.cards])
  // Card Git panel: opens the chat of the current stage (implementation or test) already in the Git view.
  const openCardGit = (cardId: string): void => { const card = board.cards.find((item) => item.id === cardId); if (!card) return; const mode = chatMode(board, card); setGitCardId(cardId); setChatsOpen(false); setChatCard(card, mode === 'planning' ? 'execution' : mode) }
  // User actions that succeeded or failed, and what the agent did on its own (notification).
  const say = (text: string, kind: 'success' | 'error' | 'notify' = 'success'): void => { if (kind === 'error') toast.error(t.view.couldNotComplete, text); else if (kind === 'notify') toast.notify(text); else toast.success(text) }
  useEffect(() => { const again = (): void => void refresh(); window.addEventListener('gearmod:board-changed', again); return () => window.removeEventListener('gearmod:board-changed', again) }, [refresh])
  // The agent touched another card's worktree: offers to use the same one (one question per card and owner, while the app is open).
  const [foreign, setForeign] = useState<{ cardId: string; ownerCardId: string; ownerTitle: string }>(), asked = useRef(new Set<string>())
  useEffect(() => window.gearmod.onRunEvent((event) => {
    if (event.eventType !== 'gearmod/worktree-foreign') return
    const info = event.payload as { cardId: string; ownerCardId: string; ownerTitle: string }, key = `${info.cardId}:${info.ownerCardId}`
    if (!asked.current.has(key)) { asked.current.add(key); setForeign(info) }
  }), [])
  useEffect(() => window.gearmod.onRunEvent((event) => {
    if (!['gearmod/card-updated', 'gearmod/run-started', 'gearmod/run-completed', 'gearmod/permission-requested', 'gearmod/permission-resolved'].includes(event.eventType)) return
    if (event.payload.type === 'moved') say(t.view.agentMovedCard(String(event.payload.column)), 'notify')
    void refresh()
  }), [refresh])
  const move = async (cardId: string, columnId: string, beforeCardId: string | null, skipGate = false): Promise<void> => {
    const before = board.cards.find((card) => card.id === cardId)
    try {
      // Moving to Done without an approved automated test and review: asks first, instead of just failing with an error.
      if (!skipGate && before && before.columnId !== columnId && board.columns.find((column) => column.id === columnId)?.semanticState === 'done') {
        const quality = await window.gearmod.invoke('quality:status', { cardId })
        const passed = quality.test?.status === 'passed', reviewed = quality.review?.state === 'approved' || quality.review?.state === 'merged'
        if (!passed || !reviewed) { setGate({ cardId, columnId, beforeCardId, stage: passed ? 'review' : 'test' }); return }
      }
      const moved = await window.gearmod.invoke('cards:move', { cardId, columnId, beforeCardId, skipGate })
      // Arrived in Done with a worktree of its own: offers to delete the worktree and the branch.
      const doneId = board.columns.find((column) => column.semanticState === 'done')?.id
      if (before && before.columnId !== doneId && moved.columnId === doneId && moved.workspace && !moved.workspace.sharedFrom) setCleanup(moved)
      if (before && before.priority !== moved.priority) say(t.view.priorityChanged(t.priority[moved.priority]))
    } catch (reason) { say(plainError(reason), 'error') }
    await refresh()
  }
  const runGateTests = async (card: Card): Promise<void> => {
    // Each changed repository runs its own command (Project settings > Tests); none configured: opens that tab.
    let plan: { repos: unknown[]; fallback: string } = { repos: [], fallback: '' }; try { plan = await window.gearmod.invoke('tests:plan', { cardId: card.id }) } catch { /* no worktree: the run says why */ }
    if (!plan.repos.length && !plan.fallback) { window.dispatchEvent(new CustomEvent('gearmod:open-project-config', { detail: { tab: 'tests' } })); say(t.view.setTestCommand, 'notify'); return }
    say(t.view.runningTests, 'notify')
    void window.gearmod.invoke('tests:run-card', { cardId: card.id }).then((run) => { if (run.status === 'passed') say(t.view.testsPassed); else say(t.view.testsFailed, 'error'); return refresh() }).catch((reason: unknown) => say(plainError(reason), 'error'))
  }
  const dropLabel = (target: Card): string | undefined => { const dragged = board.cards.find((card) => card.id === dragId); if (!dragged || dragged.id === target.id) return undefined; return dragged.priority === target.priority ? t.view.samePriority : t.view.becomesPriority(t.priority[target.priority]) }
  const edit = (card: Card): Draft => ({ id: card.id, columnId: card.columnId, sourceId: card.sourceId, title: card.title, type: card.type, priority: card.priority, workflow: card.workflow })
  const clear = (): void => { setDragId(undefined); setDropOn(undefined); setOverColumn(undefined) }
  const fresh = (card: Card): Card => board.cards.find((item) => item.id === card.id) ?? card
  const columnLabel = (card: Card): string => board.columns.find((column) => column.id === fresh(card).columnId)?.label ?? ''
  // Board/Chats/Git, the window button and the gear sit in the title bar (portals into its slots); without the slots, they stay here in the header.
  const gearControl = <button type="button" className={slots?.gear ? 'ibtn tip tb-gearbtn' : 'iconbtn'} data-tip={t.view.configureProject} aria-label={t.view.configureProject} onClick={() => onProjectConfig()}>{toolsPending && <i className="gear-dot" aria-hidden="true" />}{slots?.gear ? <GearIcon /> : '⚙'}</button>
  const currentView: ProjectView = gitOpen ? 'git' : dbOpen ? 'db' : chatsOpen ? 'chats' : 'board'
  const selectView = (value: ProjectView): void => { setDraft(undefined); window.dispatchEvent(new Event('gearmod:select-view')); setChatsOpen(value === 'chats'); setGitOpen(value === 'git'); setDbOpen(value === 'db') }
  // Click on the project already open in the sidebar: back to the board as when the project opens (closes the card chat).
  const goHome = useRef<() => void>(() => undefined)
  goHome.current = () => { selectView('board'); setChatCardState(undefined); setDraftPlan(undefined); setFreeChat(hasAgent && !pop ? { key: Date.now(), docked: true } : undefined) }
  useEffect(() => { const home = (): void => goHome.current(); window.addEventListener('gearmod:project-home', home); return () => window.removeEventListener('gearmod:project-home', home) }, [])
  // View shortcuts (Ctrl+1..4, Ctrl+Tab/Ctrl+Shift+Tab) and project settings (Ctrl+,).
  const viewKeys = useRef({ currentView, selectView, onProjectConfig, databaseEnabled }); viewKeys.current = { currentView, selectView, onProjectConfig, databaseEnabled }
  useEffect(() => {
    const direct: Partial<Record<string, ProjectView>> = { viewBoard: 'board', viewChats: 'chats', viewGit: 'git', viewDatabase: 'db' }
    const handle = (event: Event): void => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id, now = viewKeys.current
      const order: ProjectView[] = now.databaseEnabled ? ['board', 'chats', 'git', 'db'] : ['board', 'chats', 'git']
      if (id === 'projectSettings') { now.onProjectConfig(); return }
      const target = id === 'nextView' || id === 'previousView' ? order[(order.indexOf(now.currentView) + (id === 'nextView' ? 1 : order.length - 1)) % order.length] : direct[id ?? '']
      if (target && order.includes(target) && target !== now.currentView) now.selectView(target)
    }
    window.addEventListener(shortcutEvent, handle); return () => window.removeEventListener(shortcutEvent, handle)
  }, [])
  const popMenu = <PopMenu target={{ kind: currentView, projectId: board.project.id }} />
  const viewControls = <><ViewDock projectId={board.project.id} view={currentView} select={selectView} databaseEnabled={databaseEnabled} gitAlert={prs.total > 0} onDropPreview={setDropPreview} />{dropPreview && slots?.view && <ViewDockDropPreview databaseEnabled={databaseEnabled} />}{slots?.view && slots?.gear && gearControl}{!slots?.tray && popMenu}</>
  return <div className="content">
    {slots?.view && createPortal(viewControls, slots.view)}{slots?.tray && createPortal(popMenu, slots.tray)}{slots?.gear && !slots?.view && createPortal(gearControl, slots.gear)}
    <main>
    {!(slots?.view && slots?.gear) && <div className="head"><div className="lead"><div>{!slots?.gear && <h1>{board.project.name}</h1>}</div></div><div className="tools">{!slots?.view && viewControls}{!slots?.gear && gearControl}</div></div>}
    {gitOpen ? <GitPage board={board} prs={prs} profiles={history} openCardGit={openCardGit} focusRequest={gitFocus} /> : dbOpen ? <DatabasePage projectId={board.project.id} /> : chatsOpen ? <ChatsPage board={board} changed={() => void refresh()} current={freeChat?.chat?.id} openCard={(card, purpose) => setChatCard(card, purpose)} openCardEditor={(card) => setDraft(edit(card))} openFree={openFree} deleted={(chatId) => { if (freeChat?.chat?.id === chatId) setFreeChat(undefined) }} /> : <>{filtering && <div className="board-filterbar"><button type="button" className="board-filter-clear" onClick={() => { setBoardQuery(''); setPriorityFilter(''); setTypeFilter(''); setAgentFilter('') }}>{t.view.clearFilters}</button></div>}<div className="board-filters" role="search" aria-label={t.view.filterBoardCards}><input className="in" type="search" aria-label={t.view.searchCards} placeholder={t.view.searchCardsPlaceholder} value={boardQuery} onChange={(event) => setBoardQuery(event.target.value)} /><Select label={t.view.filterByPriority} value={priorityFilter} options={[{ value: '', label: t.view.allPriorities }, ...(Object.entries(t.priority) as Array<[Card['priority'], string]>).map(([value, label]) => ({ value, label }))]} onChange={(value) => setPriorityFilter(value as Card['priority'] | '')} /><Select label={t.view.filterByType} value={typeFilter} options={[{ value: '', label: t.view.allTypes }, ...cardTypeOptions(cardTypes, typeFilter || undefined)]} onChange={setTypeFilter} /><Select label={t.view.filterByAgent} value={agentFilter} options={[{ value: '', label: t.view.allAgents }, ...allowed.map((profile) => ({ value: profile.id, label: profile.label, icon: <AgentIcon profile={profile} size="sm" tip={false} /> }))]} onChange={setAgentFilter} /></div><div className="kanban" style={{ gridTemplateColumns: `repeat(${Math.max(board.columns.length, 1)}, minmax(210px, 1fr))` }}>{board.columns.map((column) => {
      const allCards = active.filter((card) => card.columnId === column.id), cards = visibleCards.filter((card) => card.columnId === column.id)
      return <section className={`col ${overColumn === column.id ? 'over' : ''}`} key={column.id} onDragOver={(e) => { e.preventDefault(); setOverColumn(column.id) }} onDragLeave={() => setOverColumn(undefined)} onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('card'); clear(); if (id) void move(id, column.id, null) }}>
        <header>{column.label}<span className="colTools"><b data-tip={filtering ? t.view.cardsVisible(cards.length, allCards.length) : undefined}>{filtering ? `${cards.length}/${allCards.length}` : cards.length}</b><ColumnMenu label={column.label} count={allCards.length} add={() => setChoosing(column.id)} archiveAll={() => setArchivingColumn(column.id)} /></span></header>
        {cards.map((card) => <CardTile key={card.id} card={card} types={cardTypes} onComplexity={() => setAssessing(card)} state={column.semanticState} agent={history.find((profile) => profile.id === (card.run.profileId ?? card.execProfileId))} agents={card.agentIds.map((id) => history.find((profile) => profile.id === id)).filter((profile): profile is AgentProfile => Boolean(profile))} dropLabel={dropOn === card.id ? dropLabel(card) : undefined}
          onPending={() => setPendingCard(card)} onSend={() => void sendChanges(card.id)} onSendFailures={() => void sendFailures(card.id)} onGit={() => openCardGit(card.id)} onOpen={() => setDraft(edit(card))} onChat={() => setChatCard(card)} onPlan={() => setChatCard(card)} onStart={() => setStartingState({ card, purpose: 'execution' })} onTest={() => setStartingState({ card, purpose: 'test' })} onRetry={() => setStartingState({ card, purpose: card.run.purpose === 'test' ? 'test' : 'execution', retry: true })} onStop={() => setStopping(card)}
          onResume={() => void window.gearmod.invoke('cards:resume', { cardId: card.id, purpose: card.run.purpose === 'test' ? 'test' : card.run.purpose === 'execution' ? 'execution' : undefined }).then(refresh).catch((reason: unknown) => { const text = plainError(reason); if (errorCodeOf(text) === 'nothing-to-continue') setStartingState({ card, purpose: card.run.purpose === 'test' ? 'test' : 'execution', retry: true }); else say(withoutErrorCode(text), 'error') })}
          onArchive={() => void window.gearmod.invoke('cards:archive', { cardId: card.id }).then(() => { say(t.view.cardArchived); return refresh() })}
          onFinalize={() => setFinalizing(card)}
          dragProps={{ draggable: true, onContextMenu: (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, card }) }, onDragStart: (e) => { e.dataTransfer.setData('card', card.id); setDragId(card.id) }, onDragEnd: clear, onDragOver: (e) => { e.preventDefault(); e.stopPropagation(); setDropOn(card.id) }, onDrop: (e) => { e.stopPropagation(); const id = e.dataTransfer.getData('card'); clear(); if (id && id !== card.id) void move(id, column.id, card.id) } }} />)}
        {filtering && !cards.length && allCards.length > 0 && <p className="board-filter-empty">{t.view.noCardMatchesFilters}</p>}<button className="add" onClick={() => setChoosing(column.id)}>{t.view.addCard}</button>
      </section>
    })}</div></>}
    {choosing && <NewCardDialog project={board.project} close={() => setChoosing(undefined)} manual={(start) => { setDraft({ ...blankDraft(choosing, cardTypes[0]?.id ?? 'feature'), start }); setChoosing(undefined) }} plan={(start) => { const columnId = choosing; setChoosing(undefined); setChatCardState(undefined); setFreeChat(undefined); setChatPurpose('planning'); setChatInstance(Date.now()); setDraftPlan({ columnId, start }) }} />}
    {draft && <CardEditor projectId={board.project.id} sources={board.project.sources} profiles={allowed} cardTypes={cardTypes} pending={draft.id ? (board.cards.find((item) => item.id === draft.id)?.pending) : undefined} onPending={() => { const card = board.cards.find((item) => item.id === draft.id); if (card) setPendingCard(card) }} draft={draft} close={() => setDraft(undefined)} saved={async () => { setDraft(undefined); await refresh() }} openChat={draft.id ? (purpose) => { const card = board.cards.find((item) => item.id === draft.id); setDraft(undefined); if (card) setChatCard(card, purpose) } : undefined} onStart={draft.id ? (purpose) => { const card = board.cards.find((item) => item.id === draft.id); setDraft(undefined); if (card) setStartingState({ card, purpose }) } : undefined} />}
    {starting && <StartDialog card={starting.card} purpose={starting.purpose} profiles={allowed} retry={starting.retry ? { error: board.cards.find((item) => item.id === starting.card.id)?.run.error ?? '' } : undefined} close={() => setStartingState(undefined)} start={async (config, baseBranch, replaceAgent) => { await window.gearmod.invoke('cards:start', { cardId: starting.card.id, config, purpose: starting.purpose, baseBranch, ...(replaceAgent ? { replaceAgent } : {}) }); setStartingState(undefined); await refresh(); setChatCard(starting.card, starting.purpose) }} />}
    {gate && (() => { const card = board.cards.find((item) => item.id === gate.cardId); if (!card) return null; return <ConfirmDialog eyebrow={t.view.gate.eyebrow} title={card.title || t.newCard} text={gate.stage === 'test' ? t.view.gate.textTest : t.view.gate.textReview} ok={gate.stage === 'test' ? t.view.gate.runTests : t.view.gate.openChanges} secondary={{ label: t.view.gate.moveAnyway, run: () => { const next = gate; setGate(undefined); void move(next.cardId, next.columnId, next.beforeCardId, true) } }} cancel={() => setGate(undefined)} confirm={() => { const next = gate; setGate(undefined); if (next.stage === 'test') void runGateTests(card); else setChatCard(card, 'test') }} /> })()}
    {cleanup && <DoneCleanupDialog cardId={cleanup.id} projectId={cleanup.projectId} title={cleanup.title || t.newCard} close={() => { setCleanup(undefined); void refresh() }} openGit={() => openCardGit(cleanup.id)} />}
    {finalizing && <ConfirmDialog eyebrow={t.view.finalize.eyebrow} title={finalizing.title || t.newCard} text={t.view.finalize.text} ok={t.view.finalize.ok} cancel={() => setFinalizing(undefined)} confirm={() => { const cardId = finalizing.id; setFinalizing(undefined); void window.gearmod.invoke('cards:finalize', { cardId }).then(() => { say(t.view.finalize.done); return refresh() }).catch((reason: unknown) => say(plainError(reason))) }} />}
    {stopping && <ConfirmDialog eyebrow={t.view.stop.eyebrow} title={t.view.stop.title} text={t.view.stop.text} ok={t.view.stop.ok} danger cancel={() => setStopping(undefined)} confirm={() => { const card = stopping; setStopping(undefined); if (card.run.runId) void window.gearmod.invoke('agents:cancel', { runId: card.run.runId }).then(refresh).catch((reason: unknown) => say(plainError(reason), 'error')) }} />}
    {assessing && <AssessmentDialog card={fresh(assessing)} close={() => setAssessing(undefined)} changed={() => void refresh()} />}
    {pendingCard && <PendingDialog card={fresh(pendingCard)} close={() => setPendingCard(undefined)} changed={() => void refresh()} />}
    {menu && <CardContextMenu x={menu.x} y={menu.y} card={menu.card} close={() => setMenu(undefined)} open={() => { const card = menu.card; setMenu(undefined); setDraft(edit(card)) }} chat={() => { const card = menu.card; setMenu(undefined); setChatCard(card) }} git={() => { const card = menu.card; setMenu(undefined); openCardGit(card.id) }} remove={() => { const card = menu.card; setMenu(undefined); setDeleting(card) }} />}
    {foreign && <ConfirmDialog eyebrow={t.view.foreign.eyebrow} title={t.view.foreign.title} text={t.view.foreign.text(foreign.ownerTitle)} ok={t.view.foreign.ok} cancel={() => setForeign(undefined)} confirm={() => { const info = foreign; setForeign(undefined); void window.gearmod.invoke('worktrees:link', { cardId: info.cardId, fromCardId: info.ownerCardId }).then(() => refresh()).catch((reason: unknown) => say(plainError(reason), 'error')) }} />}
    {archivingColumn && <ConfirmDialog eyebrow={t.view.archiveColumn.eyebrow} title={t.view.archiveColumn.title(board.columns.find((column) => column.id === archivingColumn)?.label)} text={t.view.archiveColumn.text(active.filter((card) => card.columnId === archivingColumn).length)} ok={t.view.archiveColumn.ok} cancel={() => setArchivingColumn(undefined)} confirm={() => { const id = archivingColumn; setArchivingColumn(undefined); void archiveColumn(id) }} />}
    {deleting && <DeleteCardDialog title={deleting.title || t.newCard} cancel={() => setDeleting(undefined)} confirm={(deleteArtifacts) => { const card = deleting; setDeleting(undefined); void window.gearmod.invoke('cards:delete', { cardId: card.id, deleteArtifacts }).then(() => { say(t.view.cardDeleted); return refresh() }).catch((reason: unknown) => say(plainError(reason), 'error')) }} />}
    {suggestDisableInitialChat && <ConfirmDialog eyebrow={t.view.initialChatSuggest.eyebrow} title={t.view.initialChatSuggest.title} text={t.view.initialChatSuggest.text} ok={t.view.initialChatSuggest.ok} cancel={() => { setSuggestDisableInitialChat(false); recordInitialChatEvent('declined') }} confirm={() => { setSuggestDisableInitialChat(false); recordInitialChatEvent('confirmed'); void window.gearmod.invoke('settings:update', { chatLateralInicial: false }).then((updated) => { window.dispatchEvent(new CustomEvent(settingsChangedEvent, { detail: updated })); say(t.view.initialChatSuggest.disabled) }).catch((reason: unknown) => say(plainError(reason), 'error')) }} />}
    </main>
    {chatCard && allowed.length === 0 && <NoAgentDialog project={board.project} profiles={profiles} close={() => setChatCard(undefined)} allowed={() => void refresh()} openSettings={() => { setChatCard(undefined); openSettings() }} />}
    {freeChat && allowed.length > 0 && <FreeChat key={freeChat.key} docked={freeChat.docked} mode={freeChat.mode} prompt={freeChat.prompt} startConfig={freeChat.config} project={board.project} profiles={allowed} chat={freeChat.chat} close={(unusedDocked) => { setFreeChat(undefined); if (unusedDocked && recordInitialChatEvent('closed-unused').shouldPrompt) setSuggestDisableInitialChat(true) }} changed={() => void refresh()} onConverted={(cardId) => { void refresh().then(() => setOpenAfterRefresh(cardId)) }} />}
    {freeChat && allowed.length === 0 && <NoAgentDialog project={board.project} profiles={profiles} close={() => setFreeChat(undefined)} allowed={() => void refresh()} openSettings={() => { setFreeChat(undefined); openSettings() }} />}
    {draftPlan && allowed.length === 0 && <NoAgentDialog project={board.project} profiles={profiles} close={() => setDraftPlan(undefined)} allowed={() => void refresh()} openSettings={() => { setDraftPlan(undefined); openSettings() }} />}
    {(chatCard || draftPlan) && allowed.length > 0 && <CardChat key={`chat-${chatInstance}-${chatPurpose}`} project={board.project} card={chatCard ? fresh(chatCard) : draftCard(board, draftPlan!.columnId)} board={board} profiles={history} columnLabel={chatCard ? columnLabel(chatCard) : board.columns.find((column) => column.id === draftPlan?.columnId)?.label ?? ''} mode={chatPurpose} onSwitch={setChatPurpose} close={() => { setChatCard(undefined); setDraftPlan(undefined); setGitCardId(undefined) }} openEdit={(card) => setDraft(edit(card))} openChat={(card) => setChatCard(card)} initialView={gitCardId === chatCard?.id ? 'git' : 'chat'} openRules={() => onProjectConfig('git')} openGraph={(id) => { setChatCardState(undefined); setGitCardId(undefined); setChatsOpen(false); setGitOpen(true); setGitFocus({ cardId: id, at: Date.now() }) }}
      ensureCard={draftPlan && !chatCard ? async () => { const created = await window.gearmod.invoke('cards:create', { projectId: board.project.id, columnId: draftPlan.columnId, title: '', description: '', type: cardTypes[0]?.id ?? 'feature', priority: 'medium', acceptanceCriteria: [], ...draftPlan.start }); await refresh(); setDraftPlan(undefined); setChatCardState(created); return created } : undefined} />}
  </div>
}
