import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CardDocumentKind, ChatPurpose } from '@gearmod/contracts'
import { cardDocumentKinds, systemDocumentKinds } from '@gearmod/contracts'
import type { AgentContextService } from './agent-context'
import type { CollaborationService } from './collaboration'
import type { ConstitutionRepository } from './constitution'
import type { ChecklistRepository } from './checklists'
import type { ConversationRepository } from './conversations'
import type { BoardRepository } from './projects'
import type { GitManager } from './git-manager'
import type { CardHistoryService } from './history'
import type { ApprovalService } from './approvals'
import type { PolicyEngine } from './policy'
import type { SddResolver } from './sdd/sdd-resolver'
import type { SddWriter } from './sdd/sdd-writer'
import type { CodeIndexService } from './code-index/service'
import { findCardType } from '@gearmod/contracts'
import { assessmentTriggerSchema, complexityDimensions, decisionKindSchema, dimensionScoresSchema, evidenceSchema, levelLabels, workflowKindSchema, workflowLabels, type Evidence } from '@gearmod/contracts'

export interface McpEndpoint { command: string; args: string[]; env: Record<string, string> }
export type CardChange = { type: 'document'; kind: CardDocumentKind } | { type: 'task' } | { type: 'moved'; column: string } | { type: 'card' } | { type: 'converted'; cardId: string; chatId: string } | { type: 'constitution' } | { type: 'checklist' } | { type: 'commit' }
interface RunState { runId: string; cardId: string | null; chatId: string; purpose: ChatPurpose; written: Set<CardDocumentKind>; pendingMove: string | null; notify(change: CardChange): void }
export interface RunReport { written: CardDocumentKind[]; pendingMove: string | null }
type Reply = { ok: true; text: string } | { ok: false; error: string }

const historyTools = new Set(['gearmod_assess_complexity', 'gearmod_choose_workflow', 'gearmod_record_decision', 'gearmod_record_understanding', 'gearmod_record_exploration'])
const cardTypeError = (types: Array<{ id: string; name: string }>): string => `tipo must be one of the project's card types: ${types.map((item) => `${item.id} (${item.name})`).join(', ')}. The short workflow is not a type: choose it with gearmod_choose_workflow (fluxo light).`

const normalize = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Local channel between the MCP server (the agent's child process) and the app. Uses a Unix socket / named pipe, never a network port,
 * and each run has its own token, valid only while it runs. Every write goes through the same validations as IPC.
 */
export class McpBridge {
  usesSpecKit(cardId: string): boolean { return this.deps.history?.sddMethod(cardId) === 'speckit' }
  private server?: Server
  private readonly runs = new Map<string, RunState>()
  private readonly dir: string
  readonly socketPath: string

  constructor(private readonly deps: { board: BoardRepository; context: Pick<AgentContextService, 'block' | 'skillInstructions'>; serverScript: string; runtime?: string; collab?: CollaborationService; conversations?: Pick<ConversationRepository, 'projectOf' | 'convertToPlanning'>; constitution?: Pick<ConstitutionRepository, 'get' | 'write' | 'propose'>; checklists?: Pick<ChecklistRepository, 'write' | 'get'>; git?: Pick<GitManager, 'agentCommit'>; history?: CardHistoryService; approvals?: ApprovalService; policy?: PolicyEngine; sddResolver?: Pick<SddResolver, 'constitution' | 'locate'>; sddWriter?: Pick<SddWriter, 'write'>; planReady?: (cardId: string) => { notices: string[] }; prepareWorktree?: (cardId: string) => Promise<unknown>; trimWorktree?: (cardId: string, keep: string[]) => Promise<{ removed: string[]; kept: Array<{ name: string; reason: string }> }>; repositories?: (cardId: string) => Array<{ path: string; status: string }>; agentMoveApproval?: boolean; codeIndex?: Pick<CodeIndexService, 'tool' | 'isTool' | 'prewarm'>; codeRoots?: (run: { cardId: string | null; chatId: string }) => string[]; codeEnabled?: (run: { cardId: string | null; chatId: string }) => boolean; testCommand?: { get(projectId: string): string; set(projectId: string, command: string): string; suggest(cardId: string): string } }) {
    const id = randomBytes(6).toString('hex')
    this.dir = join(tmpdir(), `gearmod-${id}`)
    this.socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\gearmod-${id}` : join(this.dir, 'mcp.sock')
  }

  async listen(): Promise<void> {
    if (process.platform !== 'win32') { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); chmodSync(this.dir, 0o700) }
    this.server = createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const end = buffer.indexOf('\n'); if (end < 0) return
        const answer = (reply: Reply): void => { socket.end(`${JSON.stringify(reply)}
`) }
        const fail = (error: unknown): void => answer({ ok: false, error: error instanceof Error ? error.message : String(error) })
        try { const request = JSON.parse(buffer.slice(0, end)) as { token?: string; tool?: string; args?: Record<string, unknown> }; Promise.resolve(this.handle(request.token ?? '', request.tool ?? '', request.args ?? {})).then(answer, fail) }
        catch (error) { fail(error) }
      })
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.socketPath, resolve) })
    if (process.platform !== 'win32') chmodSync(this.socketPath, 0o600)
  }

  /** Reads or saves the project's automated-test command (the "Configure command" of the Changes panel). It never runs the command. */
  private testCommand(run: RunState, args: Record<string, unknown>): Reply {
    const store = this.deps.testCommand
    if (!store) return { ok: false, error: 'The test command is not available' }
    const projectId = run.cardId ? this.deps.board.card(run.cardId).projectId : this.deps.conversations?.projectOf(run.chatId)
    if (!projectId) return { ok: false, error: 'This conversation has no project' }
    if (args.comando === undefined) {
      const current = store.get(projectId), suggested = run.cardId && !current ? store.suggest(run.cardId) : ''
      return { ok: true, text: current ? `Current test command: ${current}` : suggested ? `No test command saved. Suggested from the worktree: ${suggested}` : 'No test command saved.' }
    }
    if (typeof args.comando !== 'string') return { ok: false, error: 'comando must be a text (empty to clear)' }
    const saved = store.set(projectId, args.comando)
    if (run.cardId) run.notify({ type: 'card' })
    return { ok: true, text: saved ? `Test command saved for the project: ${saved}. The user runs it from "Testes automatizados" in the Changes panel.` : 'Test command cleared.' }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve())
    if (process.platform !== 'win32') rmSync(this.dir, { recursive: true, force: true })
  }

  register(runId: string, cardId: string | null, notify: (change: CardChange) => void, chat: { id: string; purpose: ChatPurpose } = { id: '', purpose: 'execution' }): McpEndpoint {
    const token = randomBytes(24).toString('hex')
    this.runs.set(token, { runId, cardId, chatId: chat.id, purpose: chat.purpose, written: new Set(), pendingMove: null, notify })
    // the code index of this conversation's folders starts getting ready while the agent boots; if turned off in the project, the tools disappear
    const codeOn = this.codeOn({ cardId, chatId: chat.id })
    if (codeOn && chat.purpose !== 'constitution') { try { this.deps.codeIndex?.prewarm(this.deps.codeRoots?.({ cardId, chatId: chat.id }) ?? []) } catch { /* no folders yet */ } }
    return { command: this.deps.runtime ?? process.execPath, args: [this.deps.serverScript], env: { ELECTRON_RUN_AS_NODE: '1', GEARMOD_SOCKET: this.socketPath, GEARMOD_TOKEN: token, GEARMOD_PURPOSE: chat.purpose, GEARMOD_CODE_INDEX: codeOn ? '1' : '0' } }
  }

  finish(runId: string): RunReport {
    for (const [token, state] of this.runs) {
      if (state.runId !== runId) continue
      this.runs.delete(token)
      return { written: [...state.written], pendingMove: state.pendingMove }
    }
    return { written: [], pendingMove: null }
  }

  private handle(token: string, tool: string, args: Record<string, unknown>): Reply | Promise<Reply> {
    const run = this.runs.get(token)
    if (!run) return { ok: false, error: 'Unknown run, or it has already ended.' }
    const { board, context } = this.deps
    try {
      if (tool === 'gearmod_read_skill') {
        if (typeof args.nome !== 'string' || !args.nome.trim()) return { ok: false, error: 'nome must be a skill from the catalog' }
        const instructions = context.skillInstructions(args.nome.trim())
        return instructions ? { ok: true, text: instructions } : { ok: false, error: `Unknown skill: ${args.nome}` }
      }
      if (tool === 'gearmod_create_card') {
        // A Constitution chat can also create a card (e.g. to really write a change, G09); the conversation becomes that card's.
        if ((run.purpose !== 'free' && run.purpose !== 'constitution') || run.cardId) return { ok: false, error: 'This conversation already has a card.' }
        if (!this.deps.conversations) return { ok: false, error: 'Free chat is not available' }
        const constitutionChat = run.purpose === 'constitution'
        const title = args.titulo, priority = args.prioridade ?? 'medium', summary = args.resumo ?? ''
        if (typeof title !== 'string' || !title.trim() || title.length > 240) return { ok: false, error: 'titulo must be a text of 1 to 240 characters' }
        if (!['low', 'medium', 'high', 'urgent'].includes(String(priority))) return { ok: false, error: 'prioridade must be low, medium, high or urgent' }
        if (typeof summary !== 'string') return { ok: false, error: 'resumo must be a text' }
        const projectId = this.deps.conversations.projectOf(run.chatId), types = board.cardTypes(projectId)
        // No type: the first in the project's list. With a type: id or name of one of the project's types.
        const type = args.tipo === undefined ? types[0]!.id : findCardType(types, String(args.tipo))?.id
        if (!type) return { ok: false, error: cardTypeError(types) }
        const columns = board.get(projectId).columns
        const column = columns.find((item) => item.semanticState === 'backlog') ?? columns.find((item) => item.semanticState === 'todo') ?? columns[0]
        if (!column) return { ok: false, error: 'The project has no columns' }
        const card = board.create({ projectId, columnId: column.id, type: String(type), title: title.trim(), description: summary, priority: String(priority), acceptanceCriteria: [] })
        this.deps.conversations.convertToPlanning(run.chatId, card.id)
        run.cardId = card.id; run.purpose = 'planning'
        run.notify({ type: 'converted', cardId: card.id, chatId: run.chatId })
        return { ok: true, text: constitutionChat ? `Card "${card.title}" created in ${column.label}. Send the complete text with gearmod_write_constitution for review and approval on the card.` : `Card "${card.title}" created in ${column.label}. This chat is now its planning chat: load gearmod-planning with gearmod_read_skill, follow the skill, save the Specification, Plan and Tasks with gearmod_write_document and call gearmod_finish_planning when done.` }
      }
      if (tool === 'gearmod_read_constitution' || tool === 'gearmod_write_constitution' || tool === 'gearmod_propose_constitution') return this.constitution(run, tool, args)
      // code index: read-only, in this conversation's folders (card worktree or project folders); also applies in the free chat
      if (tool.startsWith('gearmod_code_')) return this.codeTool(run, tool, args)
      if (tool === 'gearmod_test_command') return this.testCommand(run, args)
      if (!run.cardId) return { ok: false, error: 'This conversation has no card yet. If the user asks to plan something, call gearmod_create_card first.' }
      if (tool === 'gearmod_request_commit') return this.requestCommit(run, args)
      if (historyTools.has(tool)) return this.history(run, tool, args)
      if (tool === 'gearmod_set_repositories') return this.setRepositories(run, args)
      if (tool === 'gearmod_card_context') return context.block(run.cardId, run.purpose === 'planning').then((text) => ({ ok: true as const, text }))
      if (tool === 'gearmod_write_document') {
        const kind = args.tipo, markdown = args.markdown
        if (this.deps.history?.sddMethod(run.cardId) === 'speckit' && (kind === 'especificacao' || kind === 'plano' || kind === 'tasks')) return { ok: false, error: 'Spec Kit artifacts must be created by the native skills (speckit-specify, speckit-plan, speckit-tasks) in the card worktree; do not use this tool.' }
        if (typeof kind !== 'string' || !(cardDocumentKinds as readonly string[]).includes(kind) || (systemDocumentKinds as readonly string[]).includes(kind)) return { ok: false, error: `tipo must be one of: ${cardDocumentKinds.filter((item) => !(systemDocumentKinds as readonly string[]).includes(item)).join(', ')}` }
        if (typeof markdown !== 'string' || markdown.length > 200_000) return { ok: false, error: 'markdown must be a text of up to 200,000 characters' }
        board.documents.write(run.cardId, kind as CardDocumentKind, markdown, 'agent')
        run.written.add(kind as CardDocumentKind); run.notify({ type: 'document', kind: kind as CardDocumentKind })
        return { ok: true, text: `Document ${kind} saved.` }
      }
      if (tool === 'gearmod_test_checklist') {
        if (run.purpose !== 'test') return { ok: false, error: 'This tool is for the tester.' }
        if (!this.deps.checklists) return { ok: false, error: 'The test checklist is not available' }
        if (args.markdown === undefined) return { ok: true, text: this.deps.checklists.get(run.cardId).contentMd || '(no checklist saved yet)' }
        if (typeof args.markdown !== 'string' || args.markdown.length > 50_000) return { ok: false, error: 'markdown must be the complete checklist (up to 50,000 characters)' }
        this.deps.checklists.write(run.cardId, args.markdown); this.deps.history?.sync(run.cardId); run.notify({ type: 'checklist' })
        return { ok: true, text: 'Test checklist saved.' }
      }
      if (tool === 'gearmod_finish_planning') {
        if (run.purpose !== 'planning') return { ok: false, error: 'This tool is for the planner.' }
        if (this.deps.history?.sddMethod(run.cardId) === 'speckit') return { ok: false, error: 'In Spec Kit, planning is ready when the specification, plan and tasks of the card feature exist in the worktree; GearMod checks this on its own after each stage.' }
        const missing = board.markPlanReady(run.cardId)
        if (missing.length) return { ok: false, error: `Documents still missing: ${missing.join(', ')}. Save them and call again.` }
        run.notify({ type: 'card' })
        // Plan artifacts (card folder and, in the SDD flow, the method's central folder) are written by the app, never by the planner.
        let notices: string[] = []; try { notices = this.deps.planReady?.(run.cardId).notices ?? [] } catch (error) { notices = [error instanceof Error ? error.message : String(error)] }
        return { ok: true, text: `Planning concluded; the card now shows as "Plan ready".${notices.length ? ` Notices: ${notices.join(' ')}` : ''}` }
      }
      if (tool === 'gearmod_mark_task') {
        if (!Number.isInteger(args.linha) || (args.linha as number) < 1 || typeof args.feito !== 'boolean') return { ok: false, error: 'linha must be an integer from 1 and feito a boolean' }
        board.documents.setTask(run.cardId, (args.linha as number) - 1, args.feito, 'agent'); run.notify({ type: 'task' })
        return { ok: true, text: `Line ${String(args.linha)} ${args.feito ? 'checked' : 'unchecked'}.` }
      }
      if (tool === 'gearmod_update_card') {
        const current = board.card(run.cardId)
        const title = args.titulo === undefined ? current.title : args.titulo, type = args.tipo === undefined ? current.type : args.tipo, priority = args.prioridade === undefined ? current.priority : args.prioridade
        if (typeof title !== 'string' || !title.trim() || title.length > 240) return { ok: false, error: 'titulo must be a text of 1 to 240 characters' }
        // A new type must be one of the project's types; the current one (even if it left the list) is still accepted.
        const resolvedType = args.tipo === undefined || args.tipo === current.type ? current.type : findCardType(board.cardTypes(current.projectId), String(type))?.id
        if (!resolvedType) return { ok: false, error: cardTypeError(board.cardTypes(current.projectId)) }
        if (!['low', 'medium', 'high', 'urgent'].includes(String(priority))) return { ok: false, error: 'prioridade must be low, medium, high or urgent' }
        if (args.descricao !== undefined && (typeof args.descricao !== 'string' || args.descricao.length > 20_000)) return { ok: false, error: 'descricao must be a text of up to 20,000 characters' }
        board.update({ cardId: run.cardId, type: resolvedType, title: title.trim(), description: typeof args.descricao === 'string' ? args.descricao.trim() : current.description, priority: String(priority), acceptanceCriteria: current.acceptanceCriteria.map(({ body, checked }) => ({ body, checked })) })
        run.notify({ type: 'card' })
        return { ok: true, text: `Card updated: ${title.trim()} (${resolvedType}, ${String(priority)}).` }
      }
      if (tool === 'gearmod_propose_change' || tool === 'gearmod_ask_planner') {
        if (!this.deps.collab) return { ok: false, error: 'Collaboration between stages is not available' }
        if (run.purpose !== 'execution' && run.purpose !== 'test') return { ok: false, error: 'This tool is for the developer and the tester; the planner changes the documents directly.' }
        if (tool === 'gearmod_ask_planner') {
          if (typeof args.pergunta !== 'string' || !args.pergunta.trim()) return { ok: false, error: 'provide the pergunta' }
          const question = this.deps.collab.askQuestion({ cardId: run.cardId, chatId: run.chatId, purpose: run.purpose, question: args.pergunta })
          run.notify({ type: 'card' })
          return { ok: true, text: `Question D${String(question.number).padStart(3, '0')} registered. Continue only with what does not depend on it and END this run: the app takes the question to the planner and resumes you with the answer.` }
        }
        if (![args.titulo, args.o_que_muda, args.motivo].every((value) => typeof value === 'string' && value.trim())) return { ok: false, error: 'provide titulo, o_que_muda and motivo' }
        const change = this.deps.collab.proposeChange({ cardId: run.cardId, chatId: run.chatId, purpose: run.purpose, title: args.titulo as string, details: args.o_que_muda as string, reason: args.motivo as string })
        run.notify({ type: 'card' })
        return { ok: true, text: `Proposal M${String(change.number).padStart(3, '0')} registered and awaiting the user's authorization. Do NOT implement this change. Continue only with what is in the documents and end this run; the app resumes you when there is a decision.` }
      }
      if (tool === 'gearmod_answer_question' || tool === 'gearmod_ask_user') {
        if (!this.deps.collab) return { ok: false, error: 'Collaboration between stages is not available' }
        if (run.purpose !== 'planning') return { ok: false, error: 'This tool is for the planner.' }
        if (!Number.isInteger(args.numero) || typeof (tool === 'gearmod_answer_question' ? args.resposta : args.pergunta) !== 'string') return { ok: false, error: 'provide numero (integer) and ' + (tool === 'gearmod_answer_question' ? 'resposta' : 'pergunta') }
        if (tool === 'gearmod_answer_question') this.deps.collab.answerFromPlanner(run.cardId, args.numero as number, args.resposta as string)
        else this.deps.collab.escalateToUser(run.cardId, args.numero as number, args.pergunta as string)
        run.notify({ type: 'card' })
        return { ok: true, text: tool === 'gearmod_answer_question' ? `Question ${String(args.numero)} answered; the app returns the answer to whoever asked.` : `Question ${String(args.numero)} sent to the user; the app resumes whoever asked when the user answers.` }
      }
      if (tool === 'gearmod_move_card') {
        if (typeof args.coluna !== 'string' || (args.quando !== 'agora' && args.quando !== 'ao_terminar')) return { ok: false, error: 'provide coluna and quando ("agora" or "ao_terminar")' }
        const column = this.findColumn(run.cardId, args.coluna)
        if (!column) return { ok: false, error: `Column not found: ${args.coluna}` }
        // The policy applies to both moments: the "when finishing" move also does not escape deny or ask.
        const moveDecision = this.policyDecision(run, 'move')
        if (moveDecision === 'deny') return { ok: false, error: 'Blocked by the project policy (move).' }
        // S05 (behind the flag, or when the project policy says ask): the move becomes a pending request; Done stays subject to the gate when the user approves.
        if ((this.deps.agentMoveApproval || moveDecision === 'ask') && this.deps.approvals) {
          const card = board.card(run.cardId)
          const approval = this.deps.approvals.request({ kind: 'agent-move', subjectRef: run.cardId, payload: { columnId: column.id, columnLabel: column.label }, requestedActor: 'agent', runId: run.runId, cardId: run.cardId, projectId: card.projectId })
          run.notify({ type: 'card' })
          return { ok: true, text: `Request to move to ${column.label} registered (${approval.id}), awaiting the user's approval on the card.` }
        }
        if (args.quando === 'ao_terminar') { run.pendingMove = column.id; return { ok: true, text: `The card will move to ${column.label} when this run ends.` } }
        board.move(run.cardId, column.id, null, 'agent'); run.notify({ type: 'moved', column: column.label })
        return { ok: true, text: `Card moved to ${column.label}.` }
      }
      return { ok: false, error: `Unknown tool: ${tool}` }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  /** Card repositories: only they get a worktree. On a run, the new repository is prepared on the spot (the others stay as they are). */
  private async codeTool(run: RunState, tool: string, args: Record<string, unknown>): Promise<Reply> {
    const { codeIndex, codeRoots } = this.deps
    if (!codeIndex || !codeRoots || !codeIndex.isTool(tool)) return { ok: false, error: `Unknown tool: ${tool}` }
    if (run.purpose === 'constitution') return { ok: false, error: 'The code tools are not available in the Constitution chat.' }
    // may have been turned off while the agent was already running
    if (!this.codeOn(run)) return { ok: false, error: 'The code index is turned off for this project. Use Grep and Read instead.' }
    return { ok: true, text: await codeIndex.tool(tool, args, codeRoots({ cardId: run.cardId, chatId: run.chatId })) }
  }

  private codeOn(run: { cardId: string | null; chatId: string }): boolean {
    if (!this.deps.codeIndex) return false
    try { return this.deps.codeEnabled?.(run) ?? true } catch { return true }
  }

  private async setRepositories(run: RunState, args: Record<string, unknown>): Promise<Reply> {
    if (!run.cardId) return { ok: false, error: 'This conversation has no card yet.' }
    if (!Array.isArray(args.repositorios) || args.repositorios.some((item) => typeof item !== 'string')) return { ok: false, error: 'repositorios must be a list of names' }
    const { board } = this.deps, card = board.card(run.cardId)
    const sources = board.get(card.projectId).project.sources.filter((source) => source.isGitRepository)
    const names = (args.repositorios as string[]).map((name) => name.trim()).filter(Boolean)
    const chosen = names.map((name) => sources.find((source) => normalize(source.name) === normalize(name)))
    const missing = names.filter((_, index) => !chosen[index])
    if (missing.length) return { ok: false, error: `Unknown repository: ${missing.join(', ')}. Available: ${sources.map((source) => source.name).join(', ')}` }
    board.setRepos(run.cardId, chosen.length ? chosen.map((source) => source!.id) : null)
    try { this.deps.history?.decide(run.cardId, { kind: 'scope', statement: `Repositórios do card: ${chosen.length ? chosen.map((source) => source!.name).join(', ') : 'todos'}`, rationale: typeof args.motivo === 'string' ? args.motivo : '', actor: 'agent', source: { actor: 'agent', runId: run.runId, chatId: run.chatId } }) } catch { /* decision is a record, it does not block */ }
    let prepared = ''
    if (run.purpose === 'execution' || run.purpose === 'test') {
      const worktree = await this.deps.prepareWorktree?.(run.cardId).catch((error: unknown) => { prepared = ` Could not prepare: ${error instanceof Error ? error.message : String(error)}`; return null })
      if (worktree) prepared = ` Worktree updated; folders: ${(this.deps.repositories?.(run.cardId) ?? []).map((repo) => `${repo.path} (${repo.status})`).join(', ')}.`
    }
    run.notify({ type: 'card' })
    return { ok: true, text: `The card works in: ${chosen.length ? chosen.map((source) => source!.name).join(', ') : 'all repositories'}.${prepared}` }
  }

  /** Complexity Engine, decisions, understanding and exploration: all become a versioned card event (docs/09). */
  private history(run: RunState, tool: string, args: Record<string, unknown>): Reply {
    const history = this.deps.history
    const cardId = run.cardId
    if (!cardId) return { ok: false, error: 'This conversation has no card yet.' }
    if (!history) return { ok: false, error: 'The card history is not available' }
    const source = { actor: 'agent' as const, runId: run.runId, chatId: run.chatId }
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()) : []
    const evidence = (value: unknown): Evidence[] => (Array.isArray(value) ? value : []).map((item: Record<string, unknown>) => evidenceSchema.parse({ kind: item?.tipo, ref: item?.referencia, detail: typeof item?.detalhe === 'string' ? item.detalhe : '', line: Number.isInteger(item?.linha) ? item.linha : null, commit: typeof item?.commit === 'string' ? item.commit : null }))
    try {
      if (tool === 'gearmod_assess_complexity') {
        const notes = (args.notas ?? {}) as Record<string, unknown>
        const scores = dimensionScoresSchema.safeParse(Object.fromEntries(complexityDimensions.map((dimension) => [dimension, notes[dimension]])))
        if (!scores.success) return { ok: false, error: `notas must have ${complexityDimensions.join(', ')}, each from 0 to 3` }
        const confidence = ({ baixa: 'low', media: 'medium', alta: 'high' } as const)[String(args.confianca) as 'baixa']
        if (!confidence) return { ok: false, error: 'confianca must be baixa, media or alta' }
        const trigger = assessmentTriggerSchema.safeParse(args.gatilho ?? 'initial')
        if (!trigger.success) return { ok: false, error: `gatilho must be one of: ${assessmentTriggerSchema.options.filter((item) => item !== 'user-correction').join(', ')}` }
        if (trigger.data === 'user-correction') return { ok: false, error: 'The user\'s correction is made by the user, on the card assessment screen.' }
        if (typeof args.motivo !== 'string' || !args.motivo.trim()) return { ok: false, error: 'provide the motivo (why assess now)' }
        const justifications = Object.fromEntries(Object.entries((args.justificativas ?? {}) as Record<string, unknown>).filter(([key, value]) => (complexityDimensions as readonly string[]).includes(key) && typeof value === 'string').map(([key, value]) => [key, (value as string).trim()]))
        const { assessment, previous } = history.assess({ cardId: cardId, scores: scores.data, justifications, confidence, preliminary: args.preliminar === true, criticalRisks: strings(args.riscos_criticos), evidence: evidence(args.evidencias), trigger: trigger.data, reason: args.motivo, source })
        run.notify({ type: 'card' })
        const delta = previous ? ` (before ${previous.total}; ${assessment.total - previous.total >= 0 ? '+' : ''}${assessment.total - previous.total})` : ''
        return { ok: true, text: `Assessment v${assessment.version} registered: ${assessment.total} points${delta}, ${levelLabels[assessment.level]} task${assessment.preliminary ? ' (preliminary)' : ''}. Recommended workflow: ${workflowLabels[assessment.workflow]}. Present the recommendation to the user; when they confirm (or choose another), call gearmod_choose_workflow.` }
      }
      if (tool === 'gearmod_choose_workflow') {
        const workflow = workflowKindSchema.safeParse(args.fluxo)
        if (!workflow.success) return { ok: false, error: 'fluxo must be light, spec or sdd' }
        const method = args.metodo === 'native' || args.metodo === 'speckit' ? args.metodo : undefined
        if (workflow.data === 'sdd' && (!method || typeof args.motivo !== 'string' || !args.motivo.trim())) return { ok: false, error: 'For SDD, recommend metodo native or speckit and explain in motivo why it suits this card.' }
        const flowPolicyDenied = this.policyDenied(run, 'choose-workflow'); if (flowPolicyDenied) return { ok: false, error: flowPolicyDenied }
        if (!this.deps.approvals) return { ok: false, error: 'Approvals are not available' }
        if (workflow.data === 'sdd' && method) history.recommendSddMethod(cardId, method, String(args.motivo), source)
        const card = this.deps.board.card(cardId), approval = this.deps.approvals.request({ kind: 'workflow-choice', subjectRef: cardId, payload: { workflow: workflow.data, method: method ?? null, reason: typeof args.motivo === 'string' ? args.motivo : '' }, requestedActor: 'agent', runId: run.runId, cardId, projectId: card.projectId })
        run.notify({ type: 'card' })
        return { ok: true, text: `Workflow proposal ${workflowLabels[workflow.data]}${method ? ` — ${method === 'native' ? 'GearMod SDD' : 'GitHub Spec Kit'}` : ''} registered for the user's approval (${approval.id}). Wait for the decision before continuing in the workflow.` }
      }
      if (tool === 'gearmod_record_decision') {
        const kind = decisionKindSchema.safeParse(args.tipo ?? 'other')
        if (!kind.success) return { ok: false, error: `tipo must be one of: ${decisionKindSchema.options.join(', ')}` }
        if (typeof args.decisao !== 'string' || !args.decisao.trim()) return { ok: false, error: 'provide the decisao' }
        if (args.origem !== 'usuario' && args.origem !== 'agente') return { ok: false, error: 'origem must be "usuario" (the user decided in the chat) or "agente" (your recommendation)' }
        const active = history.decisions(cardId).filter((item) => item.status !== 'superseded')
        const reviewed = Array.isArray(args.decisoes_revisadas) ? args.decisoes_revisadas : []
        if (!Array.isArray(args.decisoes_revisadas) || active.some((item) => !reviewed.includes(item.number))) return { ok: false, error: `Review the current decisions below before registering. If the new one replaces any, give its number in substitui; if it is equivalent, do not duplicate. Send all reviewed numbers in decisoes_revisadas (or [] if there are no decisions):\n${active.map((item) => `D${item.number} [${item.status}]: ${item.statement}`).join('\n') || '(none)'}` }
        // MCP input is never proof of a human action; even when the agent claims it came from the user, it stays as a proposal.
        const decision = history.decide(cardId, { kind: kind.data, statement: args.decisao, rationale: typeof args.motivo === 'string' ? args.motivo : '', actor: 'agent', supersedes: Number.isInteger(args.substitui) ? args.substitui as number : null, source })
        run.notify({ type: 'card' })
        return { ok: true, text: `Decision D${String(decision.number).padStart(3, '0')} registered as a proposal, awaiting the user${args.origem === 'usuario' ? ' (the origin declared by the agent was downgraded)' : ''}.` }
      }
      if (tool === 'gearmod_record_understanding') {
        const readiness = args.prontidao === 'pronto' ? 'pronto' : args.prontidao === 'precisa_esclarecer' ? 'precisa-esclarecer' : null
        if (!readiness || typeof args.objetivo !== 'string' || !args.objetivo.trim()) return { ok: false, error: 'provide objetivo and prontidao ("pronto" or "precisa_esclarecer")' }
        history.recordDiscovery(cardId, { objetivo: args.objetivo.trim(), motivacao: typeof args.motivacao === 'string' ? args.motivacao : '', escopo: strings(args.escopo), exclusoes: strings(args.exclusoes), criterios: strings(args.criterios), pendencias: strings(args.pendencias), contextoTecnico: typeof args.contexto_tecnico === 'string' ? args.contexto_tecnico : '', prontidao: readiness }, source)
        run.notify({ type: 'card' })
        return { ok: true, text: readiness === 'pronto' ? 'Understanding registered. Now assess the complexity with gearmod_assess_complexity.' : 'Understanding registered with open items. Clarify with the user before assessing the complexity (or register a preliminary assessment).' }
      }
      if (tool === 'gearmod_record_exploration') {
        if (typeof args.resumo !== 'string' || !args.resumo.trim()) return { ok: false, error: 'provide the resumo of the exploration' }
        const saved = history.recordExploration(cardId, { summary: args.resumo.trim().slice(0, 8000), modules: strings(args.modulos), repositories: strings(args.repositorios), evidence: evidence(args.evidencias) }, source)
        run.notify({ type: 'card' })
        return { ok: true, text: `Exploration saved for the current version of the code (${Object.keys(saved.codeVersions).join(', ') || 'no Git'}). It appears in the context of the next turns; only explore again if the code or the request changes.` }
      }
      return { ok: false, error: `Unknown tool: ${tool}` }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message.slice(0, 2000) : String(error) } }
  }

  /** Agent commit: the branch rule (never, ask permission or automatic) is applied by the GitManager. */
  private async requestCommit(run: RunState, args: Record<string, unknown>): Promise<Reply> {
    if (!this.deps.git) return { ok: false, error: 'GearMod Git is not available' }
    if (run.purpose !== 'execution' || !run.cardId) return { ok: false, error: 'This tool is for the developer (implementation stage).' }
    const denied = this.policyDenied(run, 'commit'); if (denied) return { ok: false, error: denied }
    if (typeof args.mensagem !== 'string') return { ok: false, error: 'provide the commit mensagem' }
    if (args.arquivos !== undefined && (!Array.isArray(args.arquivos) || args.arquivos.some((item) => typeof item !== 'string'))) return { ok: false, error: 'arquivos must be a list of paths' }
    if (args.repositorio !== undefined && typeof args.repositorio !== 'string') return { ok: false, error: 'repositorio must be a text' }
    try {
      const result = await this.deps.git.agentCommit({ cardId: run.cardId, chatId: run.chatId, message: args.mensagem, files: args.arquivos as string[] | undefined, repo: args.repositorio as string | undefined })
      run.notify({ type: 'commit' })
      return { ok: true, text: result.text }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  /**
   * Constitution (G09): everyone reads (via the file-first resolver, with a fallback to legacy SQLite); only whoever has a card writes — in
   * its worktree, via `SddWriter` — and other chats propose (the user applies). The Constitution chat converses and
   * understands freely, but with no card it writes nothing: the instruction (skill) is to create a card when it is really time to write.
   */
  private async constitution(run: RunState, tool: string, args: Record<string, unknown>): Promise<Reply> {
    const { constitution, conversations } = this.deps
    if (!conversations) return { ok: false, error: 'The Constitution is not available' }
    const projectId = conversations.projectOf(run.chatId)
    if (tool === 'gearmod_read_constitution') {
      if (this.deps.sddResolver) {
        try {
          const view = await this.deps.sddResolver.constitution({ projectId, cardId: run.cardId ?? undefined })
          if (view.content !== null) return { ok: true, text: `Project Constitution:\n\n${view.content}` }
        } catch { /* SDD repository not configured yet or unavailable: treat as no Constitution */ }
      }
      return { ok: true, text: 'The project has no Constitution yet.' }
    }
    if (tool === 'gearmod_write_constitution') {
      if (!run.cardId) return { ok: false, error: 'This tool writes to a card worktree. Create a card (gearmod_create_card) to make this change.' }
      if (typeof args.markdown !== 'string' || !args.markdown.trim() || args.markdown.length > 400_000) return { ok: false, error: 'markdown must be the complete text of the Constitution (up to 400,000 characters)' }
      if (!this.deps.sddResolver || !this.deps.approvals) return { ok: false, error: 'SDD approval is not available' }
      const [view, location] = await Promise.all([
        this.deps.sddResolver.constitution({ projectId, cardId: run.cardId }),
        this.deps.sddResolver.locate({ projectId, cardId: run.cardId })
      ])
      this.deps.approvals.request({ kind: 'constitution-apply', subjectRef: view.path, cardId: run.cardId, projectId, runId: run.runId, requestedActor: 'agent', payload: { sourceId: location.sourceId, path: view.path, before: view.content, content: args.markdown, expectBlobSha: view.blobSha } })
      run.notify({ type: 'constitution' })
      return { ok: true, text: `Proposal registered for ${view.path}. Wait for the user's review and approval on the card; the file has not been changed yet.` }
    }
    if (!constitution) return { ok: false, error: 'The Constitution is not available' }
    if (run.purpose === 'constitution') return { ok: false, error: 'To actually write it, create a card (gearmod_create_card) and save with gearmod_write_constitution from it.' }
    if (![args.titulo, args.o_que_muda, args.motivo].every((value) => typeof value === 'string' && value.trim())) return { ok: false, error: 'provide titulo, o_que_muda and motivo' }
    const proposal = constitution.propose({ projectId, cardId: run.cardId, chatId: run.chatId, title: args.titulo as string, details: args.o_que_muda as string, reason: args.motivo as string })
    run.notify({ type: 'constitution' })
    return { ok: true, text: `Change C${String(proposal.number).padStart(3, '0')} registered in the project Constitution tab, awaiting the user to apply it. Until then, the current Constitution remains in force.` }
  }

  private findColumn(cardId: string, name: string): { id: string; label: string } | undefined {
    const wanted = normalize(name), card = this.deps.board.card(cardId)
    return this.deps.board.get(card.projectId).columns.find((column) => column.id === name || normalize(column.label) === wanted || column.semanticState === wanted)
  }

  /**
   * S11: queries the `PolicyEngine` (project rules). With no rule for the action, nothing changes (allowed); `deny` blocks; explicit `ask`
   * also does not run on its own: it tells the agent the action depends on the user (or, for a move, becomes an approval request).
   */
  private policyDecision(run: RunState, action: 'commit' | 'move' | 'choose-workflow'): 'allow' | 'ask' | 'deny' {
    if (!this.deps.policy || !run.cardId) return 'allow'
    const card = this.deps.board.card(run.cardId)
    const rules = this.deps.history?.config(card.projectId).policy.rules ?? []
    const decision = this.deps.policy.decide(rules, action, { cardId: run.cardId, projectId: card.projectId, actor: 'agent' })
    return decision === 'ask' && !rules.some((rule) => rule.action === action) ? 'allow' : decision
  }
  private policyDenied(run: RunState, action: 'commit' | 'move' | 'choose-workflow'): string | null {
    const decision = this.policyDecision(run, action)
    if (decision === 'deny') return `Blocked by the project policy (${action}).`
    // choose-workflow and move already go through user approval; only the commit needs to be blocked here.
    if (decision === 'ask' && action === 'commit') return 'The project policy requires the user to approve commits: ask the user to commit from the Git page.'
    return null
  }
}

/** Plan B: documents returned in the text between markers `<!-- gearmod:documento tipo=... -->`. */
export function extractDocuments(text: string): Array<{ kind: CardDocumentKind; markdown: string }> {
  const found: Array<{ kind: CardDocumentKind; markdown: string }> = []
  for (const match of text.matchAll(/<!--\s*gearmod:documento\s+tipo=([a-z]+)\s*-->([\s\S]*?)<!--\s*\/gearmod:documento\s*-->/g)) {
    const kind = match[1] as CardDocumentKind
    if ((cardDocumentKinds as readonly string[]).includes(kind)) found.push({ kind, markdown: match[2]!.trim() })
  }
  return found
}
