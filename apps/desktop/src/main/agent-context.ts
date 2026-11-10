import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppLanguage, CardDocumentKind, SkillRef } from '@gearmod/contracts'
import { cardDocumentKinds, complexityDimensions, levelLabels } from '@gearmod/contracts'
import type { CardHistoryService } from './history'
import { resolvedSddRoot, workflowInstructions } from './workflows'
import type { BoardRepository } from './projects'
import { constitutionIndex, inlineLimit, type ConstitutionRepository } from './constitution'
import type { SettingsRepository } from './settings'
import { specKitStageOf } from './speckit'
import type { SddResolver } from './sdd/sdd-resolver'

/** Teaches every agent to ask with buttons: the app turns this block into a card and returns the answers as a message. */
export const questionRule = 'When you need to ask something with closed answers (yes/no, pick one or several options), end the message with a ```gearmod-perguntas block containing this JSON: {"perguntas":[{"pergunta":"text","cabecalho":"up to 24 characters","multipla":false,"opcoes":[{"rotulo":"Yes","descricao":"optional"},{"rotulo":"No"}]}]}. Write the question, header, labels and descriptions in the language given in `idioma`. 1 to 4 questions, 2 to 6 options each; "multipla": true lets the user pick several. The app shows buttons (with an Other option for free text) and returns the answers in the next message. After the block, stop and wait. Open-ended questions stay in plain text.'
const freeChangeRule = 'When the user asks for a new change to the project, briefly assess the request and, before modifying files or creating a card, ask whether they prefer to create a card to document the change or to make it directly in the chat. Use the gearmod-perguntas block, with the options "Create card" and "Change directly" (labels in the language given in `idioma`), and wait for the choice. If the user has already clearly chosen one of the options for this change, respect the choice without asking again; do not repeat the question in follow-ups to the same change. Questions, explanations and investigations that do not request a change do not need this choice. If they choose to create a card, use gearmod_create_card and follow the planning flow; if they choose to change directly, proceed in the chat respecting the permission mode. In read-only mode, explain the limitation before any change. Never create a card without an explicit choice or request.'

/** Reminder of the code index in every chat that has it (the gearmod_code_* tools): it beats Grep/Read for structural questions. */
const codeIndexRule = 'For questions about the code, the impact of a change, or how to reach a screen or function, use the code index first: gearmod_code_explore (area or flow), gearmod_code_impact (what a change affects), gearmod_code_callers (who reaches a symbol, up to the route or entry point), gearmod_code_node (one symbol or file) and gearmod_code_map (overview of an unfamiliar area). Use Grep only for plain text (messages, config keys) or when the index has no answer.'

const docLabels: Record<CardDocumentKind, string> = { resumo: 'Summary', especificacao: 'Specification', plano: 'Plan', tasks: 'Tasks', duvidas: 'Questions', mudancas: 'Changes' }

/** Block that accompanies each agent turn: language, card, current column, available columns and the 4 documents. */

/** Explicit request for the skill the user chose with `/name` (empty without a skill). */
const chosenSkillLead = (skill?: SkillRef | null): string => (skill ? `Use the ${skill.name} skill for this request.\n\n` : '')

/** Content of the SKILL.md of the skill chosen in the chat, for the agent's instructions. */
function chosenSkillText(skill?: SkillRef | null): string | undefined {
  const file = skill ? join(skill.path, 'SKILL.md') : null
  return file && existsSync(file) ? `## Skill chosen for this chat: ${skill!.name}\n${stripFrontMatter(readFileSync(file, 'utf8'))}` : undefined
}

export class AgentContextService {
  /** G06: cache by blob sha (key `projectId:blobSha`) of the already formatted Constitution excerpt, to avoid recomputing the index on every turn. */
  private readonly constitutionCache = new Map<string, string>()
  constructor(private readonly board: BoardRepository, private readonly settings: SettingsRepository, readonly pluginDir: string | null, private readonly constitution?: Pick<ConstitutionRepository, 'get' | 'proposals'>, private readonly gitRule?: (cardId: string) => string | null, private readonly history?: CardHistoryService, private readonly extra?: (cardId: string) => Record<string, unknown>, private readonly sddResolver?: Pick<SddResolver, 'constitution'>) {}

  language(): AppLanguage { return this.settings.get().idioma }

  async block(cardId: string, planning = true): Promise<string> {
    const card = this.board.card(cardId), state = this.board.get(card.projectId)
    const column = state.columns.find((item) => item.id === card.columnId)
    const documents = this.board.documents.get(cardId), commitRule = this.gitRule?.(cardId) ?? null
    const body = {
      idioma: this.language(),
      card: { id: card.id, titulo: card.title, tipo: card.type, prioridade: card.priority, coluna: column ? { id: column.id, nome: column.label, estado: column.semanticState } : null },
      colunasDisponiveis: state.columns.map((item) => ({ id: item.id, nome: item.label, estado: item.semanticState })),
      tiposDeCard: state.project.cardTypes.map((item) => ({ id: item.id, nome: item.name })),
      regra: 'You only move the card if the user asks.',
      perguntasAoUsuario: questionRule,
      ...(commitRule ? { commit: commitRule } : {}),
      // Card repositories (with the worktree folders) and optional project tools, such as Playwright CLI.
      ...this.safeExtra(cardId)
    }
    // Short flow: without the four documents (saves tokens); only the description of what to do is sent.
    const law = await this.constitutionSection(card.projectId, cardId) + this.historySection(cardId, card.projectId, planning)
    if (card.workflow === 'light') return `<gearmod-contexto>\n${JSON.stringify({ ...body, fluxo: 'curto' }, null, 2)}\n\n## What to do\n${documents.resumo.contentMd.trim() || card.description.trim() || '(no description)'}${law}\n</gearmod-contexto>`
    const docs = cardDocumentKinds.map((kind) => `### ${docLabels[kind]}\n${documents[kind].contentMd.trim() || '(empty)'}`).join('\n\n')
    return `<gearmod-contexto>\n${JSON.stringify(body, null, 2)}\n\n## Current documents\n${docs}${law}\n</gearmod-contexto>`
  }

  private safeExtra(cardId: string): Record<string, unknown> { try { return this.extra?.(cardId) ?? {} } catch { return {} } }

  /**
   * Context Engineering (docs/09): current assessment, flow/method, current decisions, cached understanding and exploration, as a summary
   * structured (the full history stays in history.jsonl and on the card screen, on demand).
   */
  private historySection(cardId: string, projectId: string, planning = true): string {
    if (!this.history) return ''
    try {
      const history = this.history, current = history.latest(cardId), workflow = history.workflow(cardId), config = history.config(projectId)
      const decisions = history.decisions(cardId).filter((item) => item.status !== 'superseded'), brief = history.discovery(cardId), exploration = history.exploration(cardId)
      const parts: string[] = []
      parts.push(current
        ? `Complexity v${current.version}${current.preliminary ? ' (preliminary)' : ''}: ${current.total} points, ${levelLabels[current.level]}, confidence ${current.confidence}. Scores: ${complexityDimensions.map((dimension) => `${dimension} ${current.scores[dimension]}`).join(', ')}. Recommended workflow: ${current.workflow}${workflow ? `; chosen workflow: ${workflow}` : '; workflow not chosen yet'}.${current.criticalRisks.length ? ` Critical risks: ${current.criticalRisks.join('; ')}.` : ''}`
        : 'Complexity: not assessed yet.')
      const chosenMethod = history.sddMethod(cardId)
      const method = workflow === 'sdd' && !chosenMethod ? 'The SDD workflow has no method chosen on this card yet. Ask the user to choose between GearMod SDD and GitHub Spec Kit before planning.' : workflowInstructions({ ...config, complexMethod: chosenMethod ?? config.complexMethod }, resolvedSddRoot(history, this.board, projectId, chosenMethod), workflow, planning)
      if (method) parts.push(`Workflow method: ${method}`)
      if (brief) parts.push(`Understanding (${brief.prontidao}): ${brief.objetivo}${brief.escopo.length ? `\nScope: ${brief.escopo.join('; ')}` : ''}${brief.exclusoes.length ? `\nOut of scope: ${brief.exclusoes.join('; ')}` : ''}${brief.criterios.length ? `\nCriteria: ${brief.criterios.join('; ')}` : ''}${brief.pendencias.length ? `\nOpen items: ${brief.pendencias.join('; ')}` : ''}`)
      if (decisions.length) parts.push(`Current decisions:\n${decisions.map((item) => `- D${String(item.number).padStart(3, '0')} [${item.status === 'approved' ? 'user' : 'agent recommendation, not approved'}] ${item.statement}`).join('\n')}`)
      if (exploration) parts.push(`Code exploration${exploration.stale ? ' (STALE: the code changed since then; check before relying on it)' : ' (valid for the current version of the code)'}: ${exploration.summary}`)
      return `\n\n## Discovery, complexity and decisions\n${historyRule}\n\n${parts.join('\n\n')}`
    } catch { return '' }
  }

  /**
   * G06 — Constitution in the context of every project chat: whole if short, otherwise only the index (the agent reads the rest
   * through the tool). With `GEARMOD_SDD_FILE_FIRST=1` and a file already migrated, reads through the `SddResolver` (cache by blob sha);
   * with no file there yet, falls back to legacy SQLite with a warning that it was not migrated. Teaches the agent to warn when something
   * violates a principle and to suggest what should become a principle, without changing it directly.
   */
  private async constitutionSection(projectId: string, cardId?: string): Promise<string> {
    // The repository file is the only source of the Constitution; SQLite does not enter the agent's context.
    if (this.sddResolver) {
      try {
        const view = await this.sddResolver.constitution({ projectId, cardId })
        if (view.content !== null) {
          const cacheKey = `${projectId}:${view.blobSha ?? 'null'}`
          const cached = this.constitutionCache.get(cacheKey)
          if (cached !== undefined) return cached
          const text = view.content.trim()
          const section = !text
            ? `\n\n## Project Constitution\n(The project has no Constitution yet.) ${constitutionRule}`
            : `\n\n## Project Constitution\n${constitutionRule}\n\n${text.length <= inlineLimit ? text : `${constitutionIndex(text)}\n\n(This is only the index. Read the full text with gearmod_read_constitution before planning or deciding whether something violates a principle.)`}`
          this.constitutionCache.set(cacheKey, section)
          return section
        }
        // view.content === null: the file does not exist yet; continues below as "no Constitution".
      } catch { /* resolver unavailable (sourceId removed etc.): treat as no Constitution */ }
    }
    return `

## Project Constitution
(The project has no Constitution yet.) ${constitutionRule}`
  }

  /** Constitution chat: the whole current version and the changes agents suggested that still await a decision. */
  constitutionPrompt(projectId: string, prompt: string, skill?: SkillRef | null): string {
    const current = this.constitution?.get(projectId), pending = this.constitution?.proposals(projectId).filter((item) => item.status === 'pending') ?? []
    const body = { idioma: this.language(), tipo: 'constituicao', versaoAtual: current?.version ?? 0, regra: 'This chat only writes the project Constitution: read the code freely, without changing files or cards. Always save the complete text with gearmod_write_constitution, and only after the user agrees to the change.', perguntasAoUsuario: questionRule }
    const proposals = pending.length ? `\n\n## Changes suggested by agents (awaiting decision)\n${pending.map((item) => `- C${String(item.number).padStart(3, '0')} ${item.title}\n  What changes: ${item.details}\n  Reason: ${item.reason}`).join('\n')}` : ''
    return `<gearmod-contexto>\n${JSON.stringify(body, null, 2)}\n\n## Current Constitution\n${current?.contentMd.trim() || '(empty: the project has no Constitution yet)'}${proposals}\n</gearmod-contexto>\n\nUse the gearmod-constitution skill to run this chat.\n\n${chosenSkillLead(skill)}${prompt}`
  }

  /** Text sent to the agent: context + request. In planning, explicitly asks for the system's planning skill. */
  async prompt(cardId: string, prompt: string, planning: boolean, skill?: SkillRef | null): Promise<string> {
    const untitled = planning && !this.board.card(cardId).title.trim()
    const naming = untitled ? 'This card has no title yet: right in this first reply, call gearmod_update_card with a short title (up to 60 characters, in the language given in `idioma`) that identifies the subject, as chats do. Then continue planning.\n\n' : ''
    const speckitStage = planning ? specKitStageOf(prompt) : null
    const entry = planning && !skill && !speckitStage && !this.history?.workflow(cardId)
    const planningLead = (): string => (skill ? `Use the ${skill.name} skill to run this chat, instead of gearmod-planning. The card documents, the language and the GearMod tools still apply.\n\n` : 'Use the gearmod-planning skill to run this chat.\n\n')
    const implementing = !planning && specKitStageOf(prompt) === 'implement'
    const implementLead = implementing ? 'Spec Kit task tracking: when you finish a task in tasks.md, mark its line [X] and also mark every indented sub-item (checkbox) under it that you completed (- [x]). Never leave the sub-items of a finished task unchecked, and keep the file structure as it is.\n\n' : ''
    const executionLead = !planning && skill ? `Use the ${skill.name} skill for this request.

` : ''
    const lead = naming + executionLead + implementLead + (speckitStage ? `Run now the native Spec Kit skill requested below (speckit-${speckitStage}), with the context and current decisions above as input. Follow the skill's questions and instructions; do not use the GearMod document skills or write parallel artifacts.\n\n` : entry ? 'Mandatory entry point: the workflow for this card has not been chosen yet. Start with the gearmod-discovery skill (understand, explore, ask the questions that change the estimate and wait for the answers, then assess the complexity and propose the workflow for the user to choose) before any planning.\n\n' + planningLead() : planning ? (skill ? `Use the ${skill.name} skill to run this chat, instead of gearmod-planning. The card documents, the language and the GearMod tools still apply.\n\n` : 'Use the gearmod-planning skill to run this chat.\n\n') : '')
    return `${await this.block(cardId, planning)}\n\n${lead}${prompt}`
  }

  /** Free chat: loose conversation, read-only. If the conversation turns into planning, the agent creates the card and starts planning. */
  async freePrompt(prompt: string, projectId?: string, canEdit = false, skill?: SkillRef | null): Promise<string> {
    const regra = canEdit ? 'Free conversation without a card: when the user asks, you may change project files and run commands, within the chosen permission mode. Do not create or change cards, except through the gearmod_create_card tool.' : 'Free conversation in read-only mode: you do not change files or cards, except through the gearmod_create_card tool.'
    return `<gearmod-contexto>\n${JSON.stringify({ idioma: this.language(), tipo: 'chat-livre', regra, escolhaParaAlteracao: freeChangeRule, perguntasAoUsuario: questionRule }, null, 2)}${projectId ? await this.constitutionSection(projectId) : ''}\n</gearmod-contexto>\n\n${chosenSkillLead(skill)}${prompt}`
  }

  /** Fixed instructions of the free chat; for Codex they carry only the catalog, and the full skill is read on demand through MCP. */
  freeInstructions(withSkills: boolean, canEdit = false, skill?: SkillRef | null): string {
    const base = `You are in an GearMod free chat: converse, answer questions and read the project freely${canEdit ? ', with changes allowed according to the permission mode' : ', without changing files'}. ${freeChangeRule} ${questionRule} ${codeIndexRule} Do not use a skill for ordinary conversation or a direct change to files. When the user asks for a card or planning, load gearmod-discovery with gearmod_read_skill, call gearmod_create_card with a short title, type, priority and a summary, record the understanding, ask the questions that change the estimate, then record the complexity assessment and load and follow gearmod-planning in this same chat (documents with gearmod_write_document and, at the end, gearmod_finish_planning). Load any other skill from the catalog only when the request matches its description.`
    const skills = withSkills && this.pluginDir ? loadSkillCatalog(this.pluginDir, true) : undefined
    return [base, skills, chosenSkillText(skill)].filter(Boolean).join('\n\n---\n\n')
  }

  /** Full content of a trusted plugin skill, returned only when the agent activates it. */
  skillInstructions(name: string): string | undefined {
    if (!this.pluginDir) return undefined
    return loadSkillInstructions(this.pluginDir, this.language(), [name])
  }

  /**
   * For agents without plugin support (Codex): skills and templates of the language, in `developerInstructions`. Each stage gets only its own:
   * planning gets the planning ones; implementation and testing get the summary plus the stage's skill; short flow gets its own.
   */
  developerInstructions(planning: boolean, skill?: SkillRef | null, cardId?: string | null, purpose?: string): string | undefined {
    const which = purpose === 'constitution' ? ['gearmod-constitution'] : planning ? true : this.executionSkills(cardId, purpose)
    const system = this.pluginDir ? loadSkillInstructions(this.pluginDir, this.language(), which) : undefined
    return [system, chosenSkillText(skill)].filter(Boolean).join('\n\n---\n\n') || undefined
  }

  /** Skills of the execution stage: the short flow has its own; the others get the implement or test one. */
  private executionSkills(cardId?: string | null, purpose?: string): string[] {
    const small = cardId ? this.board.card(cardId).workflow === 'light' : false
    return ['gearmod-summary', small ? 'gearmod-small' : purpose === 'test' ? 'gearmod-test' : 'gearmod-implement']
  }
}

function stripFrontMatter(text: string): string { return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim() }

/** What every agent does with the Constitution: warn when something violates a principle and suggest what should become a principle. */
const constitutionRule = 'The Constitution gathers the principles that apply to the whole project, above each card\'s Specification. Before proposing or doing something, check whether it violates any principle. If it does: stop before continuing, say which principle and why, and ask the user whether to adjust the request, proceed anyway (with the justification recorded in the Plan, Complexity section) or change the Constitution. If a rule emerges that should apply to the whole project (not just this work), say it would be good to have it in the Constitution. You do not change the Constitution: if the user agrees to the change, record it with gearmod_propose_constitution; they apply it from the project Constitution tab.'

/** How the agent uses the history: reassess only on a real trigger and separate its own recommendation from the user's decision. */
const historyRule = 'Reassess the complexity (gearmod_assess_complexity with a trigger) only when a requirement changes, a new dependency or risk appears, the solution requires an architectural change, the scope is wrong or there are repeated failures; never on every message. For SDD, recommend per card the native or speckit method and explain the choice: consider the context, including whether the work is new or modifies an existing feature; do not treat this as a fixed rule. The choice is the user\'s. Decisions marked as a recommendation have not been approved by the user yet. Before recording a decision, review all current and proposed decisions; if it replaces one of them, give its number in substitui. Do not duplicate equivalent decisions.'

/** Planning skills: the execution ones (implement, test, small) are left out so they do not weigh on that context. */
const planningSkills = new Set(['gearmod-discovery', 'gearmod-planning', 'gearmod-specification', 'gearmod-plan', 'gearmod-tasks', 'gearmod-summary'])

/** `which`: `true` = the planning ones; `false` = only the summary; or the exact list of skills. */
export function loadSkillInstructions(pluginDir: string, language: AppLanguage, which: boolean | string[]): string | undefined {
  const skillsDir = join(pluginDir, 'skills')
  if (!existsSync(skillsDir)) return undefined
  const wanted = wantedSkills(skillsDir, which)
  const parts = wanted.map((name) => {
    const skill = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8')
    const templates = join(skillsDir, name, 'templates')
    const file = [`${language}.md`, 'pt-BR.md'].map((item) => join(templates, item)).find((item) => existsSync(item))
    return `## Skill ${name}\n${stripFrontMatter(skill)}${file ? `\n\n### Template (${language})\n${readFileSync(file, 'utf8').trim()}` : ''}`
  })
  return parts.length ? `GearMod system skills. Follow them when working on the card.\n\n${parts.join('\n\n---\n\n')}` : undefined
}

/** Minimal metadata for progressive discovery; does not inject the body or the templates of the skills. */
export function loadSkillCatalog(pluginDir: string, which: boolean | string[]): string | undefined {
  const skillsDir = join(pluginDir, 'skills')
  if (!existsSync(skillsDir)) return undefined
  const entries = wantedSkills(skillsDir, which).map((folder) => {
    const source = readFileSync(join(skillsDir, folder, 'SKILL.md'), 'utf8')
    const name = source.match(/^name:\s*(.+)$/m)?.[1]?.trim() || folder
    const description = source.match(/^description:\s*(.+)$/m)?.[1]?.trim() || 'No description.'
    return `- ${name}: ${description}`
  })
  return entries.length ? `Skills available in GearMod (discovery catalog). The full content is not loaded. When a request matches a description, call gearmod_read_skill with the name before following the procedure.\n\n${entries.join('\n')}` : undefined
}

function wantedSkills(skillsDir: string, which: boolean | string[]): string[] {
  const names = readdirSync(skillsDir).filter((name) => name.startsWith('gearmod-')).sort()
  return Array.isArray(which) ? names.filter((name) => which.includes(name)) : which ? names.filter((name) => planningSkills.has(name)) : names.filter((name) => name === 'gearmod-summary')
}
