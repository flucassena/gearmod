import { AgentBackground } from './AgentBackground'
import { AgentPermissions } from './AgentPermissions'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { dropToken, InputMirror, useAtMention } from './AtMention'
import { defaultPermissionMode, permissionModes, type AgentProfile, type AgentPurpose, type Card, type PermissionMode, type Chat, type ChatMessage, type Project, type ProjectBoard, type Run, type SkillRef } from '@gearmod/contracts'
import { AgentIcon } from './AgentIcon'
import { ConfirmDialog } from './ConfirmDialog'
import { shortcutEvent, shortcutLabel } from './shortcuts'
import { WindowIcon } from './WindowLayoutMenu'
import { BranchIcon, CardIcon, CheckIcon, ChevronLeftIcon, CloseIcon, CollapseIcon, ExpandIcon, MicIcon, MoreHorizontalIcon, SearchIcon, SendIcon, StopIcon, TreeIcon } from './icons'
import { ModelMenu, permissionModeText, useAgentConfig } from './ModelMenu'
import { createPortal } from 'react-dom'
import { AssessmentDialog, ComplexityBadge } from './Assessment'
import { worktreeName } from './workspace'
import { ChatMessageList } from './ChatMessageView'
import { FileOpenContext } from './markdown'
import { AgentMessage, QuestionAnswerContext } from './AgentMessage'
import { ViewGrip, useFileViewer } from './FileViewer'
import { FocusedFile } from './editor/FocusedFile'
import { UsageRings } from './UsageRings'
import { QueuedPreview, useQueuedMessage } from './QueuedMessage'
import { AttachButton, AttachmentChips, useAttachments, useContextText } from './Attachments'
import { ChatReplySelection, ReplyContextCards, useChatReplies } from './ChatReplies'
import { withChatReplies } from './chatReplyContext'
import { ThinkingIndicator, useBusySince, useTypewriter } from './Thinking'
import { plainError } from './NoticeDialog'
import { DecisionsSide } from './DecisionsSide'
import { ChangesCard } from './ChangesCard'
import { CommitAsks, DiffPane, GitCardPanel, type DiffTarget } from './GitCardPanel'
import { ApprovalAsks } from './ApprovalCard'
import { SpecKitAsks, SpecKitModeChip, useSpecKit } from './SpecKitAsks'
import { ProgressCard } from './ProgressCard'
import { PopMenu } from './PopMenu'
import { ChatSearch, searchMessages, snippet, useChatSearchShortcut } from './ChatSearch'
import { useFitInView } from './useFitInView'
import { terminal } from './terminalStore'
import { useDictation } from './useDictation'
import { useStickToBottom } from './useStickToBottom'
import { adoptLiveRun, liveDelta, resetLiveRun, type LiveRunRefs } from './liveRun'
import { listKeyDown, type InputEdit } from './markdownInput'
import { pop } from './popout'
import { PlanHero } from './PlanHero'
import { useT } from './i18n'
import { useProjectSkills, useSlashSkills } from './SlashSkills'

/** Dock state that survives tab switching (the chat remounts at each stage): collapsed/expanded and width. */
const dockMin = 440
const stored = (): number => { try { return Number(localStorage.getItem('gearmod.dockWidth')) || dockMin } catch { return dockMin } }
const dockState = { expanded: true, width: stored() }
const clampWidth = (value: number): number => Math.max(dockMin, Math.min(Math.round(window.innerWidth * 0.65), value))

/** Collapsed/expanded and width of the dock, shared between the card chat and the free chat. */
export function useDockSize(startDocked = false): { expanded: boolean; setExpanded(value: boolean): void; width: number; setWidth(value: number): void; dragging: boolean; startResize(event: React.PointerEvent<HTMLDivElement>): void; resetWidth(): void } {
  const [expanded, setExpandedState] = useState(startDocked ? false : dockState.expanded), [width, setWidthState] = useState(() => clampWidth(dockState.width)), [dragging, setDragging] = useState(false)
  const setExpanded = (value: boolean): void => { dockState.expanded = value; setExpandedState(value) }
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault(); setDragging(true)
    const move = (e: PointerEvent): void => { const next = clampWidth(window.innerWidth - e.clientX); dockState.width = next; setWidthState(next) }
    const up = (): void => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); setDragging(false); try { localStorage.setItem('gearmod.dockWidth', String(dockState.width)) } catch { /* only valid for this session */ } }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
  }
  const setWidth = (value: number): void => { dockState.width = value; setWidthState(value); try { localStorage.setItem('gearmod.dockWidth', String(value)) } catch { /* only valid for this session */ } }
  return { expanded, setExpanded, width, setWidth, dragging, startResize, resetWidth: () => { dockState.width = dockMin; setWidthState(dockMin) } }
}

const typeColor: Record<Card['type'], string> = { feature: 'var(--tone-info)', bug: 'var(--tone-danger)', improvement: 'var(--accent-strong)', task: 'var(--tone-neutral)', minor: 'var(--tone-warning)' }

const SearchGlyph = (): React.JSX.Element => <SearchIcon />

/** Header actions grouped when the narrow dock cannot fit all the buttons. */
export function ChatMoreMenu({ messages, log, projectId, cardId, chatId, purpose, expand, view, openCard, searchRequest = 0 }: { openCard?(): void; messages: ChatMessage[]; log: React.RefObject<HTMLDivElement | null>; projectId: string; cardId?: string; chatId?: string; purpose?: AgentPurpose; expand(): void; close(): void; view?: { git: boolean; set(value: 'chat' | 'git'): void }; searchRequest?: number }): React.JSX.Element {
  const t = useT(), m = t.chat.moreMenu
  const [open, setOpen] = useState(false), [page, setPage] = useState<'main' | 'search' | 'window'>('main'), [query, setQuery] = useState('')
  const box = useRef<HTMLSpanElement>(null), input = useRef<HTMLInputElement>(null), menu = useRef<HTMLDivElement>(null), results = searchMessages(messages, query)
  useFitInView(menu, open)
  useEffect(() => { if (!searchRequest || !box.current?.getClientRects().length) return; setPage('search'); setOpen(true); window.setTimeout(() => { input.current?.focus(); input.current?.select() }, 0) }, [searchRequest])
  useEffect(() => {
    if (!open) return
    if (page === 'search') input.current?.focus()
    const away = (event: PointerEvent): void => { if (!box.current?.contains(event.target as Node)) { setOpen(false); setPage('main') } }
    const esc = (event: KeyboardEvent): void => { if (event.key === 'Escape') { setOpen(false); setPage('main') } }
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [open, page])
  const dismiss = (): void => { setOpen(false); setPage('main') }
  /** Scrolls the chat to a message and flashes it. While choosing a result (arrows or mouse over) it only previews: the search box stays open. */
  const reveal = (id: string): void => {
    const target = [...(log.current?.querySelectorAll<HTMLElement>('[data-mid]') ?? [])].find((element) => element.dataset.mid === id)
    if (!target) return
    target.scrollIntoView({ block: 'center', behavior: 'smooth' }); target.classList.add('searchhit'); window.setTimeout(() => target.classList.remove('searchhit'), 1800)
  }
  const goMessage = (id: string): void => {
    if (view?.git) view.set('chat'); dismiss()
    window.setTimeout(() => reveal(id), view?.git ? 80 : 0)
  }
  const [sel, setSel] = useState(-1), shown = results.slice(0, 40)
  useEffect(() => { setSel(-1) }, [query])
  const choose = (index: number, scroll: boolean): void => {
    const next = shown[index]; if (!next) return
    setSel(index); reveal(next.id)
    if (scroll) menu.current?.querySelectorAll<HTMLElement>('.cs-item')[index]?.scrollIntoView({ block: 'nearest' })
  }
  const place = (placement: 'left' | 'right' | 'top' | 'bottom' | 'new'): void => {
    dismiss()
    if (pop) { if (placement !== 'new') void window.gearmod.invoke('windows:place', { placement }); return }
    if (cardId || chatId) void window.gearmod.invoke('windows:open', { kind: 'chat', projectId, ...(cardId ? { cardId, purpose } : {}), ...(chatId ? { chatId } : {}), placement })
  }
  return <span className="popwrap dockmore" ref={box}>
    <button type="button" className="ibtn morebtn" aria-label={m.moreOptions} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open); setPage('main') }}><MoreHorizontalIcon /></button>
    {open && <div className="popmenu dockmore-menu" ref={menu} role={page === 'search' ? 'dialog' : 'menu'} aria-label={m.chatMoreOptions}>
      {page !== 'main' && <button type="button" className="pm-back" onClick={() => setPage('main')}>‹ <span>{page === 'search' ? m.search : pop ? m.moveWindow : m.openInOtherWindow}</span></button>}
      {page === 'main' && <>
        {openCard && <button type="button" role="menuitem" className="pm-item pm-ico" onClick={() => { dismiss(); openCard() }}><CardIcon />{m.openCard}</button>}
        {view && <button type="button" role="menuitem" className="pm-item pm-ico" onClick={() => { dismiss(); view.set(view.git ? 'chat' : 'git') }}><BranchIcon />{view.git ? m.backToChat : m.viewCardGit}</button>}
        <button type="button" role="menuitem" className="pm-item pm-ico" onClick={() => setPage('search')}><SearchGlyph />{m.searchInChat} <small>{shortcutLabel('find')}</small></button>
        {(cardId || chatId) && <button type="button" role="menuitem" className="pm-item pm-ico" onClick={() => setPage('window')}><WindowIcon />{pop ? m.moveThisWindow : m.openInOtherWindow}</button>}
        <button type="button" role="menuitem" className="pm-item pm-ico" onClick={() => { dismiss(); expand() }}><ExpandIcon />{m.expandFull}</button>
      </>}
      {page === 'search' && <>
        <input ref={input} className="in" value={query} placeholder={m.searchInChat} aria-label={m.searchInChat} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (shown.length) choose(event.key === 'ArrowDown' ? Math.min(shown.length - 1, sel + 1) : Math.max(0, sel < 0 ? 0 : sel - 1), true) }
          else if (event.key === 'Enter' && (shown[sel] ?? shown[0])) goMessage((shown[sel] ?? shown[0]!).id)
        }} />
        <div className="cs-list">{query.trim().length < 2 ? <p className="ch-muted">{t.chat.search.minLetters}</p> : !results.length ? <p className="ch-muted">{t.chat.search.nothingFound}</p> : shown.map((message, index) => <button type="button" key={message.id} className={`cs-item ${index === sel ? 'on' : ''}`} onMouseEnter={() => { if (index !== sel) choose(index, false) }} onClick={() => goMessage(message.id)}><b>{message.role === 'user' ? t.chat.roles.user : message.role === 'assistant' ? t.chat.roles.assistant : t.chat.roles.system}</b><span>{snippet(message.body, query.trim())}</span></button>)}</div>
      </>}
      {page === 'window' && <div className="pm-places">{(['left', 'right', 'top', 'bottom'] as const).map((placement) => <button type="button" role="menuitem" className="pm-item" key={placement} onClick={() => place(placement)}>{m.places[placement]}</button>)}{!pop && <><div className="pm-sep" /><button type="button" role="menuitem" className="pm-item pm-ico" onClick={() => place('new')}><WindowIcon />{m.openInNewWindow}</button></>}</div>}
    </div>}
  </span>
}

function Tile({ card, board, here, profiles, open, openCard }: { card: Card; board: ProjectBoard; here: boolean; profiles: AgentProfile[]; open(): void; openCard(): void }): React.JSX.Element {
  const t = useT().chat.tile
  const run = card.run.state, agent = profiles.find((profile) => profile.id === (card.run.profileId ?? card.execProfileId))
  const state = board.columns.find((column) => column.id === card.columnId)
  const ready = run === 'idle' && card.hasPlan && (state?.semanticState === 'backlog' || state?.semanticState === 'todo')
  const waiting = (card.waiting ?? 0) > 0
  const status = waiting ? <><span className="dot pulse tone-text tone-warning" /><small className="tone-text tone-warning">{t.needsYou}</small></> : card.planningOpen ? <><span className="dot dot-plan" /><small>{t.inPlanning}</small></> : run === 'running' ? <><span className="spin sm" /><small>{t.running}</small></> : run === 'planning' ? <><span className="dot dot-plan pulse" /><small>{t.planning}</small></> : ready ? <><span className="dot softpulse tone-text tone-success" /><small>{t.planReady}</small></> : run === 'finished' ? <><span className="dot pulse tone-text tone-success" /><small>{t.finished}</small></> : run === 'paused' ? <small className="tone-text tone-warning">{t.paused}</small> : run === 'failed' ? <small className="tone-text tone-danger" data-tip={card.run.error ?? undefined}>{t.failed}</small> : <small>{state?.label}</small>
  return <div role="button" tabIndex={0} className={`tile ${waiting ? 'wait' : ''} ${run === 'running' ? 'run' : ''} ${run === 'planning' ? 'plan' : ''} ${here ? 'here' : ''}`} onClick={open} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open() } }}><span className="tdot" style={{ background: typeColor[card.type] }} /><span className="ttl">{card.title || t.newCard}</span><span className="tfoot">{agent ? <AgentIcon profile={agent} size="sm" /> : <i />}<span className="tst">{status}</span><button type="button" className="ibtn tip tcard" data-tip={t.openCardTip} aria-label={t.openCardTip} onClick={(event) => { event.stopPropagation(); openCard() }}><CardIcon /></button></span></div>
}

/** Quick view (prototype): what is running now and the other cards, with each one's state. */
function Activity({ board, cardId, profiles, openEdit, openChat, hide }: { board: ProjectBoard; cardId: string; profiles: AgentProfile[]; openEdit(card: Card): void; openChat(card: Card): void; hide(): void }): React.JSX.Element {
  const t = useT().chat.activity
  const cards = board.cards.filter((card) => !card.archivedAt && board.columns.find((column) => column.id === card.columnId)?.semanticState !== 'done'), running = cards.filter((card) => card.run.state === 'running')
  const rank = (card: Card): number => card.id === cardId ? 0 : (card.waiting ?? 0) > 0 ? 0.25 : card.run.state === 'finished' ? 0.5 : card.run.state === 'planning' ? 1 : card.hasPlan && card.run.state === 'idle' ? 2 : 3 + board.columns.findIndex((column) => column.id === card.columnId)
  const rest = cards.filter((card) => card.run.state !== 'running').sort((a, b) => rank(a) - rank(b))
  return <section className="activity qv-wrap"><button type="button" className="side-toggle qv-toggle tip" data-tip={t.hide} aria-label={t.hide} onClick={hide}><ChevronLeftIcon style={{ transform: 'rotate(180deg)' }} /></button><div className="qv-inner"><div className="qv-head"><div className="eyebrow">{t.quickView}</div></div>
    <div className="agrp"><span>{t.running}</span><b>{running.length}</b></div>
    <div className="tilecol">{running.length ? running.map((card) => <Tile key={card.id} card={card} board={board} here={card.id === cardId} profiles={profiles} open={() => openChat(card)} openCard={() => openEdit(card)} />) : <div className="emptyact">{t.nothingRunning}</div>}</div>
    <div className="agrp"><span>{t.otherCards}</span><b>{rest.length}</b></div>
    <div className="tilecol">{rest.map((card) => <Tile key={card.id} card={card} board={board} here={card.id === cardId} profiles={profiles} open={() => openChat(card)} openCard={() => openEdit(card)} />)}</div>
  </div></section>
}

/** Card chat (planning or execution) like the prototype's dock: docked to the right or fullscreen with the quick view. */
export function CardChat({ project, card, board, profiles, columnLabel, mode, close, openEdit, openChat, onSwitch, ensureCard, initialView = 'chat', openRules, openGraph }: { initialView?: 'chat' | 'git'; openRules?(): void; openGraph?(cardId: string): void; project: Project; card: Card; board: ProjectBoard; profiles: AgentProfile[]; columnLabel: string; mode: AgentPurpose; close(): void; openEdit(card: Card): void; openChat(card: Card): void; onSwitch(purpose: AgentPurpose): void; ensureCard?(): Promise<Card> }): React.JSX.Element {
  const t = useT(), c = t.chat.cardChat, d = t.chat.dock, act = t.chat.activity
  const usable = profiles.filter((profile) => project.allowedProfileIds.includes(profile.id))
  const [assessing, setAssessing] = useState(false), [chat, setChat] = useState<Chat>(), [messages, setMessages] = useState<ChatMessage[]>([]), [run, setRun] = useState<Run>(), [live, setLive] = useState('')
  const [input, setInput] = useState(''), [error, setError] = useState(''), [skill, setSkill] = useState<SkillRef | null>(null)
  const [menu, setMenu] = useState<'mode' | 'skill' | null>(null), [skillFilter, setSkillFilter] = useState(''), [voiceSetup, setVoiceSetup] = useState(false)
  const chatRef = useRef<Chat | undefined>(undefined)
  const log = useRef<HTMLDivElement>(null), runId = useRef<string | undefined>(undefined), seen = useRef(-1), liveRefs: LiveRunRefs = { runId, seen }, wrap = useRef<HTMLDivElement>(null), skillFilterInput = useRef<HTMLInputElement>(null)
  const [chats, setChats] = useState<Chat[]>([])
  // A short flow has a single agent and a single chat (plans, executes and validates): the tab does not distinguish stages.
  const singleChat = card.workflow === 'light' && chats.length <= 1
  // The worktree already exists during planning; the column defines when the single chat enters execution.
  const columnState = board.columns.find((column) => column.id === card.columnId)?.semanticState
  const fullAgent = singleChat && (columnState === 'doing' || columnState === 'test' || columnState === 'done')
  const planning = mode === 'planning' && !fullAgent
  const specKit = useSpecKit(card.id), [dockHost, setDockHost] = useState<HTMLElement | null>(null)
  const [view, setView] = useState<'chat' | 'git'>(initialView), [diff, setDiff] = useState<DiffTarget>()
  const gitView = view === 'git' && Boolean(card.id) && !planning
  const { expanded, setExpanded, width, setWidth, dragging, startResize, resetWidth } = useDockSize()
  const chatSearch = useChatSearchShortcut(expanded)
  useEffect(() => { const navigate = (): void => { if (expanded) close() }; window.addEventListener('gearmod:select-view', navigate); return () => window.removeEventListener('gearmod:select-view', navigate) }, [expanded, close])
  const [quickHidden, setQuickHiddenState] = useState(() => { try { return localStorage.getItem('gearmod.quickView.hidden') === '1' } catch { return false } })
  const quickHiddenRef = useRef(quickHidden), expandedRef = useRef(expanded), diffOpenRef = useRef(false)
  quickHiddenRef.current = quickHidden; expandedRef.current = expanded
  useEffect(() => {
    const onShortcut = (event: Event): void => { if ((event as CustomEvent<{ id: string }>).detail.id === 'toggleQuickView' && expandedRef.current && !diffOpenRef.current) setQuickHidden(!quickHiddenRef.current) }
    window.addEventListener(shortcutEvent, onShortcut); return () => window.removeEventListener(shortcutEvent, onShortcut)
  }, [])
  const setQuickHidden = (value: boolean): void => { setQuickHiddenState(value); try { localStorage.setItem('gearmod.quickView.hidden', value ? '1' : '0') } catch { /* convenience only */ } }
  useEffect(() => { if (!card.id) return; terminal.setContext({ projectId: project.id, cardId: card.id }); return () => terminal.setContext({ projectId: project.id, cardId: null }) }, [card.id, project.id])
  const viewer = useFileViewer(width, setWidth)
  const openFile = useCallback((path: string) => { setExpanded(false); viewer.open(path) }, [viewer.open])
  const [switchTo, setSwitchTo] = useState<AgentProfile>()
  const agentState = useAgentConfig(card.id, mode, usable, chat?.profileId)
  const attach = useAttachments({ projectId: project.id, cardId: card.id || null })
  const replies = useChatReplies()
  const mention = useAtMention({ projectId: project.id, cardId: card.id || null, input, setInput })
  useContextText({ projectId: project.id, cardId: card.id || null }, (text) => setInput((value) => (value.trim() ? `${value.replace(/\s+$/, '')}\n\n${text}` : text)))
  const dictation = useDictation(useCallback((text: string) => setInput((value) => `${value}${value && !/\s$/.test(value) ? ' ' : ''}${text}`), []), card.title || undefined)
  const voiceReady = Boolean(dictation.status?.modelInstalled && dictation.status.engineInstalled)
  const loadMessages = useCallback(async (chatId: string) => setMessages(await window.gearmod.invoke('messages:list', { chatId })), [])
  useEffect(() => { if (card.id) void window.gearmod.invoke('cards:mark-viewed', { cardId: card.id }).catch(() => undefined) }, [card.id])
  useEffect(() => { if (!card.id) return; void window.gearmod.invoke('chats:list', { projectId: project.id, cardId: card.id }).then((items) => { setChats(items); const found = items.find((item) => item.purpose === mode); if (found) { setChat(found); void loadMessages(found.id); void adoptLiveRun(found.id, liveRefs, setLive) } }).catch((reason: unknown) => setError(plainError(reason))) }, [project.id, card.id, mode, loadMessages])
  useEffect(() => window.gearmod.onRunEvent((event) => {
    if (event.eventType === 'gearmod/tool-activity') { const id = String(event.payload.chatId ?? ''); setChat((current) => { if (current && current.id === id) void loadMessages(id); return current }); return }
    const own = Boolean(chatRef.current) && event.payload.chatId === chatRef.current?.id
    // Run that started outside this component (queued message, resume, chaining): the chat adopts it to show the stream.
    if (event.eventType === 'gearmod/run-started' && own && event.runId) { resetLiveRun(liveRefs, event.runId); setLive(''); void loadMessages(chatRef.current!.id); return }
    if (event.eventType !== 'gearmod/run-completed' || !own) { if (event.runId !== runId.current) return }
    const delta = liveDelta(event, liveRefs)
    if (delta) setLive((value) => value + delta)
    if (event.eventType === 'gearmod/run-completed') { runId.current = undefined; setRun(undefined); setLive(''); setChat((current) => { if (current) void loadMessages(current.id); return current }); void window.gearmod.invoke('cards:mark-viewed', { cardId: card.id }).catch(() => undefined) }
  }), [card.id, loadMessages])
  useEffect(() => { chatRef.current = chat }, [chat])
  // Chat opened with the run already in progress (left and came back): adopts the run to receive the stream again.
  useEffect(() => { if (!runId.current && card.run.runId && card.run.purpose === mode && (card.run.state === 'running' || card.run.state === 'planning')) runId.current = card.run.runId }, [card.run.runId, card.run.state, card.run.purpose, mode])
  useStickToBottom(log)
  const skills = useProjectSkills(project.id)
  useEffect(() => { setSkill(chat?.skill ?? null) }, [chat?.id, chat?.skill])
  useEffect(() => {
    if (!menu) return
    const close = (event: Event): void => { if (!wrap.current?.contains(event.target as Node)) setMenu(null) }
    document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close)
  }, [menu])

  const provider = usable.find((item) => item.id === (agentState.config?.profileId ?? chat?.profileId))?.provider
  const available = skills.filter((item) => provider && item.paths[provider])
  const skillNames = available.map((item) => item.name)
  const skillPreferenceKey = provider ? `gearmod.lastSkill.${project.id}.${provider}.${mode}` : null
  useEffect(() => {
    if (chat || !provider || !skillPreferenceKey || !available.length) return
    try {
      const saved = JSON.parse(localStorage.getItem(skillPreferenceKey) ?? 'null') as SkillRef | null
      if (saved && available.some((item) => item.name === saved.name && item.paths[provider] === saved.path)) setSkill(saved)
    } catch { /* invalid optional preference */ }
  }, [chat?.id, skillPreferenceKey, skills, provider])
  useEffect(() => { if (menu === 'skill') window.setTimeout(() => skillFilterInput.current?.focus(), 0) }, [menu])
  const chooseSkill = async (next: SkillRef | null): Promise<void> => {
    setMenu(null); setSkillFilter('')
    try {
      setError(''); if (chat) setChat(await window.gearmod.invoke('chats:set-skill', { chatId: chat.id, skill: next })); setSkill(next)
      if (skillPreferenceKey) { if (next) localStorage.setItem(skillPreferenceKey, JSON.stringify(next)); else localStorage.removeItem(skillPreferenceKey) }
    } catch (reason) { setError(plainError(reason)) }
  }
  const slashSkill = useSlashSkills({ available, provider, input, setInput, area: mention.ref, choose: (next) => void chooseSkill(next) })
  /** Markdown list edit in the box (Shift+Enter continues the list, Tab indents): new text and caret. */
  const applyEdit = (edit: InputEdit): void => { setInput(edit.text); mention.caret(edit.end); slashSkill.caret(edit.end); window.requestAnimationFrame(() => mention.ref.current?.setSelectionRange(edit.start, edit.end)) }
  const deliver = async (prompt: string, queuedFiles?: string[]): Promise<void> => {
    const files = queuedFiles ?? attach.take()
    if (inactive) { setError(c.agentRemoved(inactive.label.replace(' (desativado)', ''))); setInput(replies.restore(prompt)); attach.add(files); return }
    try {
      setError('')
      let current = chat
      const chosen = agentState.config?.profileId
      let cardId = card.id
      // Planning started without a card: it is only born now, on the first message, so the chat has something to refer to.
      if (!cardId) {
        if (!ensureCard) throw new Error(c.cardNotFound)
        cardId = (await ensureCard()).id
        if (agentState.touched && agentState.config) await window.gearmod.invoke('cards:set-agent-config', { cardId, purpose: mode, config: agentState.config })
      }
      if (!current) { if (!chosen) throw new Error(c.chooseAgent); current = await window.gearmod.invoke('chats:create', { projectId: project.id, cardId, purpose: mode, profileId: chosen, skill }); setChat(current) }
      const started = await window.gearmod.invoke('agents:start', { chatId: current.id, prompt, planning, attachments: files.length ? files : undefined })
      resetLiveRun(liveRefs, started.id); setRun(started); setLive(''); await loadMessages(current.id)
    } catch (reason) { setError(plainError(reason)); const restored = replies.restore(prompt); setInput((value) => [restored, value].filter(Boolean).join('\n\n')); attach.add(files) }
  }
  const cancel = async (): Promise<void> => { const id = run?.id ?? card.run.runId; if (id) await window.gearmod.invoke('agents:cancel', { runId: id }).catch((reason: unknown) => setError(plainError(reason))) }
  const send = async (): Promise<void> => {
    const prompt = withChatReplies(input, replies.items) || (attach.files.length ? 'Veja os arquivos anexados.' : ''); if (!prompt) return
    if (prompt.length + (busy && later.queued ? later.queued.length + 2 : 0) > 100_000) { setError(d.messageTooLong); return }
    setInput(''); replies.clear()
    if (busy) later.queue(prompt, attach.take()); else await deliver(prompt)
  }
  const stop = async (): Promise<void> => { later.markStopped(); await cancel() }
  // Answers to the agent's questions go back as a normal message (queued, if it is still working).
  const answerQuestions = (text: string): void => { if (busy) later.queue(text); else void deliver(text) }
  /** A comment made on the diff is implementation feedback: always goes to the developer. */
  const sendReview = async (text: string): Promise<boolean> => {
    if (mode === 'execution') { answerQuestions(text); setDiff(undefined); setView('chat'); return true }
    if (!card.id) return false
    try {
      setError('')
      const currentChats = await window.gearmod.invoke('chats:list', { projectId: project.id, cardId: card.id })
      let developer = currentChats.find((item) => item.purpose === 'execution')
      if (developer?.busy) throw new Error(c.developerBusy)
      if (!developer) {
        const config = (await window.gearmod.invoke('cards:agent-config', { cardId: card.id })).execution
        if (!config) throw new Error(c.chooseDevAgent)
        developer = await window.gearmod.invoke('chats:create', { projectId: project.id, cardId: card.id, purpose: 'execution', profileId: config.profileId })
      }
      await window.gearmod.invoke('agents:start', { chatId: developer.id, prompt: text, planning: false })
      setDiff(undefined); setView('chat'); onSwitch('execution'); return true
    } catch (reason) { setError(plainError(reason)); return false }
  }
  const detachChat = async (point: { x: number; y: number }): Promise<void> => {
    if (!card.id || pop) return
    try { await window.gearmod.invoke('windows:open', { kind: 'chat', projectId: project.id, cardId: card.id, purpose: mode, placement: 'new', ...point }); close() } catch (reason) { setError(plainError(reason)) }
  }
  // Test mode shortcuts, above the conversation box: each button sends a ready-made request to the tester (queued if it is busy).
  // A single button: the test skill already runs the tests, lint and typecheck and, with Playwright CLI enabled in the project, also the screen criteria.
  // With Playwright enabled, asks whether to watch the browser or run in the background.
  const [pwReady, setPwReady] = useState(false), [testChoice, setTestChoice] = useState(false)
  useEffect(() => { if (mode !== 'test') return; void window.gearmod.invoke('playwright:status', { projectId: project.id }).then((status) => setPwReady(status.enabled && Boolean(status.selected))).catch(() => setPwReady(false)) }, [mode, project.id])
  const retestPrompt = (headed?: boolean): string => `Refaça o teste deste card do começo: reabra o checklist que já existe (mantenha os mesmos itens, desmarque todos e revalide um a um, acrescentando só o que for novo), rode os testes automatizados, o lint e o typecheck${pwReady ? ' e confira os critérios de tela com o Playwright CLI, seguindo a skill gearmod-test.' : '.'}${headed === undefined ? '' : headed ? ' Rode o Playwright com o navegador visível (--headed) e com slowMo para eu acompanhar.' : ' Rode o Playwright sem janela (headless), guardando screenshot e trace do que falhar.'} Me diga o que passou e o que falhou.`
  const testShortcuts = mode === 'test' ? [{ label: c.testAgain, run: () => { if (pwReady) setTestChoice(true); else answerQuestions(retestPrompt()) } }] : []
  const resetAndSwitch = async (target: AgentProfile): Promise<void> => {
    setSwitchTo(undefined)
    try {
      setError('')
      if (chat) { await window.gearmod.invoke('chats:reset', { chatId: chat.id }); setChat(undefined); setMessages([]); setSkill(null) }
      await agentState.update({ profileId: target.id, model: null, effort: null, mode: defaultPermissionMode(target.provider, mode) })
      if (card.id) setChats(await window.gearmod.invoke('chats:list', { projectId: project.id, cardId: card.id }))
    } catch (reason) { setError(plainError(reason)) }
  }
  // Agent removed (deactivated): the history stays, but it no longer executes; to continue the chat must be restarted with another one.
  const inactive = chat && !usable.some((item) => item.id === chat.profileId) ? profiles.find((item) => item.id === chat.profileId) : undefined
  const resetInactive = async (): Promise<void> => {
    if (!chat) return
    try { setError(''); await window.gearmod.invoke('chats:reset', { chatId: chat.id }); setChat(undefined); setMessages([]); setSkill(null); setChats(await window.gearmod.invoke('chats:list', { projectId: project.id, cardId: card.id })) }
    catch (reason) { setError(plainError(reason)) }
  }
  const typed = useTypewriter(live)
  const busy = Boolean(run) || ((card.run.state === 'running' || card.run.state === 'planning') && card.run.purpose === mode)
  const busySince = useBusySince(busy, run?.startedAt)
  const later = useQueuedMessage(busy, deliver)
  const execModes = provider ? permissionModes[provider].filter((item) => item.purposes.includes('execution')) : []
  const currentMode = execModes.find((item) => item.id === agentState.config?.mode)
  // Saved right away (not only on the next message): the agent already running switches mode without waiting for the turn to end.
  const changeMode = async (id: PermissionMode): Promise<void> => {
    await agentState.update({ mode: id })
    if (agentState.config) await window.gearmod.invoke('cards:set-agent-config', { cardId: card.id, purpose: mode, config: { ...agentState.config, mode: id } }).catch(() => undefined)
  }
  const modeText = (item: (typeof execModes)[number]): { label: string; description: string } => permissionModeText(provider!, item)
  const testing = mode === 'test'

  const diffOpen = Boolean(diff) && view === 'git' && Boolean(card.id) && !planning
  diffOpenRef.current = diffOpen
  const viewing = !expanded && (viewer.requested !== null || diffOpen)
  return <section ref={chatSearch.ref} className={`dock open ${expanded ? 'full' : ''} ${expanded && quickHidden ? 'noactivity' : ''} ${viewing ? 'withviewer' : ''} ${dragging || viewer.dragging ? 'dragging' : ''}`} aria-label={c.ariaChat} style={expanded ? undefined : { width: width + (viewing ? viewer.width : 0) }}>
    {viewer.dialog}{!expanded && <div className="dockgrip" role="separator" aria-orientation="vertical" aria-label={viewing ? d.adjustFileWidth : d.adjustChatWidth} onPointerDown={viewing ? viewer.startResize : startResize} onDoubleClick={viewing ? undefined : resetWidth} />}
    {viewing && <>{diffOpen && diff ? <DiffPane cardId={card.id} target={diff} close={() => setDiff(undefined)} ask={sendReview} style={{ width: viewer.width }} /> : viewer.request && <FocusedFile projectId={project.id} cardId={card.id || null} chatId={chat?.id} request={viewer.request} close={viewer.close} setDirty={viewer.setDirty} style={{ width: viewer.width }} />}<ViewGrip viewer={viewer} /></>}
    <FileOpenContext.Provider value={openFile}><QuestionAnswerContext.Provider value={answerQuestions}>
    <div className="dock-in" style={expanded ? undefined : { width }}>
      <div className="dock-head" draggable={Boolean(card.id) && !pop} onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest('button,input,textarea,[role="tab"],.dock-tools')) setExpanded(!expanded) }} onDragStart={(event) => { if ((event.target as HTMLElement).closest('button,input,textarea,[role="tab"],.dock-tools')) { event.preventDefault(); return }; event.preventDefault(); void detachChat({ x: Math.round(event.screenX), y: Math.round(event.screenY) }) }}><div className="top"><div><div className="headrow">          <div className="tabs stepTabs" role="tablist" aria-label={c.cardChats}>{(['planning', 'execution', 'test'] as const).filter((step) => singleChat ? step === (chats[0]?.purpose ?? mode) : step === mode || chats.some((item) => item.purpose === step)).map((step) => { const working = card.run.purpose === step && (card.run.state === 'running' || card.run.state === 'planning'); return <button key={step} role="tab" aria-selected={mode === step} className={`tab ${mode === step ? 'on' : ''}`} onClick={() => step !== mode && onSwitch(step)}>{singleChat ? t.chat.roles.assistant : t.chat.steps[step]}{working ? <span className="spin sm" /> : null}</button> })}</div></div>
          <h2>{card.title || t.chat.tile.newCard}</h2><div className="ctxline"><span className="ctxchip">{columnLabel}</span>{card.id && <ComplexityBadge complexity={card.complexity} pendingDecisions={card.pending.decisions} onClick={() => setAssessing(true)} />}{assessing && createPortal(<AssessmentDialog card={card} close={() => setAssessing(false)} changed={() => undefined} />, document.body)}{card.workspace && <span className="ctxchip ws tip" data-tip={c.worktreeTip(card.workspace.path)}><TreeIcon /><span className="wsname">{card.workspace.branch} · {worktreeName(card.workspace.path)}</span></span>}</div></div>
        <div className="dock-tools"><div className="dock-tools-wide">{card.id && !planning && <div className="viewtoggle sm" role="group" aria-label={c.chatOrGit}><button type="button" className={gitView ? '' : 'on'} aria-pressed={!gitView} onClick={() => setView('chat')}>{c.chatTab}</button><button type="button" className={gitView ? 'on' : ''} aria-pressed={gitView} onClick={() => setView('git')}><BranchIcon />Git{card.pending.commits > 0 && <i className="pendot" />}</button></div>}<ChatSearch messages={messages} log={log} request={chatSearch.request} reveal={gitView ? () => setView('chat') : undefined} />{card.id && <button type="button" className="ibtn tip" data-tip={t.chat.contextMenu.openCard} aria-label={t.chat.contextMenu.openCard} onClick={() => openEdit(card)}><CardIcon />{(card.pending.decisions ?? 0) > 0 && <i className="pendot corner" />}</button>}{card.id && <PopMenu target={{ kind: 'chat', projectId: project.id, cardId: card.id, purpose: mode }} />}<button type="button" className="ibtn tip" data-tip={expanded ? d.backToCorner : d.expandFull} aria-label={expanded ? d.backToCorner : d.expandFull} onClick={() => setExpanded(!expanded)}>{expanded ? <CollapseIcon /> : <ExpandIcon />}</button><button className="x" aria-label={d.closeChat} onClick={close}><CloseIcon /></button></div><div className="dock-tools-compact"><ChatMoreMenu openCard={card.id ? () => openEdit(card) : undefined} searchRequest={chatSearch.request} messages={messages} log={log} projectId={project.id} cardId={card.id || undefined} purpose={mode} expand={() => setExpanded(true)} close={close} view={card.id && !planning ? { git: gitView, set: setView } : undefined} /><button className="x" aria-label={d.closeChat} onClick={close}><CloseIcon /></button></div></div></div></div>
      {gitView && <GitCardPanel cardId={card.id} profiles={profiles} openRules={() => openRules?.()} openGraph={(id) => openGraph?.(id)} diff={diff} setDiff={setDiff} />}
      <div className="chatlog" ref={log} style={gitView ? { display: 'none' } : undefined}>
        {!messages.length && !live && (planning ? <PlanHero projectName={project.name} text={specKit.state?.active ? c.emptySpecKit : c.emptyPlanning} /> : <div className="msg sys">{testing ? c.emptyTest : c.emptyExecution}</div>)}
        <ChatMessageList messages={messages} busy={busy} />
        <AgentPermissions chatId={chat?.id} />
        {live && <div className="msg agent"><div className="md chatmd"><AgentMessage source={typed} live /><span className="caret" /></div></div>}
        {mode === 'execution' && card.id && <CommitAsks cardId={card.id} branch={card.workspace?.branch} profiles={profiles} openGit={() => setView('git')} />}
        {card.id && <SpecKitAsks card={card} spec={specKit.state} reload={specKit.reload} mode={mode} profiles={usable} onStarted={() => undefined} runNext={answerQuestions} onSwitch={onSwitch} busy={busy} dockHost={dockHost} />}
        {card.id && <ApprovalAsks cardId={card.id} />}
        {busy && <ThinkingIndicator purpose={mode} messages={messages} since={busySince} />}
      </div>
      <ChatReplySelection log={log} scope={`${project.id}:${card.id}:${mode}:${chat?.id ?? ''}:${view}`} add={(reply) => { replies.add(reply); mention.ref.current?.focus() }} />
      <div className="composer" ref={wrap} style={gitView ? { display: 'none' } : undefined}>
        {inactive && <div className="convbox"><p>{c.inactiveBefore}<b>{inactive.label.replace(' (desativado)', '')}</b>{c.inactiveAfter}</p><div className="actions" style={{ margin: 0 }}><button type="button" className="secondary" onClick={() => void resetInactive()}>{c.restartChat}</button></div></div>}
        {(error || dictation.error) && <p className="error">{error || dictation.error}</p>}
        {voiceSetup && !voiceReady && dictation.status?.cloud && <div className="convbox"><p>{c.voiceGroq}</p><div className="actions" style={{ margin: 0 }}><button type="button" className="secondary" onClick={() => setVoiceSetup(false)}>{t.common.close}</button></div></div>}
        {voiceSetup && !voiceReady && dictation.status && !dictation.status.cloud && <div className="convbox"><p>{c.voiceLocal(dictation.status.engineInstalled ? 'none' : dictation.status.canInstallEngine ? 'engine' : 'enginePath', dictation.status.sizeMb)}</p><div className="actions" style={{ margin: 0 }}><button type="button" className="secondary" onClick={() => setVoiceSetup(false)}>{d.notNow}</button><button type="button" disabled={Boolean(dictation.progress) || (!dictation.status.engineInstalled && !dictation.status.canInstallEngine)} onClick={() => void dictation.install().then(() => setVoiceSetup(false))}>{dictation.progress || d.download}</button></div></div>}
        {later.queued && <QueuedPreview text={later.queued} files={later.files} busy={busy} sendNow={() => later.sendNow(cancel)} edit={() => { const item = later.take(), text = replies.restore(item.text); setInput((value) => `${text}${value ? `\n${value}` : ''}`); attach.add(item.files) }} discard={later.discard} />}
        <div className="skdock-host" ref={setDockHost} />
        <div className={`cbox ${attach.dragging ? 'dropping' : ''}`} {...attach.dropProps}>
          {((!inactive && testShortcuts.length > 0) || attach.files.length > 0 || replies.items.length > 0) && <div className="cbox-top">
            {!inactive && testShortcuts.length > 0 && <div className="testbar" role="group" aria-label={c.testShortcuts}>{testShortcuts.map((item) => <button type="button" key={item.label} className="mini secondary" onClick={item.run}>{item.label}</button>)}</div>}
            <AttachmentChips files={attach.files} remove={attach.remove} />
            <ReplyContextCards replies={replies.items} remove={replies.remove} />
          </div>}
          <AttachButton onClick={() => void attach.choose()} />
          {mention.menu}{slashSkill.menu}<div className="hlwrap"><InputMirror text={input} skillNames={skillNames} area={mention.ref} /><textarea rows={1} aria-label={d.messageToAgent} spellCheck={false} value={input} placeholder={dictation.recording ? d.listening : planning ? c.placeholderPlanning : testing ? c.placeholderTest : c.placeholderExecution} ref={mention.ref} onSelect={(e) => { mention.caret(e.currentTarget.selectionStart); slashSkill.caret(e.currentTarget.selectionStart) }} onChange={(e) => { setInput(e.target.value); mention.caret(e.target.selectionStart); slashSkill.caret(e.target.selectionStart); slashSkill.reset() }} onKeyDown={(e) => { if (mention.keyDown(e) || slashSkill.keyDown(e)) return; const dropped = dropToken(e, input, skillNames); if (dropped) { e.preventDefault(); setInput(dropped.text); slashSkill.caret(dropped.at); mention.caret(dropped.at); if (dropped.token.kind === 'skill' && skill?.name === dropped.token.word.slice(1)) void chooseSkill(null); window.requestAnimationFrame(() => mention.ref.current?.setSelectionRange(dropped.at, dropped.at)); return }; if (listKeyDown(e, applyEdit)) return; if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} /></div>
          {dictation.recording && <span className="wave"><i /><i /><i /><i /><i /><i /><i /></span>}
          {busy && <button type="button" className="sendbtn stop tip" data-tip={d.stop} aria-label={d.stop} onClick={() => void stop()}><StopIcon /></button>}<button type="button" className="sendbtn tip" data-tip={busy ? d.queueTip : d.sendTip} aria-label={busy ? d.queue : d.send} hidden={!input.trim() && !replies.items.length && !attach.files.length} onClick={() => void send()}><SendIcon /></button>
          <button type="button" className={`micbtn tip ${dictation.recording ? 'on' : ''}`} data-tip={dictation.recording ? d.stopListening : dictation.transcribing ? d.transcribing : d.dictate} aria-label={d.dictate} aria-pressed={dictation.recording} disabled={dictation.transcribing || !dictation.status} onClick={() => (voiceReady ? void dictation.toggle() : setVoiceSetup(true))}>{dictation.transcribing ? <span className="spin sm" /> : <MicIcon />}</button>
        </div>
        <div className="cmeta">
          {planning ? <><SpecKitModeChip cardId={card.id} spec={specKit.state} reload={specKit.reload} />
            <span className="modewrap" style={{ display: "none" }}><button type="button" className={`skillchip ${menu === 'skill' ? 'on' : ''}`} aria-haspopup="menu" aria-expanded={menu === 'skill'} data-tip={c.planningSkill} onClick={() => { setSkillFilter(''); setMenu(menu === 'skill' ? null : 'skill') }}>{skill?.name ?? c.sddPlanning}</button>
              {menu === 'skill' && <div className="modemenu skillmenu" role="menu"><div className="mm-title">{c.planningSkill}</div>
                <input ref={skillFilterInput} className="in" type="search" value={skillFilter} placeholder={c.filterSkills} aria-label={c.filterSkillsLabel} onChange={(event) => setSkillFilter(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setMenu(null) }} />
                {!skillFilter.trim() && <button type="button" role="menuitem" className="modeopt" onClick={() => void chooseSkill(null)}><span className="mo-t"><b>{c.sddPlanning}</b><em>{c.default}</em><small>{c.system}</small></span><span className="mo-r">{!skill && <CheckIcon />}</span></button>}
                {available.filter((item) => `${item.name} ${item.description}`.toLocaleLowerCase().includes(skillFilter.trim().toLocaleLowerCase())).map((item) => { const path = provider ? item.paths[provider]! : ''; return <button type="button" role="menuitem" key={item.id} className="modeopt" onClick={() => void chooseSkill({ name: item.name, path })}><span className="mo-t"><b>{item.name}</b><small>{item.scope === 'project' ? c.fromProject : c.global}</small></span><span className="mo-r">{skill?.path === path && <CheckIcon />}</span></button> })}</div>}</span></>
            : <span className="modewrap"><button type="button" className={`modechip ${menu === 'mode' ? 'on' : ''}`} aria-haspopup="menu" aria-expanded={menu === 'mode'} onClick={() => setMenu(menu === 'mode' ? null : 'mode')}>{currentMode ? modeText(currentMode).label : d.mode}</button>
              {menu === 'mode' && <div className="modemenu" role="menu"><div className="mm-title">{d.mode}</div>{execModes.map((item, index) => <button type="button" role="menuitem" key={item.id} disabled={item.needsApprovalUi} data-tip={item.needsApprovalUi ? d.needsApproval : undefined} className="modeopt" onClick={() => { setMenu(null); void changeMode(item.id) }}><span className="mo-t"><b>{modeText(item).label}</b>{item.recommended && <em>{d.recommended}</em>}<small>{modeText(item).description}</small></span><span className="mo-r">{agentState.config?.mode === item.id ? <CheckIcon /> : index + 1}</span></button>)}</div>}</span>}
          <div className="pick"><AgentBackground chatId={chat?.id} /><UsageRings profileId={agentState.config?.profileId ?? chat?.profileId} /><ModelMenu profiles={usable} purpose={mode} state={agentState} lockProfile={Boolean(chat)} onLockedPick={setSwitchTo} /></div>
        </div>
      </div>
    </div>
    </QuestionAnswerContext.Provider></FileOpenContext.Provider>
    {testChoice && <ConfirmDialog eyebrow={c.testChoiceEyebrow} title={c.testChoiceTitle} text={c.testChoiceText} ok={c.watchBrowser} secondary={{ label: c.runBackground, run: () => { setTestChoice(false); answerQuestions(retestPrompt(false)) } }} cancel={() => setTestChoice(false)} confirm={() => { setTestChoice(false); answerQuestions(retestPrompt(true)) }} />}
    {switchTo && <ConfirmDialog eyebrow={d.switchAgent} title={c.restartWith(switchTo.label)} text={c.restartText} ok={c.switchAndRestart} danger cancel={() => setSwitchTo(undefined)} confirm={() => void resetAndSwitch(switchTo)} />}
    {/* Only with the chat fullscreen: left column with progress (Tasks or test checklist) and the Changes. Splitting the screen with the board, it does not appear. */}
    {expanded && diffOpen && diff && <DiffPane cardId={card.id} target={diff} close={() => setDiff(undefined)} ask={sendReview} />}
    {expanded && !diffOpen && planning && card.id && <DecisionsSide cardId={card.id} projectId={project.id} />}
    {expanded && !diffOpen && !planning && card.id && <div className="dockside"><ProgressCard key={`${card.id}-${mode}-${columnState}`} cardId={card.id} purpose={mode === 'test' || (fullAgent && columnState === 'test') ? 'test' : 'execution'} />{(card.workspace || fullAgent) && <ChangesCard key={card.id} cardId={card.id} projectId={project.id} busy={busy} shared={card.workspace?.sharedFrom ?? null} />}</div>}
    {expanded && !diffOpen && !quickHidden && <Activity board={board} cardId={card.id} profiles={profiles} openEdit={openEdit} openChat={openChat} hide={() => setQuickHidden(true)} />}
    {expanded && !diffOpen && quickHidden && <button type="button" className="qv-show tip" data-tip={act.show} aria-label={act.show} onClick={() => setQuickHidden(false)}><ChevronLeftIcon />{act.quickView}</button>}
  </section>
}
