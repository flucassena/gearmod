import { providerLabels } from '@gearmod/contracts'
import type { StartChoice } from './NewCardDialog'
import React, { useEffect, useState } from 'react'
import type { Extension } from '@codemirror/state'
import { placeholder } from '@codemirror/view'
import { CodeEditor } from './editor/CodeEditor'
import { cardDocumentKinds, permissionModes, defaultPermissionMode, type AgentProfile, type CardChecklist, type AgentPurpose, type Card, type Chat, type CardDocumentKind, type CardDocuments, type CardTypeDef, type DocumentVersion, type GitCard, type ProjectSource } from '@gearmod/contracts'
import { AgentIcon } from './AgentIcon'
import { ConfirmDialog } from './ConfirmDialog'
import { DeleteCardDialog } from './DeleteCardDialog'
import { WorktreeDeleteDialog } from './WorktreeDelete'
import { ArtifactIcon, BranchIcon, ChatIcon, Chevron, CollapseIcon, ExpandIcon, EyeIcon, FolderGlyph, HistoryIcon, PencilIcon, SplitIcon, TrashIcon, TreeIcon } from './icons'
import { Markdown } from './markdown'
import { TokenUsage } from './TokenUsage'
import { TestChecklist } from './TestChecklist'
import { checklistEvent } from './checklistToggle'
import { ModelMenu, effortLabel, useAgentConfig, permissionModeText } from './ModelMenu'
import { AssessmentDialog, ComplexityBadge } from './Assessment'
import { RepoChooser } from './Delivery'
import { DocHistory } from './DocHistory'
import { Select } from './Select'
import { cardTypeOptions } from './CardTypes'
import { useEscape } from './useEscape'
import { plainError } from './NoticeDialog'
import { Switch } from './Switch'
import { getLocale, tr, useT } from './i18n'
import { toast } from './toasts'

/** `workflow`: the card's already chosen flow (read-only here; comes from the board so it does not wait for the query). */
export interface Draft { /** Where the work runs, chosen on the new-card dialog (only used when the card is created). */ start?: StartChoice; id?: string; columnId: string; sourceId?: string | null; title: string; type: Card['type']; priority: Card['priority']; workflow?: Card['workflow'] }
/** A new card starts with the first type in the project's list. */
export const blankDraft = (columnId: string, type: string): Draft => ({ columnId, title: '', type, priority: 'medium' })

/** Options for the documents' running-text editor: line wrapping, Tab follows focus (like the previous text field). */
const proseOptions = { wrap: true, tabSize: 2, indentWithTab: false, whitespace: false, guides: false, scrollPastEnd: false }
const placeholderCache = new Map<string, Extension[]>()
const placeholderFor = (kind: string): Extension[] => { const key = `${getLocale()}:${kind}`; let found = placeholderCache.get(key); if (!found) { found = [placeholder((tr().board.docPlaceholders as Record<string, string>)[kind] ?? '')]; placeholderCache.set(key, found) } return found }
const systemKinds: readonly CardDocumentKind[] = ['duvidas', 'mudancas']
const priorities = [{ value: 'low', color: 'var(--tone-neutral)' }, { value: 'medium', color: 'var(--tone-info)' }, { value: 'high', color: 'var(--tone-warning)' }, { value: 'urgent', color: 'var(--tone-danger)' }] as const
type Mode = 'write' | 'split' | 'prev'
type Texts = Record<CardDocumentKind, string>
const empty: Texts = { resumo: '', especificacao: '', plano: '', tasks: '', duvidas: '', mudancas: '' }
const toTexts = (docs: CardDocuments): Texts => ({ resumo: docs.resumo.contentMd, especificacao: docs.especificacao.contentMd, plano: docs.plano.contentMd, tasks: docs.tasks.contentMd, duvidas: docs.duvidas.contentMd, mudancas: docs.mudancas.contentMd })
const topLevel = (markdown: string): { done: number; total: number } => { const items = markdown.split('\n').filter((line) => /^[-*+]\s+\[( |x|X)\]/.test(line)); return { total: items.length, done: items.filter((line) => !/\[ \]/.test(line)).length } }

/** Card editor (prototype): data and agents on the left, Markdown document in the middle and the list of the 4 documents on the right. */
export function CardEditor({ projectId, sources, profiles, cardTypes, draft: start, close, saved, openChat, onStart, pending, onPending }: { projectId: string; sources: ProjectSource[]; profiles: AgentProfile[]; cardTypes: CardTypeDef[]; pending?: { changes: number; questions: number; toSend?: number }; onPending?(): void; draft: Draft; close(): void; saved(): void; openChat?(purpose?: AgentPurpose): void; onStart?(purpose: 'execution' | 'test'): void }): React.JSX.Element {
  const { board: tb, common, git: tg } = useT(), t = tb.editor, labels = tb.docKinds, tw = tg.worktreeDelete
  const priorityOptions = priorities.map((item) => ({ ...item, label: tb.priority[item.value] }))
  const [workspace, setWorkspace] = useState<Card['workspace']>(null), [complexity, setComplexity] = useState<Card>(), [assessing, setAssessing] = useState(false), [assessTab, setAssessTab] = useState<'avaliacao' | 'metricas'>('avaliacao')
  useEffect(() => { if (start.id) void window.gearmod.invoke('cards:get', { cardId: start.id }).then((card) => { setWorkspace(card.workspace); setComplexity(card) }).catch(() => undefined) }, [start.id])
  const [d, set] = useState(start), [chosenKind, setKind] = useState<CardDocumentKind>('resumo'), [mode, setMode] = useState<Mode>(start.id ? 'prev' : 'write'), [texts, setTexts] = useState<Texts>(empty), [original, setOriginal] = useState<Texts>(empty)
  // The short flow only has the Summary, which here is "What to do"; the other documents do not exist in it.
  const small = (complexity ? complexity.workflow : start.workflow) === 'light', kind: CardDocumentKind = small ? 'resumo' : chosenKind
  // Empty documents stay hidden and appear when someone writes; the Summary and the currently open one always appear. "+ Document" opens an empty one to write by hand.
  const [addingDoc, setAddingDoc] = useState(false)
  const waiting = (k: CardDocumentKind): number => k === 'mudancas' ? (pending?.changes ?? 0) + (pending?.toSend ?? 0) : k === 'duvidas' ? pending?.questions ?? 0 : 0
  const shownKinds = cardDocumentKinds.filter((k) => k === 'resumo' || k === kind || waiting(k) > 0 || texts[k].trim() || original[k].trim())
  const hiddenKinds = cardDocumentKinds.filter((k) => !shownKinds.includes(k) && !systemKinds.includes(k))
  const [testsView, setTestsView] = useState(false), [checklistData, setChecklistData] = useState<CardChecklist>()
  const checklist = checklistData?.contentMd ?? ''
  useEffect(() => {
    const cardId = start.id
    if (!cardId) return
    const load = (): void => { void window.gearmod.invoke('cards:checklist', { cardId }).then(setChecklistData).catch(() => undefined) }
    load()
    const received = (event: Event): void => { const next = (event as CustomEvent<CardChecklist>).detail; if (next.cardId === cardId) setChecklistData(next) }
    window.addEventListener(checklistEvent, received)
    const off = window.gearmod.onRunEvent((event) => { if (event.eventType === 'gearmod/card-updated' && event.payload.cardId === cardId) load() })
    return () => { window.removeEventListener(checklistEvent, received); off() }
  }, [start.id])
  const testItems = (checklist.match(/^\s*[-*] \[[ xX]\]/gm) ?? []).length, testDone = (checklist.match(/^\s*[-*] \[[xX]\]/gm) ?? []).length
  const [versions, setVersions] = useState<DocumentVersion[]>(), [error, setError] = useState(''), [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(!start.id)
  const [chats, setChats] = useState<Chat[]>([]), [resetting, setResetting] = useState<AgentPurpose>(), [deleting, setDeleting] = useState<AgentPurpose>()
  const loadChats = (): void => { if (start.id) void window.gearmod.invoke('chats:list', { projectId, cardId: start.id }).then(setChats).catch(() => undefined) }
  useEffect(loadChats, [start.id, projectId])
  const chatOf = (purpose: AgentPurpose): Chat | undefined => chats.find((item) => item.purpose === purpose)
  const planAgent = useAgentConfig(start.id ?? '', 'planning', profiles, chatOf('planning')?.profileId), execAgent = useAgentConfig(start.id ?? '', 'execution', profiles, chatOf('execution')?.profileId), testAgent = useAgentConfig(start.id ?? '', 'test', profiles, chatOf('test')?.profileId)
  const gitSources = sources.filter((source) => source.isGitRepository)
  useEffect(() => { if (start.id) void window.gearmod.invoke('cards:documents', { cardId: start.id }).then((docs) => { setTexts(toTexts(docs)); setOriginal(toTexts(docs)); setLoaded(true) }).catch((reason: unknown) => setError(plainError(reason))) }, [start.id])
  useEffect(() => { setVersions(undefined) }, [kind])
  useEscape(close, !confirming)
  const dirty = (k: CardDocumentKind): boolean => texts[k] !== original[k]
  const [auto, setAuto] = useState(() => { try { return localStorage.getItem('gearmod.cardAutosave') === '1' } catch { return false } })
  const [autoState, setAutoState] = useState<'' | 'saving' | 'saved'>('')
  const setAutoSave = (value: boolean): void => { setAuto(value); try { localStorage.setItem('gearmod.cardAutosave', value ? '1' : '0') } catch { /* no storage: only valid for this opening */ } }
  // Auto-save: only on a card that already exists; waits 1.2 s without typing and saves without closing the editor.
  useEffect(() => {
    if (!auto || !d.id || !loaded || !d.title.trim()) return
    const changed = cardDocumentKinds.some((k) => !systemKinds.includes(k) && texts[k] !== original[k]) || d.title !== start.title || d.type !== start.type || d.priority !== start.priority || d.sourceId !== start.sourceId
    if (!changed) return
    const timer = setTimeout(() => {
      setAutoState('saving')
      void (async () => {
        try {
          const base = { sourceId: d.sourceId ?? gitSources[0]?.id ?? null, title: d.title, type: d.type, priority: d.priority, description: texts.resumo, acceptanceCriteria: [] }
          await window.gearmod.invoke('cards:update', { cardId: d.id!, ...base })
          for (const k of cardDocumentKinds) if (k !== 'resumo' && !systemKinds.includes(k) && texts[k] !== original[k]) await window.gearmod.invoke('cards:write-document', { cardId: d.id!, kind: k, contentMd: texts[k] })
          setOriginal(texts); setAutoState('saved'); setError('')
        } catch (reason) { setAutoState(''); setError(plainError(reason)) }
      })()
    }, 1200)
    return () => clearTimeout(timer)
  }, [auto, d, texts, loaded])
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault(); if (!d.title.trim()) { setError(t.enterTitle); return }
    setBusy(true); setError('')
    try {
      const sourceId = d.sourceId ?? gitSources[0]?.id ?? null
      const base = { sourceId, title: d.title, type: d.type, priority: d.priority, description: texts.resumo, acceptanceCriteria: [] }
      const card = d.id ? await window.gearmod.invoke('cards:update', { cardId: d.id, ...base }) : await window.gearmod.invoke('cards:create', { projectId, columnId: d.columnId, ...base, ...d.start })
      for (const k of cardDocumentKinds) if (k !== 'resumo' && !systemKinds.includes(k) && dirty(k)) await window.gearmod.invoke('cards:write-document', { cardId: card.id, kind: k, contentMd: texts[k] })
      if (!d.id) for (const [purpose, state] of [['planning', planAgent], ['execution', execAgent], ['test', testAgent]] as const) if (state.touched && state.config) await window.gearmod.invoke('cards:set-agent-config', { cardId: card.id, purpose, config: state.config })
      saved()
    } catch (reason) { setError(plainError(reason)) } finally { setBusy(false) }
  }
  const toggle = (line: number, checked: boolean): void => {
    const lines = texts[kind].split('\n'); const current = lines[line]; if (current === undefined) return
    lines[line] = current.replace(/\[( |x|X)\]/, checked ? '[x]' : '[ ]'); setTexts({ ...texts, [kind]: lines.join('\n') })
  }
  const showVersions = async (): Promise<void> => { if (d.id) setVersions(await window.gearmod.invoke('cards:document-versions', { cardId: d.id, kind })) }
  const agentOptions = () => profiles.map((item) => ({ value: item.id, label: item.label, icon: <AgentIcon profile={item} tip={false} />, sub: providerLabels[item.provider] }))
  const stepTitle: Record<AgentPurpose, string> = t.stepTitle
  const agentField = (purpose: AgentPurpose, state: typeof planAgent): React.JSX.Element => {
    const profile = profiles.find((item) => item.id === state.config?.profileId)
    const modes = profile ? permissionModes[profile.provider].filter((item) => item.purposes.includes('execution')).map((item) => ({ ...item, ...permissionModeText(profile.provider, item) })) : []
    const chat = chatOf(purpose)
    return <div className="agentfield">
      <Select label={t.agentOf[purpose]} up={purpose !== 'planning'} disabled={Boolean(chat)} options={agentOptions()} value={state.config?.profileId ?? ''} onChange={(value) => { const next = profiles.find((item) => item.id === value); if (next) void state.update({ profileId: next.id, model: null, effort: null, mode: defaultPermissionMode(next.provider, purpose) }) }} />
      {chat && <div className="lockrow"><small>{t.chatStartedLocked}</small><button type="button" className="mini secondary" onClick={() => setResetting(purpose)}>{t.switchAgent}</button></div>}
      <ModelMenu profiles={profiles} purpose={purpose} state={state} noAgent field />
      {purpose !== 'planning' && profile && <div className="f"><span>{purpose === 'test' ? t.testMode : t.executionMode}</span><Select label={t.mode} up options={modes.map((item) => ({ value: item.id, label: item.label, sub: item.recommended ? tb.start.recommended : item.needsApprovalUi ? t.comingSoon : '', disabled: item.needsApprovalUi }))} value={state.config?.mode ?? ''} onChange={(value) => void state.update({ mode: value as never })} /></div>}
      {chat && <button type="button" className="mini danger delchat" onClick={() => setDeleting(purpose)}>{t.deleteChat}</button>}
    </div>
  }
  const [wsOpen, setWsOpen] = useState(false), [wsDeleteRepo, setWsDeleteRepo] = useState<string>(), [wide, setWide] = useState(false), [wsRepos, setWsRepos] = useState<GitCard['repos']>(), [openRepos, setOpenRepos] = useState<string[]>([]), [wsDelete, setWsDelete] = useState(false)
  const [openSec, setOpenSec] =useState<Partial<Record<AgentPurpose, boolean>>>({})
  const startLabel: Record<'execution' | 'test', string> = { execution: tb.start.startExecution, test: tb.start.startTest }
  // Planning always appears; execution and test only after they start (before that it is a button that picks the agent and starts right away).
  const section = (purpose: AgentPurpose, state: typeof planAgent, title?: string): React.JSX.Element | null => {
    const chat = chatOf(purpose), label = title ?? stepTitle[purpose], profile = profiles.find((item) => item.id === state.config?.profileId)
    const chatButton = d.id && openChat && <button type="button" className="ibtn tip" data-tip={chat ? t.openStepChat : t.openChatNoConversation} aria-label={t.openChatOf(label)} onClick={() => openChat(purpose)}><ChatIcon /></button>
    if (purpose !== 'planning' && !chat) {
      if (!d.id || !onStart) return null
      return <div className="sep"><div className="sechead"><span className="sectitle">{label}</span></div><button type="button" className="mini startsec" onClick={() => onStart(purpose as 'execution' | 'test')}>{startLabel[purpose as 'execution' | 'test']}</button></div>
    }
    const expanded = openSec[purpose] ?? !d.id
    const model = state.options?.models.find((item) => item.id === state.config?.model)
    const preview = [profile?.label, model?.label ?? state.config?.model ?? t.defaultModel, state.config?.effort ? effortLabel[state.config.effort] : ''].filter(Boolean).join(' · ')
    return <div className={`sep secfold ${expanded ? 'open' : ''}`}><div className="sechead"><button type="button" className="foldbtn" aria-expanded={expanded} onClick={() => setOpenSec({ ...openSec, [purpose]: !expanded })}><Chevron open={expanded} /><span className="sectitle">{label}</span></button>{chatButton}</div>{!expanded && <button type="button" className="foldprev" onClick={() => setOpenSec({ ...openSec, [purpose]: true })}>{profile && <AgentIcon profile={profile} size="sm" tip={false} />}<span>{preview}</span></button>}{expanded && agentField(purpose, state)}</div>
  }
  // Worktree per repository: only fetches when the block is expanded (each repository's state costs a Git query).
  useEffect(() => { if (wsOpen && d.id) void window.gearmod.invoke('git:card', { cardId: d.id }).then((git) => setWsRepos(git.repos)).catch(() => setWsRepos([])) }, [wsOpen, d.id])
  const text = texts[kind]
  return <div className="overlay full card-editor-overlay"><div className="modal wide" role="dialog" aria-label={d.id ? t.editCard : tb.newCard}>
    <header><div><h2><input className={`titlein ${!d.title.trim() ? 'invalid' : ''}`} aria-label={t.title} aria-invalid={!d.title.trim()} autoFocus={!start.id} value={d.title} placeholder={tb.untitled} onChange={(e) => set({ ...d, title: e.target.value })} />{!d.title.trim() && <small className="titlein-err" role="alert">{t.enterTitle}</small>}</h2>{assessing && complexity && <AssessmentDialog initialTab={assessTab} card={complexity} close={() => setAssessing(false)} changed={() => { void window.gearmod.invoke('cards:get', { cardId: complexity.id }).then(setComplexity).catch(() => undefined) }} />}</div><div className="hdr-actions">{d.id && pending && (pending.changes > 0 || pending.questions > 0) && <button type="button" className="mini ask" onClick={onPending}>{t.authorizeChanges(pending.changes + pending.questions)}</button>}{d.id && <button type="button" className="mini secondary openchat" onClick={() => { window.dispatchEvent(new CustomEvent('gearmod:open-file', { detail: { projectId, cardId: d.id } })); close() }}><FolderGlyph />{tb.tile.openCardFiles}</button>}{d.id && openChat && <button type="button" className="mini secondary openchat" onClick={() => openChat()}><ChatIcon />{tb.tile.openChat}</button>}<button type="button" className="x" onClick={close} aria-label={common.close}>×</button></div></header>
    <form onSubmit={(e) => void submit(e)} style={{ display: 'contents' }}>
      <div className={`editor docs ${small ? 'smallcard' : ''} ${wide ? 'wide' : ''}`}>
        <div className="pane-left"><div className="stack pane-left-top">
          {complexity && <div className="cxtop">{complexity.complexity ? <ComplexityBadge full pendingDecisions={complexity.pending.decisions} complexity={complexity.complexity} workflowText={complexity.workflow ? (!complexity.workflow ? t.flow.none : complexity.workflow === 'sdd' ? t.flow[complexity.sddMethod ?? 'sdd'] : t.flow[complexity.workflow]) : undefined} onClick={() => { setAssessTab('avaliacao'); setAssessing(true) }} /> : d.id && <span className={`flowchip tip ${complexity.workflow ? '' : 'none'}`} data-tip={t.flow.tip}>{(!complexity.workflow ? t.flow.none : complexity.workflow === 'sdd' ? t.flow[complexity.sddMethod ?? 'sdd'] : t.flow[complexity.workflow])}</span>}{d.id && <button type="button" className="mini secondary tip cx-artifacts" data-tip={tb.assessment.openArtifacts} aria-label={tb.assessment.openArtifacts} onClick={() => { void window.gearmod.invoke('history:open-folder', { cardId: d.id! }).catch((reason) => setError(plainError(reason))) }}><ArtifactIcon /></button>}</div>}
        </div><div className="stack pane-left-scroll">
          <div className="f"><span>{t.type}</span><Select label={t.type} options={cardTypeOptions(cardTypes, d.type)} value={d.type} onChange={(value) => set({ ...d, type: value })} /></div>
          <div className="f"><span>{t.priority}</span><Select label={t.priority} options={priorityOptions} value={d.priority} onChange={(value) => set({ ...d, priority: value as Card['priority'] })} /></div>
          {d.id && complexity && gitSources.length > 1 && !workspace && <RepoChooser card={complexity} sources={gitSources} changed={setComplexity} />}
          {!d.id && gitSources.length > 1 && <div className="f"><span>{t.repository}</span><Select label={t.repository} options={gitSources.map((source) => ({ value: source.id, label: source.name, sub: source.currentBranch ?? '' }))} value={d.sourceId ?? gitSources[0]!.id} onChange={(value) => set({ ...d, sourceId: value })} /></div>}
          {small && <p className="smallnote"><b>{t.smallTaskTitle}</b> {t.smallTaskNote}</p>}
          {profiles.length > 0 && (small && chatOf('planning') && !chatOf('execution')
            // Small task the planner itself already handled: it is a single agent (plans, executes and validates) and a single chat, so it appears as "Agent".
            ? section('planning', planAgent, common.agent)
            : <>{!small && section('planning', planAgent)}{section('execution', execAgent)}{!small && section('test', testAgent)}</>)}
          {d.id && workspace && <div className="f"><span>{t.branchAndWorktree}</span><div className="wsbox"><button type="button" className="wsfold" aria-expanded={wsOpen} onClick={() => setWsOpen(!wsOpen)}><BranchIcon /><b>{workspace.branch}</b><Chevron open={wsOpen} /></button><div className="wsmeta"><small className="wsbase" data-tip={t.base(workspace.baseRef)}>{t.base(workspace.baseRef)}</small></div>{wsOpen && (wsRepos?.length ? <ul className="wsrepos">{wsRepos.map((repo) => { const shown = openRepos.includes(repo.sourceId), touched = repo.ahead > 0 || repo.files.length > 0
    return <li key={repo.sourceId} className={`wstree ${touched ? 'touched' : ''}`}>
      <button type="button" className="wstree-head" aria-expanded={shown} onClick={() => setOpenRepos(shown ? openRepos.filter((id) => id !== repo.sourceId) : [...openRepos, repo.sourceId])}>
        <TreeIcon /><b>{repo.name}</b>
        {repo.state !== 'active' && <small className="cx-warn">{repo.state === 'failed' ? tb.delivery.repoState.failed : tb.delivery.repoState.missing}</small>}
        {touched && <small className="wstree-n" data-tip={t.cardTouchedRepo}>{repo.ahead > 0 ? tb.delivery.commitCount(repo.ahead) : ''}{repo.ahead > 0 && repo.files.length > 0 ? ' · ' : ''}{repo.files.length > 0 ? tb.delivery.uncommitted(repo.files.length) : ''}</small>}
        <span className="chev" aria-hidden="true">›</span></button>
      {shown && <div className="wstree-body"><small className="wstree-path" data-tip={repo.worktreePath}>{repo.worktreePath}</small><small className="wsbase">{t.base(repo.baseRef)}</small><button type="button" className="wsdel" onClick={() => setWsDeleteRepo(repo.sourceId)}><TrashIcon />{tw.deleteOne}</button></div>}
    </li> })}</ul> : <small data-tip={workspace.path}>Worktree: {workspace.path}</small>)}{wsOpen && <button type="button" className="wsdel all" onClick={() => setWsDelete(true)}><TrashIcon />{tw.deleteButton}</button>}</div>{wsDelete && <WorktreeDeleteDialog cardId={d.id!} close={() => setWsDelete(false)} done={() => { setWsDelete(false); setWsRepos(undefined); window.dispatchEvent(new Event('gearmod:board-changed')) }} />}{wsDeleteRepo && <WorktreeDeleteDialog cardId={d.id!} sourceId={wsDeleteRepo} close={() => setWsDeleteRepo(undefined)} done={() => { setWsDeleteRepo(undefined); setWsRepos(undefined); window.dispatchEvent(new Event('gearmod:board-changed')) }} />}</div>}
          {gitSources.length === 0 && <p className="hint">{t.noGit}</p>}
        </div></div>
        <div className="stack pane-mid" style={{ minWidth: 0 }}>
          {testsView && checklist.trim() ? <><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span className="sectitle">{t.testsByTester}</span></div><div className="md descarea">{checklistData && <TestChecklist data={checklistData} />}</div></> : <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span className="sectitle">{small ? t.whatToDo : labels[kind]} · {systemKinds.includes(kind) ? t.generatedBySystem : 'Markdown'}</span>
            <div className="tabs">{d.id && !systemKinds.includes(kind) && <button type="button" className={`ibtn tip ${versions ? 'on' : ''}`} data-tip={versions ? t.closeHistory : t.versionHistory} aria-label={t.versionHistory} aria-pressed={Boolean(versions)} onClick={() => (versions ? setVersions(undefined) : void showVersions())}><HistoryIcon /></button>}
              <button type="button" className={`ibtn tip ${wide ? 'on' : ''}`} data-tip={wide ? t.showSideColumns : t.expandHidesColumns} aria-label={wide ? t.collapseDocument : t.expandDocument} aria-pressed={wide} onClick={() => setWide(!wide)}>{wide ? <CollapseIcon /> : <ExpandIcon />}</button>
              {([['write', t.modeWrite, <PencilIcon key="w" />], ['split', t.modeSplit, <SplitIcon key="s" />], ['prev', t.modePreview, <EyeIcon key="p" />]] as const).map(([value, label, icon]) => <button type="button" key={value} className={`ibtn tip ${mode === value ? 'on' : ''}`} data-tip={label} aria-label={label} aria-pressed={mode === value} onClick={() => setMode(value)}>{icon}</button>)}</div></div>
          {/* An existing card opens in Preview (easier to read); double-clicking the text switches to Write. */}
          {versions ? <DocHistory title={labels[kind]} versions={versions} restore={(v) => { setTexts({ ...texts, [kind]: v.contentMd }); setVersions(undefined) }} /> : mode === 'prev' ? <div className="md descarea" data-tip={systemKinds.includes(kind) ? undefined : t.doubleClickToEdit} onDoubleClick={() => { if (!systemKinds.includes(kind)) setMode('write') }}>{text.trim() ? <Markdown source={text} onToggle={kind === 'tasks' || kind === 'plano' ? toggle : undefined} /> : <p className="hint">{loaded ? t.emptyDocument(labels[kind], !systemKinds.includes(kind)) : common.loading}</p>}</div>
            : <div className={`descwrap ${mode === 'split' ? 'split' : ''}`}><CodeEditor key={kind} variant="prose" className="in descarea" path="documento.md" ariaLabel={t.documentAria(labels[kind])} value={text} readOnly={!loaded || systemKinds.includes(kind)} extensions={placeholderFor(kind)} options={proseOptions} onChange={(value) => setTexts((all) => ({ ...all, [kind]: value }))} />{mode === 'split' && <div className="md descarea"><Markdown source={text} onToggle={kind === 'tasks' || kind === 'plano' ? toggle : undefined} /></div>}</div>}
</>}
        </div>
        {!small && <div className="stack pane-docs">
          <span className="sectitle">{t.documents}</span>
          {shownKinds.map((k) => { const value = texts[k], tasks = k === 'tasks' ? topLevel(value) : null, status = tasks ? (tasks.total ? `${tasks.done}/${tasks.total}` : t.empty) : value.trim() ? t.written : t.empty
            const ask = waiting(k)
            return <button type="button" key={k} className={`docbtn ${kind === k && !testsView ? 'on' : ''} ${value.trim() || ask ? '' : 'empty'} ${ask ? 'ask' : ''}`} data-tip={ask ? t.awaitingAuthorization : undefined} onClick={() => { setTestsView(false); setKind(k); if (ask) onPending?.() }}><span className="dn">{labels[k]}{dirty(k) && <i className="dirtyDot" aria-label={t.changed} />}</span><span className="ds">{ask ? <><span className="dot pulse" />{k === 'mudancas' ? t.toAuthorize(ask) : t.toAnswer(ask)}</> : status}</span>{tasks && tasks.total > 0 && <span className="dprog"><i style={{ width: `${Math.round((tasks.done / tasks.total) * 100)}%` }} /></span>}</button> })}
          {checklist.trim() && <button type="button" className={`docbtn ${testsView ? 'on' : ''}`} onClick={() => setTestsView(true)}><span className="dn">{t.tests}</span><span className="ds">{testItems ? `${testDone}/${testItems}` : t.written}</span>{testItems > 0 && <span className="dprog"><i style={{ width: `${Math.round((testDone / testItems) * 100)}%` }} /></span>}</button>}
          {hiddenKinds.length > 0 && <div className="docadd">{addingDoc ? hiddenKinds.map((k) => <button type="button" key={k} className="mini secondary" onClick={() => { setAddingDoc(false); setKind(k); setMode('write') }}>{labels[k]}</button>)
            : <button type="button" className="mini secondary" onClick={() => setAddingDoc(true)}>{t.addDocument}</button>}</div>}
        </div>}
      </div>
      {error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}
      <div className="actions cefoot">{d.id && <button type="button" className="danger" onClick={() => setConfirming(true)}>{tb.contextMenu.deleteCard}</button>}{d.id && <div className="cefoot-tokens"><TokenUsage cardId={d.id} small={small} onOpenDetails={complexity ? () => { setAssessTab('metricas'); setAssessing(true) } : undefined} /></div>}<span className="grow1" />{d.id && <Switch className="tip" tip={t.autosaveTip} checked={auto} onChange={setAutoSave}>{t.autosave}{auto && autoState && <small>{autoState === 'saving' ? common.saving : t.saved}</small>}</Switch>}<button type="button" className="secondary" onClick={close}>{common.cancel}</button><span className={!d.title.trim() ? 'savetip' : undefined} data-tip={!d.title.trim() ? t.enterTitle : undefined}><button disabled={busy || !loaded || !d.title.trim()}>{busy ? common.saving : t.saveCard}</button></span></div>
    </form>
    {deleting && d.id && <ConfirmDialog eyebrow={t.deleteChat} title={t.deleteChatTitle(stepTitle[deleting].toLowerCase())} text={t.deleteChatText} ok={t.deleteChat} danger cancel={() => setDeleting(undefined)} confirm={() => { const chat = chatOf(deleting); setDeleting(undefined); if (chat) void window.gearmod.invoke('chats:reset', { chatId: chat.id }).then(() => loadChats()).catch((reason: unknown) => toast.error(tb.view.couldNotComplete, plainError(reason))) }} />}
    {resetting && d.id && <ConfirmDialog eyebrow={t.switchAgent} title={t.resetChatTitle} text={t.resetChatText} ok={t.resetChat} danger cancel={() => setResetting(undefined)} confirm={() => { const purpose = resetting, chat = chatOf(purpose); setResetting(undefined); if (chat) void window.gearmod.invoke('chats:reset', { chatId: chat.id }).then(() => loadChats()).catch((reason: unknown) => toast.error(tb.view.couldNotComplete, plainError(reason))) }} />}
    {confirming && d.id && <DeleteCardDialog title={d.title} cancel={() => setConfirming(false)} confirm={(deleteArtifacts) => void window.gearmod.invoke('cards:delete', { cardId: d.id!, deleteArtifacts }).then(saved).catch((reason: unknown) => { setConfirming(false); setError(plainError(reason)) })} />}
  </div></div>
}
