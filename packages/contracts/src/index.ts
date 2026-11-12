import { z } from 'zod'
import { cardComplexitySchema, cardHistorySchema, cardSddMethodSchema, contestAssessmentInputSchema, decisionKindSchema, sddConfigSchema, sddDetectionSchema, workflowConfigSchema, workflowKindSchema } from './assessments'

export const noteSchema = z.object({
  id: z.string().uuid(),
  body: z.string().max(10_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})

export const createNoteInputSchema = z.object({ body: z.string().trim().min(1).max(10_000) }).strict()
export const deleteNoteInputSchema = z.object({ id: z.string().uuid() }).strict()
export const restoreBackupInputSchema = z.object({ backupId: z.string().regex(/^upgrade-[0-9T.-]+-[a-f0-9]{8}$/) }).strict()

export const backupSummarySchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  schemaVersion: z.number().int().nonnegative(),
  appVersion: z.string(),
  reason: z.string()
})

/** Update of the app itself: the latest GitHub Release compared with the running version. */
export const appUpdateSchema = z.object({
  current: z.string(),
  latest: z.string().nullable(),
  available: z.boolean(),
  notes: z.string(),
  publishedAt: z.string().nullable(),
  url: z.string(),
  /** True when the installer can be downloaded and run by the app (Windows); elsewhere the release page opens. */
  canInstall: z.boolean(),
  /** Terminal command that installs the update by hand (Debian package only); null when there is none. */
  manualCommand: z.string().nullable(),
  checkedAt: z.string().nullable(),
  checking: z.boolean(),
  /** Download progress (0 to 1) while `downloading`. */
  progress: z.number().min(0).max(1).nullable(),
  /** The installer of `latest` is being downloaded in the background. */
  downloading: z.boolean(),
  /** The installer of `latest` is on disk and matches the Release checksum: installing needs no download. */
  ready: z.boolean(),
  /** The installer was started and the app is quitting. */
  installing: z.boolean(),
  error: z.string().nullable()
})
export type AppUpdate = z.output<typeof appUpdateSchema>
export const storageKindSchema = z.enum(['playwright-version', 'playwright-browsers', 'node', 'voice-model', 'voice-engine', 'backup', 'update-download', 'worktrees', 'attachments', 'database'])
export const storageEntrySchema = z.object({ id: z.string(), kind: storageKindSchema, name: z.string(), path: z.string(), bytes: z.number().nonnegative(), partial: z.boolean(), removable: z.boolean() })
export const storageSnapshotSchema = z.object({ entries: z.array(storageEntrySchema), totalBytes: z.number().nonnegative() })
export type StorageKind = z.output<typeof storageKindSchema>
export type StorageEntry = z.output<typeof storageEntrySchema>
export type StorageSnapshot = z.output<typeof storageSnapshotSchema>
export const appAboutSchema = z.object({ name: z.string(), version: z.string(), author: z.string(), authorEmail: z.string().nullable(), license: z.string(), homepage: z.string(), buildDate: z.string().nullable(), electron: z.string(), chromium: z.string(), node: z.string(), v8: z.string(), system: z.string(), dataDir: z.string() })
export type AppAbout = z.output<typeof appAboutSchema>

export const appInfoSchema = z.object({
  appVersion: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  dataDir: z.string()
})

const isoDate = z.string().datetime()
const uuid = z.string().uuid()
/**
 * Card type: id of one of the types registered in the project (or in the default list). It is free text of limited length, not an enum:
 * old cards with a type that left the list remain valid (shown in a neutral color). The short flow (formerly "small task")
 * is not a type: it comes from the card's chosen flow (`workflow` = `light`).
 */
export const cardTypeSchema = z.string().trim().min(1).max(40)
export const cardTypeColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)
/** `branchPrefix`: start of the branch name for cards of this type (`feature/...`). Without it, the type's English default applies (`branchPrefixOf`). */
export const branchPrefixSchema = z.string().trim().min(1).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/)
export const cardTypeDefSchema = z.object({ id: z.string().trim().min(1).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/), name: z.string().trim().min(1).max(40), color: cardTypeColorSchema, branchPrefix: branchPrefixSchema.optional() })
const defaultBranchPrefixes: Record<string, string> = { feature: 'feature', bug: 'fix', fix: 'fix', hotfix: 'hotfix', improvement: 'improvement', task: 'task', chore: 'chore' }
/** Branch prefix of a card by its type: the one chosen on the type; otherwise the English default (feature, fix, hotfix...); otherwise the type's own id. */
export const branchPrefixOf = (type: { id: string; branchPrefix?: string | undefined } | undefined, typeId: string): string => type?.branchPrefix || defaultBranchPrefixes[type?.id ?? typeId] || (/^[a-z0-9][a-z0-9-]*$/.test(type?.id ?? typeId) ? (type?.id ?? typeId) : 'feature')
/** List of card types: 1 to 30, ids and names without repeats. */
export const cardTypeListSchema = z.array(cardTypeDefSchema).min(1).max(30)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, 'Tipos de card com id repetido')
  .refine((items) => new Set(items.map((item) => item.name.toLocaleLowerCase())).size === items.length, 'Tipos de card com nome repetido')
/** Default types (projects without their own list and the global default while the user changes nothing). */
/** English names in any language (they match the branch prefixes: feature/, fix/, improvement/); anyone who wants can rename the type. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept in the signature: callers still pass the language
export const builtinCardTypes = (_language: 'pt-BR' | 'en' = 'pt-BR'): Array<z.infer<typeof cardTypeDefSchema>> => [
  { id: 'feature', name: 'Feature', color: '#8fb8d6' },
  { id: 'bug', name: 'Bug', color: '#f08a8a' },
  { id: 'improvement', name: 'Improvement', color: '#9ccf6f' }
]
/** Finds the type by id or by name (case-insensitive). */
export const findCardType = <T extends { id: string; name: string }>(types: readonly T[], value: string): T | undefined => {
  const wanted = value.trim().toLocaleLowerCase()
  return types.find((item) => item.id === value.trim()) ?? types.find((item) => item.name.toLocaleLowerCase() === wanted)
}
export const cardPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent'])
export const semanticStateSchema = z.enum(['backlog', 'todo', 'doing', 'test', 'done'])

/**
 * Gemini profiles run through Google's Antigravity CLI (`agy`): the provider id stays `gemini` for the stored data, the label is
 * "Antigravity". Only one Antigravity profile can exist (the CLI keeps a single Google account per OS user).
 */
export const geminiEnabled = true
export const agentProviderSchema = z.enum(['codex', 'claude', 'gemini'])
export const agentColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)
/** Personality colors offered when registering an agent; the color is independent of the system theme. */
export const agentColorPalette = ['#D97757', '#E5A24B', '#9ccf6f', '#6fc3b2', '#8fb8d6', '#aeb9ff', '#b98fd6', '#e07a9a', '#e8c27a', '#c4d96b', '#5fbf8f', '#4fb8c9', '#6f9bf0', '#8c8cf0', '#d98fd9', '#f08a8a', '#d9a477', '#b5bdb7'] as const
export const providerLabels: Record<z.infer<typeof agentProviderSchema>, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Antigravity' }
export const defaultAgentColor = (provider: z.infer<typeof agentProviderSchema>): string => (provider === 'claude' ? agentColorPalette[0] : provider === 'gemini' ? '#7BA7FF' : agentColorPalette[5])
export const themeSchema = z.enum(['green', 'purple', 'blue', 'orange', 'graphite', 'teal', 'rose', 'light-mint', 'light-sky', 'light-lavender', 'light-sand', 'light-rose', 'light-slate'])
export const languageSchema = z.enum(['pt-BR', 'en'])
/** `groq` transcribes in the cloud (Groq, whisper-large-v3-turbo); the others run local whisper.cpp. */
export const voiceModelSchema = z.enum(['small', 'large-v3-turbo', 'groq'])
/** `retomarSozinho`: when the usage limit runs out in the middle of a run, resumes where it stopped as soon as it returns. */
/** `idioma`: language of the interface and of what the agents write. */
/** `execucoesSimultaneas`: how many agents run at the same time; `null` = not chosen yet, the hardware-computed recommendation applies. */
export const concurrencyLimitSchema = z.number().int().min(1).max(16)
export const customThemeSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), nome: z.string().trim().min(1).max(40), cor: z.string().regex(/^#[0-9a-fA-F]{6}$/), modo: z.enum(['light', 'dark']) }).strict()
/** Reference to a theme: a built-in preset or `custom:<id>` of a user-made theme. */
export const themeRefSchema = z.union([themeSchema, z.string().regex(/^custom:[A-Za-z0-9_-]{1,64}$/)])
export const customThemesSchema = z.array(customThemeSchema).max(20)
export const appSettingsSchema = z.object({ tema: themeRefSchema, temasPersonalizados: customThemesSchema, idioma: languageSchema, voz: voiceModelSchema, notificacoes: z.boolean(), retomarSozinho: z.boolean(), fotosGravatar: z.boolean(), chatLateralInicial: z.boolean(), execucoesSimultaneas: concurrencyLimitSchema.nullable() })
export const updateAppSettingsInputSchema = z.object({ tema: themeRefSchema.optional(), temasPersonalizados: customThemesSchema.optional(), idioma: languageSchema.optional(), voz: voiceModelSchema.optional(), notificacoes: z.boolean().optional(), retomarSozinho: z.boolean().optional(), fotosGravatar: z.boolean().optional(), chatLateralInicial: z.boolean().optional(), execucoesSimultaneas: concurrencyLimitSchema.nullable().optional() }).strict()
export const runCapacitySchema = z.object({ active: z.number(), queued: z.number(), limit: z.number(), recommended: z.number(), cores: z.number(), memoryGb: z.number() })
export const voiceStatusSchema = z.object({ model: voiceModelSchema, cloud: z.boolean(), modelInstalled: z.boolean(), engineInstalled: z.boolean(), canInstallEngine: z.boolean(), sizeMb: z.number(), downloading: z.object({ item: z.enum(['programa', 'modelo']), received: z.number(), total: z.number().nullable() }).nullable() })
export type VoiceModel = z.infer<typeof voiceModelSchema>
export type VoiceStatus = z.infer<typeof voiceStatusSchema>
export const agentProfileSchema = z.object({
  id: uuid, provider: agentProviderSchema, label: z.string(), scope: z.string(), color: agentColorSchema,
  configDir: z.string(), executablePath: z.string().nullable(), enabled: z.boolean(), billingMode: z.enum(['subscription','api','credits','unknown']),
  /** Hint seen in the last run (e.g. `apiKeySource` from Claude); only suggests a mode in the UI, never saved as `billingMode` on its own. */
  apiKeySourceHint: z.string().nullable().optional(),
  /** S07/S08: environment variables this profile declared to pass to the agent, beyond the app's fixed list. Names, never values. */
  envPassthrough: z.array(z.string().trim().min(1).max(100)).max(50).default([])
})
/** S16: every new profile requires its own login; there is no longer an option to reuse an already logged-in CLI session. */
export const createAgentProfileInputSchema = z.object({
  provider: agentProviderSchema, label: z.string().trim().min(1).max(80),
  scope: z.string().trim().min(1).max(80), color: agentColorSchema.optional()
}).strict()
export const boardColumnSchema = z.object({ id: uuid, projectId: uuid, label: z.string(), sortOrder: z.number().int(), semanticState: semanticStateSchema, isDefault: z.boolean() })
export const projectSourceSchema = z.object({
  id: uuid, projectId: uuid, name: z.string(), localPath: z.string(), isGitRepository: z.boolean(), currentBranch: z.string().nullable(),
  /** Branch new card worktrees start from in this repository (always from its latest version). `null`: follows the current branch. */
  baseBranch: z.string().nullable(), sortOrder: z.number().int()
})
/** Project icon: small image (the app shrinks it to 96px) stored as a data URL. */
export const projectIconSchema = z.string().max(300_000).regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/, 'Ícone deve ser uma imagem PNG, JPEG, WebP ou GIF')
export const projectSchema = z.object({
  id: uuid, name: z.string(), icon: z.string().nullable(), localPath: z.string(), baseBranch: z.string(), remoteProvider: z.string().nullable(),
  allowedProfileIds: z.array(uuid), sources: z.array(projectSourceSchema),
  /** Card types in effect in the project: its own (`customCardTypes`) or the default list. */
  cardTypes: z.array(cardTypeDefSchema), customCardTypes: z.boolean(), activity: z.object({ running: z.number().int().nonnegative(), finished: z.number().int().nonnegative(),
    /** Cards waiting for the user (question, change or approval to decide, agent asking permission). */
    waiting: z.number().int().nonnegative().optional(),
    /** What the project has for the user, card by card (the hover menu of the project in the sidebar): waiting first, then failed, finished and running. */
    alerts: z.array(z.object({ cardId: uuid, title: z.string(), kind: z.enum(['waiting', 'failed', 'finished', 'running']) })).optional() }), createdAt: isoDate, updatedAt: isoDate
})
export const projectInspectionSchema = z.object({
  localPath: z.string(), name: z.string(), repositories: z.array(z.object({ localPath: z.string(), name: z.string(), currentBranch: z.string(), branches: z.array(z.string()),
    /** Suggested base: the remote's default branch (origin/HEAD), or the current one. */
    defaultBranch: z.string().optional() }))
})
export const agentPurposeSchema = z.enum(['planning', 'execution', 'test'])
export const permissionModeSchema = z.enum(['plan', 'auto', 'accept_edits', 'manual', 'on_request', 'read_only', 'bypass'])
/** `ultra`: Codex's maximum effort with automatic task delegation. */
export const effortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
export const agentConfigSchema = z.object({ profileId: uuid, model: z.string().trim().max(120).nullable(), effort: effortSchema.nullable(), mode: permissionModeSchema })
export const cardAgentsSchema = z.object({ planning: agentConfigSchema.nullable(), execution: agentConfigSchema.nullable(), test: agentConfigSchema.nullable() })
export const modelOptionSchema = z.object({ id: z.string(), label: z.string(), description: z.string(), efforts: z.array(effortSchema), recommendedFor: z.array(agentPurposeSchema), defaultEffort: effortSchema.nullable() })
export const mostUsedSchema = z.object({ model: z.string().nullable(), effort: effortSchema.nullable() }).nullable()
export const agentOptionsSchema = z.object({ models: z.array(modelOptionSchema), mostUsed: z.object({ planning: mostUsedSchema, execution: mostUsedSchema, test: mostUsedSchema }), error: z.string().optional() })

export type PermissionMode = z.infer<typeof permissionModeSchema>
export interface PermissionModeInfo { id: PermissionMode; label: string; description: string; purposes: Array<z.infer<typeof agentPurposeSchema>>; needsApprovalUi?: boolean; dangerous?: boolean; recommended?: boolean }
/** Permission modes per provider (plano 08, section 6). Approval requests appear in the run's chat. */
export const permissionModes: Record<'claude' | 'codex' | 'gemini', PermissionModeInfo[]> = {
  claude: [
    { id: 'plan', label: 'Plano', description: 'Só lê e planeja; não altera arquivos.', purposes: ['planning'], recommended: true },
    { id: 'accept_edits', label: 'Aceitar edições', description: 'Edita arquivos sem perguntar; pede aprovação para comandos que precisarem.', purposes: ['execution', 'test'], recommended: true },
    { id: 'auto', label: 'Automático', description: 'O próprio Claude decide o que é seguro aprovar.', purposes: ['execution', 'test'] },
    { id: 'manual', label: 'Manual', description: 'Pergunta a cada ação. A aprovação aparece no chat.', purposes: ['execution', 'test'] },
    { id: 'bypass', label: 'Ignorar permissões', description: 'Executa tudo sem pedir. Use só em ambiente descartável.', purposes: ['execution', 'test'], dangerous: true }
  ],
  gemini: [
    { id: 'plan', label: 'Plano', description: 'Só lê e planeja; não altera arquivos.', purposes: ['planning'], recommended: true },
    { id: 'manual', label: 'Padrão', description: 'Pergunta antes de rodar comandos: cada um aparece no chat para você aprovar ou negar. Edições na pasta do card e ferramentas MCP rodam sem perguntar.', purposes: ['execution', 'test'], recommended: true },
    { id: 'accept_edits', label: 'Aceitar edições', description: 'Edita arquivos sem perguntar; comandos de shell pedem aprovação no chat.', purposes: ['execution', 'test'] },
    { id: 'auto', label: 'Automático (yolo)', description: 'Aprova tudo sozinho, inclusive comandos. O Antigravity não pede confirmação; use com a worktree do card.', purposes: ['execution', 'test'], dangerous: true }
  ],
  codex: [
    { id: 'plan', label: 'Plano', description: 'Somente leitura, só planeja.', purposes: ['planning'], recommended: true },
    { id: 'auto', label: 'Automático', description: 'Edita na pasta do projeto e uma revisão automática aprova o que for seguro.', purposes: ['execution', 'test'], recommended: true },
    { id: 'on_request', label: 'Sob pedido', description: 'Edita na pasta do projeto e pede aprovação para o resto. A aprovação aparece no chat.', purposes: ['execution', 'test'] },
    { id: 'read_only', label: 'Somente leitura', description: 'Lê e pede aprovação para qualquer mudança. A aprovação aparece no chat.', purposes: ['execution', 'test'] },
    { id: 'bypass', label: 'Ignorar permissões', description: 'Sem sandbox e sem aprovações. Use só em ambiente descartável.', purposes: ['execution', 'test'], dangerous: true }
  ]
}
export const agentPermissionSchema = z.object({ id: uuid, runId: uuid, chatId: uuid, provider: z.enum(['claude', 'codex', 'gemini']), kind: z.string(), details: z.record(z.string(), z.unknown()), planning: z.boolean().optional() })
export type AgentPermission = z.infer<typeof agentPermissionSchema>
export const defaultPermissionMode = (provider: 'claude' | 'codex' | 'gemini', purpose: z.infer<typeof agentPurposeSchema>): PermissionMode => (purpose === 'planning' ? 'plan' : provider === 'claude' ? 'accept_edits' : provider === 'gemini' ? 'manual' : 'auto')

export const skillScopeSchema = z.enum(['global', 'project'])
export const skillProviderStateSchema = z.enum(['ready', 'none', 'converting'])
export const skillEntrySchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), scope: skillScopeSchema, detected: z.boolean(),
  providers: z.object({ claude: skillProviderStateSchema, codex: skillProviderStateSchema, gemini: skillProviderStateSchema }),
  paths: z.object({ claude: z.string().nullable(), codex: z.string().nullable(), gemini: z.string().nullable() }),
  origin: z.string().nullable()
})
export const skillRefSchema = z.object({ name: z.string().min(1).max(64), path: z.string().min(1).max(2048) })
export type SkillScope = z.infer<typeof skillScopeSchema>
export type SkillProviderState = z.infer<typeof skillProviderStateSchema>
export type SkillEntry = z.infer<typeof skillEntrySchema>
export type SkillRef = z.infer<typeof skillRefSchema>

export const usageWindowSchema = z.object({ id: z.string(), label: z.string(), usedPercent: z.number().min(0).max(100), resetsAt: isoDate.nullable() })
export const agentUsageSchema = z.object({ profileId: uuid, provider: agentProviderSchema, windows: z.array(usageWindowSchema), capturedAt: isoDate.nullable(), source: z.string() })
export type UsageWindow = z.infer<typeof usageWindowSchema>
export type AgentUsage = z.infer<typeof agentUsageSchema>
export const usageHistoryRowSchema = z.object({ period: z.string(), group: z.string(), input: z.number().int().nonnegative(), cached: z.number().int().nonnegative(), output: z.number().int().nonnegative(), billedUsd: z.number(), equivalentUsd: z.number(), unknownUsd: z.number() })
export type UsageHistoryRow = z.infer<typeof usageHistoryRowSchema>

/** The 4 plan documents + Doubts and Changes, generated by the system from the questions and proposals between stages. */
export const questionSchema = z.object({ id: uuid, number: z.number().int(), askerPurpose: agentPurposeSchema, question: z.string(), status: z.enum(['open', 'planner', 'user', 'answered']), answer: z.string().nullable(), answeredBy: z.enum(['planner', 'user']).nullable(), userQuestion: z.string().nullable(), createdAt: isoDate, answeredAt: isoDate.nullable() })
export const changeSchema = z.object({ id: uuid, number: z.number().int(), proposerPurpose: agentPurposeSchema, title: z.string(), details: z.string(), reason: z.string(), status: z.enum(['pending', 'accepted', 'suggested', 'rejected', 'applied']), userNote: z.string().nullable(), createdAt: isoDate, decidedAt: isoDate.nullable(), sentAt: isoDate.nullable() })
export const collaborationSchema = z.object({ questions: z.array(questionSchema), changes: z.array(changeSchema) })
export type Question = z.infer<typeof questionSchema>
export type Change = z.infer<typeof changeSchema>
export type Collaboration = z.infer<typeof collaborationSchema>

export const cardDocumentKinds = ['resumo', 'especificacao', 'plano', 'tasks', 'duvidas', 'mudancas'] as const
export const systemDocumentKinds = ['duvidas', 'mudancas'] as const
export const cardDocumentKindSchema = z.enum(cardDocumentKinds)
export const cardDocumentSchema = z.object({ kind: cardDocumentKindSchema, contentMd: z.string(), updatedAt: isoDate.nullable(), updatedBy: z.enum(['user', 'agent', 'system']).nullable() })
export const cardDocumentsSchema = z.object({ resumo: cardDocumentSchema, especificacao: cardDocumentSchema, plano: cardDocumentSchema, tasks: cardDocumentSchema, duvidas: cardDocumentSchema, mudancas: cardDocumentSchema })
export const documentVersionSchema = z.object({ id: uuid, version: z.number().int().positive(), contentMd: z.string(), createdAt: isoDate, actor: z.enum(['user', 'agent', 'system']) })
export const taskCountSchema = z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
export const criterionSchema = z.object({ id: uuid, cardId: uuid, body: z.string(), checked: z.boolean(), sortOrder: z.number().int() })
/** `failed`: the last run ended with an error (e.g. agent without login/token); `error` says why. `paused`: stopped by the user or interrupted. */
export const cardRunStateSchema = z.object({ state: z.enum(['idle', 'planning', 'running', 'paused', 'failed', 'finished']), runId: uuid.nullable(), profileId: uuid.nullable(), purpose: agentPurposeSchema.nullable(), error: z.string().nullable().optional() })
export const cardSchema = z.object({
  id: uuid, projectId: uuid, columnId: uuid, sourceId: uuid.nullable(), type: cardTypeSchema, title: z.string(), description: z.string(),
  priority: cardPrioritySchema, orderKey: z.number(), createdAt: isoDate, updatedAt: isoDate,
  archivedAt: isoDate.nullable(), acceptanceCriteria: z.array(criterionSchema), tasks: taskCountSchema, run: cardRunStateSchema, testsRunning: z.boolean().optional(), hasPlan: z.boolean(), planningOpen: z.boolean(), workspace: z.object({ branch: z.string(), baseRef: z.string(), path: z.string(), sharedFrom: z.string().nullable().optional() }).nullable(), pending: z.object({ changes: z.number().int().nonnegative(), questions: z.number().int().nonnegative(), commits: z.number().int().nonnegative(), toSend: z.number().int().nonnegative(), testFailures: z.number().int().nonnegative(), testBlocked: z.number().int().nonnegative().optional(), decisions: z.number().int().nonnegative().optional() }), execProfileId: uuid.nullable(), execModel: z.string().nullable(), agentIds: z.array(uuid), complexity: cardComplexitySchema.nullable(), repoIds: z.array(uuid).nullable(),
  /** Chosen flow (`light` = short flow, a single agent) and, in SDD, the method. Null = not chosen yet. */
  workflow: workflowKindSchema.nullable(), sddMethod: cardSddMethodSchema.nullable(),
  /** How many things wait for the user on the card: questions, changes and approvals to decide, and agents asking permission right now. */
  waiting: z.number().int().nonnegative().optional()
})
export const projectBoardSchema = z.object({ project: projectSchema, columns: z.array(boardColumnSchema), cards: z.array(cardSchema) })
export const agentProbeSchema = z.object({
  profileId: uuid, provider: z.enum(['codex', 'claude', 'gemini']), installed: z.boolean(), authenticated: z.boolean(),
  version: z.string().nullable(), executablePath: z.string().nullable(), capabilities: z.array(z.string()), checkedAt: isoDate,
  error: z.string().nullable(), account: z.string().nullable()
})
/** `constitution`: project chat (no card) that writes the Constitution. */
export const chatPurposeSchema = z.union([agentPurposeSchema, z.literal('free'), z.literal('constitution'), z.literal('conflict'), z.literal('test-setup')])
export const chatSchema = z.object({ id: uuid, projectId: uuid, cardId: uuid.nullable(), purpose: chatPurposeSchema, title: z.string().nullable(), busy: z.boolean(), provider: z.enum(['codex', 'claude', 'gemini']), profileId: uuid, providerSessionId: z.string().nullable(), skill: skillRefSchema.nullable(), createdAt: isoDate, updatedAt: isoDate })
/** Project Constitution: principles that apply to every card. Optional; `version` 0 = does not exist yet. */
export const constitutionSchema = z.object({ projectId: uuid, contentMd: z.string(), version: z.number().int().nonnegative(), updatedAt: isoDate.nullable(), updatedBy: z.enum(['user', 'agent', 'system']).nullable() })
/** Change to the Constitution suggested by an agent outside its chat: only takes effect after the user applies it. */
export const constitutionProposalSchema = z.object({ id: uuid, projectId: uuid, number: z.number().int().positive(), cardId: uuid.nullable(), title: z.string(), details: z.string(), reason: z.string(), status: z.enum(['pending', 'applied', 'dismissed']), createdAt: isoDate })
/** Tester checklist (what to verify, ticked as they verify); empty until they build it. */
/**
 * Who made the last change to a checklist item (`by`: the user clicking or the agent saving the checklist) and when (`at`).
 * `agent`: when the agent gave the OK to the item; it stays stored even if the user unticks and ticks again, and only goes away if the agent unticks.
 */
export const checklistMarkSchema = z.object({ by: z.enum(['user', 'agent']), at: isoDate, agent: isoDate.optional() })
export const cardChecklistSchema = z.object({ cardId: uuid, contentMd: z.string(), updatedAt: isoDate.nullable(), marks: z.record(z.string(), checklistMarkSchema) })
/** Key of a checklist item (the text, ignoring differences in spacing and case): links the item to the mark of who changed it. */
export const checklistKey = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()
export const constitutionStateSchema = z.object({ constitution: constitutionSchema, proposals: z.array(constitutionProposalSchema), importable: z.string().nullable() })
export const chatMessageSchema = z.object({ id: uuid, chatId: uuid, role: z.enum(['user', 'assistant', 'system', 'tool']), body: z.string(), status: z.enum(['streaming', 'complete', 'failed']), createdAt: isoDate, providerMessageId: z.string().nullable() })
export const runSchema = z.object({ id: uuid, cardId: uuid.nullable(), chatId: uuid, profileId: uuid, status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']), startedAt: isoDate, endedAt: isoDate.nullable(), exitReason: z.string().nullable(), worktreeId: uuid.nullable(), providerTurnId: z.string().nullable() })
/** Tokens spent in a card stage: `input` is what the agent read anew, `cached` what came from cache and `output` what it wrote. */
export const tokenCountSchema = z.object({ input: z.number().int().nonnegative(), cached: z.number().int().nonnegative(), output: z.number().int().nonnegative(), runs: z.number().int().nonnegative() })
/** Usage of an agent in a card stage. */
export const cardAgentUsageSchema = tokenCountSchema.extend({ purpose: z.enum(['planning', 'execution', 'test']), profileId: uuid, label: z.string(), provider: z.enum(['codex', 'claude', 'gemini']) })
export const cardUsageSchema = z.object({ planning: tokenCountSchema, execution: tokenCountSchema, test: tokenCountSchema, agents: z.array(cardAgentUsageSchema).default([]) })
export type TokenCount = z.output<typeof tokenCountSchema>
export type CardUsage = z.output<typeof cardUsageSchema>
export type CardAgentUsage = z.output<typeof cardAgentUsageSchema>
export const runEventSchema = z.object({ id: uuid, runId: uuid, seq: z.number().int().nonnegative(), eventType: z.string(), payload: z.record(z.string(), z.unknown()), createdAt: isoDate })
export const planSchema = z.object({ id: uuid, cardId: uuid, version: z.number().int().positive(), agentProfileId: uuid, contentMd: z.string(), status: z.enum(['draft', 'approved', 'superseded']), createdAt: isoDate, approvedAt: isoDate.nullable() })
export const worktreeSchema = z.object({ id: uuid, cardId: uuid, repoPath: z.string(), path: z.string(), branch: z.string(), baseRef: z.string(), createdAt: isoDate, cleanupState: z.enum(['active', 'missing', 'cleanup-requested', 'removed']) })
export const gitSnapshotSchema = z.object({ worktreeId: uuid, status: z.string(), diff: z.string(), exists: z.boolean() })
/** Result of one repository's command inside an automated test run (`skipped`: the card did not change it, or it has no tests). */
export const testRunRepoSchema = z.object({ name: z.string(), label: z.string(), command: z.string(), status: z.enum(['running', 'passed', 'failed', 'skipped']), exitCode: z.number().int().nullable(), reason: z.string() })
export const testRunSchema = z.object({ id: uuid, cardId: uuid, command: z.string(), status: z.enum(['running', 'passed', 'failed']), exitCode: z.number().int().nullable(), summary: z.string(), startedAt: isoDate, endedAt: isoDate.nullable(), repos: z.array(testRunRepoSchema).optional() })
/** Automated-test setting of one project repository: its command and short name, or that it has no tests (`applicable: false`). */
export const repoTestCommandSchema = z.object({ sourceId: uuid, repo: z.string(), path: z.string(), command: z.string(), name: z.string(), applicable: z.boolean() })
export const reviewSchema = z.object({ id: uuid, cardId: uuid, provider: z.enum(['github', 'gitlab', 'local']), remoteUrl: z.string().nullable(), remoteId: z.string().nullable(), state: z.enum(['open', 'approved', 'merged', 'closed']), targetBranch: z.string(), sourceBranch: z.string(), updatedAt: isoDate })

/** Metrics of a run, only with what the provider reports: `reported` cost comes from the agent itself; without that it is `unavailable` (never silently estimated). */
export const runMetricSchema = z.object({ runId: uuid, purpose: z.string().nullable(), provider: z.string().nullable(), model: z.string().nullable(), modelEffective: z.string().nullable(), effort: z.string().nullable(), status: z.string(), startedAt: isoDate, endedAt: isoDate.nullable(), durationMs: z.number().int().nullable(), input: z.number().int(), cached: z.number().int(), output: z.number().int(), costUsd: z.number().nullable(), costSource: z.enum(['reported', 'unavailable']), promptChars: z.number().int().nullable(), usedPlaywrightCli: z.boolean() })
export type RunMetric = z.output<typeof runMetricSchema>
/** Playwright CLI (@playwright/cli, command playwright-cli): the app's own tool, in its own folder, with several versions and one chosen per project. */
export const playwrightStatusSchema = z.object({
  node: z.object({ system: z.string().nullable(), managed: z.string().nullable() }),
  enabled: z.boolean(), selected: z.string().nullable(),
  versions: z.array(z.object({ version: z.string(), path: z.string() })),
  browserReady: z.boolean(), toolsDir: z.string(), log: z.string(), error: z.string().nullable()
})
export type PlaywrightStatus = z.output<typeof playwrightStatusSchema>
export const toolsStatusSchema = z.object({
  node: z.string().nullable(), uv: z.string().nullable(), python: z.string().nullable(),
  specify: z.object({ installed: z.boolean(), version: z.string().nullable() }), openspec: z.object({ installed: z.boolean(), version: z.string().nullable() }),
  repos: z.array(z.object({ sourceId: uuid, name: z.string(), path: z.string(), specKit: z.boolean(), specKitIntegrations: z.array(z.string()), specKitVersions: z.record(z.string(), z.string()).default({}), openSpec: z.boolean() })),
  log: z.string(), error: z.string().nullable()
})
export type ToolsStatus = z.output<typeof toolsStatusSchema>
/** What a folder chosen for Spec Kit is: a Git repository (or inside one), and whether Spec Kit is already in it. */
export const toolsFolderInfoSchema = z.object({ isRepo: z.boolean(), parentRepo: z.string().nullable(), hasSpecKit: z.boolean(), integrations: z.array(z.string()), integrationVersions: z.record(z.string(), z.string()).default({}) })
export type ToolsFolderInfo = z.output<typeof toolsFolderInfoSchema>
/** The Spec Kit steps the app runs for the user in a terminal inside a dialog. Each one maps to a fixed command; the screen never sends a command line. */
export const specKitRunKindSchema = z.enum(['install-uv', 'install-cli', 'update-cli', 'init', 'init-with-git', 'upgrade-integration', 'upgrade-integrations'])
export type SpecKitRunKind = z.output<typeof specKitRunKindSchema>
export const specKitRunInputSchema = z.object({
  kind: specKitRunKindSchema, path: z.string().trim().min(1).max(2048).optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(), integration: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  /** `upgrade-integrations`: every listed integration is updated one after the other in the same terminal. */
  integrations: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)).min(1).max(12).optional()
}).strict()
export type SpecKitRunInput = z.output<typeof specKitRunInputSchema>
/** Result of the compatibility probe of a Spec Kit version: `ok` means no structural error; warnings are optional pieces. */
export const specKitProbeResultSchema = z.object({ version: z.string(), ok: z.boolean(), issues: z.array(z.object({ severity: z.enum(['error', 'warning']), code: z.string(), detail: z.string() })), checkedAt: z.string() })
export type SpecKitProbeResult = z.output<typeof specKitProbeResultSchema>
/** Verdicts published by the scheduled CI job (`speckit-compat.json` on the `speckit-compat` release): does a Spec Kit version still fit what GearMod relies on? */
export const specKitCompatSchema = z.object({
  checkedAt: z.string().nullable(),
  versions: z.record(z.string().regex(/^\d+\.\d+\.\d+$/), z.object({ ok: z.boolean(), issues: z.array(z.object({ severity: z.enum(['error', 'warning']), detail: z.string().max(400) })).max(40) }))
})
export type SpecKitCompat = z.output<typeof specKitCompatSchema>
export const toolKeys = ['claude', 'codex', 'gemini', 'specify', 'openspec', 'playwright'] as const
export const toolVersionsSchema = z.object({ checkedAt: z.string().nullable(), versions: z.object({ claude: z.string().nullable(), codex: z.string().nullable(), gemini: z.string().nullable(), specify: z.string().nullable(), openspec: z.string().nullable(), playwright: z.string().nullable() }), error: z.string().nullable() })
export type ToolVersions = z.output<typeof toolVersionsSchema>

/** First `x.y.z[-pre]` version in a text like `v1.2.3`, `2.0.14 (Claude Code)` or `codex-cli 0.50.0`. */
const parseVersion = (text: string | null): { core: [number, number, number]; pre: string | null } | null => {
  const found = text ? /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text) : null
  return found ? { core: [Number(found[1]), Number(found[2]), Number(found[3])], pre: found[4] ?? null } : null
}
/** Is the installed version older than the latest published? A prerelease newer than the stable is not "outdated". Text that is not a version = no warning. */
export function isOutdated(installed: string | null, latest: string | null): boolean {
  const have = parseVersion(installed), want = parseVersion(latest)
  if (!have || !want) return false
  for (let index = 0; index < 3; index++) { if (have.core[index]! !== want.core[index]!) return have.core[index]! < want.core[index]! }
  return have.pre !== null && want.pre === null
}
const workflowState = z.object({ config: workflowConfigSchema, detected: z.array(sddDetectionSchema), defaultArtifactsDir: z.string() })
const projectIdInput = z.object({ projectId: uuid }).strict()
export const mcpProviderSchema = z.enum(['claude', 'codex', 'gemini'])
export const mcpPresetSchema = z.object({ id: z.string(), label: z.string(), description: z.string(), transport: z.enum(['stdio', 'http']), command: z.string(), args: z.array(z.string()), env: z.array(z.string()), headers: z.array(z.string()), note: z.string().optional() })
export const mcpSecretKeySchema = z.object({ key: z.string(), set: z.boolean() })
export const mcpServerSchema = z.object({ id: uuid, scope: z.enum(['global', 'project']), projectId: uuid.nullable(), name: z.string(), presetId: z.string().nullable(), transport: z.enum(['stdio', 'http']), sse: z.boolean(), command: z.string(), args: z.array(z.string()), url: z.string(), env: z.array(mcpSecretKeySchema), headers: z.array(mcpSecretKeySchema), providers: z.array(mcpProviderSchema), enabled: z.boolean(), disabledHere: z.boolean() })
export const mcpServerInputSchema = z.object({ id: uuid.optional(), scope: z.enum(['global', 'project']), projectId: uuid.optional(), name: z.string().trim().min(1).max(40), presetId: z.string().max(40).nullable().optional(), transport: z.enum(['stdio', 'http']), sse: z.boolean().optional(), command: z.string().max(500), args: z.array(z.string().max(2000)).max(50), url: z.string().max(2000), env: z.array(z.object({ key: z.string().max(100), value: z.string().max(10_000).optional() })).max(50), headers: z.array(z.object({ key: z.string().max(100), value: z.string().max(10_000).optional() })).max(50), providers: z.array(mcpProviderSchema).min(1), enabled: z.boolean() }).strict()
export type McpPreset = z.output<typeof mcpPresetSchema>
export type McpServer = z.output<typeof mcpServerSchema>
export type McpServerInput = z.output<typeof mcpServerInputSchema>
const cardIdInput = z.object({ cardId: uuid }).strict()
export const createProjectInputSchema = z.object({
  name: z.string().trim().max(120).optional(), sourcePaths: z.array(z.string().trim().min(1).max(2048)).min(1).max(20), excludePaths: z.array(z.string().trim().min(1).max(2048)).max(200).optional(),
  /** Base branch chosen per repository in the dialog (key: the repository's folder). */
  baseBranches: z.record(z.string().max(2048), z.string().trim().min(1).max(200)).optional(), profileIds: z.array(uuid).max(8).default([]), icon: projectIconSchema.nullable().optional()
}).strict()
export const updateProjectInputSchema = z.object({ projectId: uuid, name: z.string().trim().min(1).max(120), icon: projectIconSchema.nullable().optional() }).strict()
export const setProjectProfilesInputSchema = z.object({ projectId: uuid, profileIds: z.array(uuid).max(8) }).strict()
const criterionInputSchema = z.object({ body: z.string().trim().min(1).max(2000), checked: z.boolean().default(false) })
export const createCardInputSchema = z.object({
  projectId: uuid, columnId: uuid, sourceId: uuid.nullable().optional(), type: cardTypeSchema, title: z.string().trim().max(240),
  description: z.string().max(20_000).default(''), priority: cardPrioritySchema,
  acceptanceCriteria: z.array(criterionInputSchema).max(50).default([]),
  /** Chosen when the card is created: the branch its worktree starts from, and a worktree to use instead of a new one (another card's or one made by hand). */
  baseBranch: z.string().trim().min(1).max(200).optional(),
  worktree: z.discriminatedUnion('kind', [z.object({ kind: z.literal('card'), cardId: uuid }).strict(), z.object({ kind: z.literal('external'), path: z.string().min(1).max(2048) }).strict()]).optional()
}).strict()
export const updateCardInputSchema = createCardInputSchema.omit({ projectId: true, columnId: true, baseBranch: true, worktree: true }).extend({ cardId: uuid, title: z.string().trim().min(1).max(240) }).strict()
export const moveCardInputSchema = z.object({ cardId: uuid, columnId: uuid, beforeCardId: uuid.nullable().default(null), skipGate: z.boolean().default(false) }).strict()

/** Git: agent commit rule (project default + per-branch exceptions; the first that matches wins). */
export const gitRuleSchema = z.enum(['auto', 'ask', 'never'])
/** How a PR/MR goes into its target: a merge commit, all commits squashed into one, or rebased on top with no merge commit (GitLab: fast-forward). */
export const prMergeMethodSchema = z.enum(['merge', 'squash', 'rebase'])
export type PrMergeMethod = z.output<typeof prMergeMethodSchema>
/** `mergeMethod`: the one chosen beforehand when merging a PR/MR of the project. */
export const gitPolicySchema = z.object({ def: gitRuleSchema, rules: z.array(z.object({ pattern: z.string().trim().max(200), rule: gitRuleSchema }).strict()).max(50), mergeMethod: prMergeMethodSchema.default('merge') }).strict()
export const defaultGitPolicy: z.infer<typeof gitPolicySchema> = { def: 'ask', mergeMethod: 'merge', rules: [{ pattern: 'main', rule: 'never' }, { pattern: 'develop', rule: 'never' }, { pattern: 'release/*', rule: 'never' }] }
export const gitResolvedRuleSchema = z.object({ rule: gitRuleSchema, why: z.string() })
export const gitRepoSchema = z.object({ sourceId: uuid, name: z.string(), path: z.string(), head: z.string().nullable(), hasRemote: z.boolean() })
export const gitRefSchema = z.object({ name: z.string(), kind: z.enum(['head', 'local', 'remote', 'tag']) })
/** Graph row: a commit, or (`wip` filled in) the changes not yet committed in the main folder or in a card's worktree. */
export const gitRowSchema = z.object({
  hash: z.string(), short: z.string(), parents: z.array(z.string()), lane: z.number().int().nonnegative(), author: z.string(), email: z.string(), date: isoDate.nullable(), subject: z.string(),
  refs: z.array(gitRefSchema), cardId: uuid.nullable(), agentProfileId: uuid.nullable(), wip: z.object({ modified: z.number().int(), added: z.number().int(), deleted: z.number().int(), staged: z.number().int(), branch: z.string() }).nullable(), stash: z.object({ ref: z.string(), commit: z.string() }).optional()
})
export const gitWorktreeInfoSchema = z.object({
  cardId: uuid, title: z.string(), branch: z.string(), sharedWith: z.array(z.string()),
  repos: z.array(z.object({ name: z.string(), branch: z.string(), unpushed: z.number().int().nonnegative(), files: z.number().int().nonnegative(), exists: z.boolean() }))
})
export const gitGraphSchema = z.object({
  repo: gitRepoSchema, rows: z.array(gitRowSchema), truncated: z.boolean(),
  branches: z.object({ local: z.array(z.object({ name: z.string(), cardId: uuid.nullable(), head: z.boolean(), ahead: z.number().int().default(0), behind: z.number().int().default(0) })), remote: z.array(z.object({ name: z.string(), cardId: uuid.nullable() })) }),
  worktrees: z.array(z.object({ cardId: uuid, title: z.string(), branch: z.string(), path: z.string() })),
  /** Worktrees that Git knows in this repository and GearMod did not create for a card (made by hand or by another tool). */
  externalWorktrees: z.array(z.object({ path: z.string(), branch: z.string().nullable(), detached: z.boolean() })).default([]),
  stashes: z.array(z.object({ ref: z.string(), message: z.string() }))
})
export const gitChangeSchema = z.object({ path: z.string(), status: z.enum(['M', 'A', 'D']), staged: z.boolean(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() })
export const backgroundTaskSchema = z.object({ id: z.string(), runId: z.string(), kind: z.enum(['subagent', 'command']), title: z.string(), activity: z.string(), status: z.enum(['running', 'completed', 'failed', 'stopped']), startedAt: z.string(), endedAt: z.string().nullable(), summary: z.string() })
export type BackgroundTask = z.output<typeof backgroundTaskSchema>
export const gitCommitFileSchema = z.object({ path: z.string(), status: z.enum(['M', 'A', 'D']), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() })
/** A project label as the host has it; `color` is the host's own `#rrggbb` (a project choice, outside the design system tones). */
export const prLabelSchema = z.object({ name: z.string(), color: z.string() })
/** Someone on the host: login (username) and display name. */
export const prPersonSchema = z.object({ login: z.string(), name: z.string() })
export const pullRequestSummarySchema = z.object({ number: z.number().int(), title: z.string(), url: z.string(), draft: z.boolean(), head: z.string(), base: z.string(), updatedAt: z.string(), reviewDecision: z.string().nullable(), author: z.string(), comments: z.number().int().nonnegative(), reviewRequested: z.boolean(), state: z.enum(['OPEN', 'MERGED', 'CLOSED']), createdAt: z.string(), labels: z.array(prLabelSchema).default([]),
  /** Who the request is assigned to, with the host's photo when it gives one (the list shows them on the right of each row). */
  assignees: z.array(z.object({ login: z.string(), avatar: z.string().default(''), email: z.string().default('') })).default([]) })
export const pullRequestListSchema = z.object({ supported: z.boolean(), provider: z.enum(['github', 'gitlab']).nullable(), error: z.string().nullable(), viewer: z.string().nullable(), prs: z.array(pullRequestSummarySchema), more: z.boolean().optional(), via: z.enum(['token', 'cli']).nullable().optional(), problem: z.enum(['no-cli', 'not-logged-in', 'invalid-token']).nullable().optional(), host: z.string().nullable().optional() })
export const gitAccountInfoSchema = z.object({ scope: z.enum(['project', 'repo']), host: z.string(), provider: z.enum(['github', 'gitlab']), login: z.string(), name: z.string(), email: z.string().nullable(), hint: z.string(), invalid: z.boolean(), savedAt: z.string() })
export const gitAccountsStateSchema = z.object({ hosts: z.array(z.object({ host: z.string(), provider: z.enum(['github', 'gitlab']).nullable(), project: gitAccountInfoSchema.nullable(), repos: z.array(z.object({ sourceId: z.string(), name: z.string(), own: gitAccountInfoSchema.nullable(), using: z.enum(['repo', 'project']).nullable() })) })) })
export type GitAccountInfo = z.output<typeof gitAccountInfoSchema>
export type GitAccountsState = z.output<typeof gitAccountsStateSchema>
export const prPipelineStatusSchema = z.enum(['success', 'failed', 'running', 'pending', 'canceled', 'none'])
export const prReactionsSchema = z.object({ up: z.number().int().nonnegative(), down: z.number().int().nonnegative(), mineUp: z.boolean(), mineDown: z.boolean() })
/** A comment: `kind` says which host object it is (a GitLab note, a GitHub review comment or issue comment), for editing, deleting and reacting; `url` is its link on the host. */
export const prThreadCommentSchema = z.object({ id: z.string(), author: z.string(), body: z.string(), at: z.string(), url: z.string().default(''), kind: z.enum(['note', 'review', 'issue']).default('note'), reactions: prReactionsSchema.default({ up: 0, down: 0, mineUp: false, mineDown: false }) })
/** A conversation pinned to the diff. `resolvable`: the host lets us resolve it through the API (GitLab yes; GitHub REST no). */
export const prThreadSchema = z.object({ id: z.string(), path: z.string(), oldPath: z.string(), side: z.enum(['old', 'new']), line: z.number().int(), startLine: z.number().int().nullable(), comments: z.array(prThreadCommentSchema), resolvable: z.boolean().default(false), resolved: z.boolean().default(false) })
/** A history event of the PR (assigned, labeled, pushed commits, marked ready…), already as one readable line. */
export const prEventSchema = z.object({ author: z.string(), body: z.string(), at: z.string() })
export const prCommitSchema = z.object({ sha: z.string(), shortSha: z.string(), title: z.string(), author: z.string(), at: z.string(), email: z.string().default('') })
export const prJobSchema = z.object({ id: z.string(), name: z.string(), status: z.enum(['success', 'failed', 'running', 'pending', 'canceled', 'skipped', 'manual']), duration: z.number().nonnegative().nullable(), startedAt: z.string().nullable(), url: z.string().nullable() })
export const prPipelineSchema = z.object({
  id: z.string(), sha: z.string(), ref: z.string(), source: z.string(), status: z.enum(['success', 'failed', 'running', 'pending', 'canceled', 'skipped', 'manual']), createdAt: z.string(), duration: z.number().nonnegative().nullable(), url: z.string().nullable(),
  /** In run order. GitHub has no stages: each workflow run is a pipeline with one stage named after the workflow. */
  stages: z.array(z.object({ name: z.string(), jobs: z.array(prJobSchema) }))
})
export const prVersionSchema = z.object({ id: z.string(), headSha: z.string(), baseSha: z.string().nullable(), startSha: z.string().nullable(), createdAt: z.string() })
export const prFileSchema = z.object({ path: z.string(), oldPath: z.string(), status: z.enum(['added', 'modified', 'removed', 'renamed']), additions: z.number().int(), deletions: z.number().int() })
export const pullRequestDetailSchema = z.object({ number: z.number().int(), title: z.string(), body: z.string(), url: z.string(), state: z.string(), draft: z.boolean(), head: z.string(), base: z.string(), reviewDecision: z.string().nullable(), author: z.string(), additions: z.number().int(), deletions: z.number().int(), mergeable: z.string().nullable(), files: z.array(z.object({ path: z.string(), oldPath: z.string(), status: z.enum(['added', 'modified', 'removed', 'renamed']), additions: z.number().int(), deletions: z.number().int() })), comments: z.array(prThreadCommentSchema), reviews: z.array(z.object({ author: z.string(), body: z.string(), state: z.string(), at: z.string() })), diff: z.string(), headSha: z.string().nullable(), baseSha: z.string().nullable(), startSha: z.string().nullable(), createdAt: z.string(), pipeline: prPipelineStatusSchema, canDeleteSource: z.boolean(), mergeMethods: z.array(prMergeMethodSchema).default(['merge', 'squash', 'rebase']), mergeDefault: prMergeMethodSchema.default('merge'), threads: z.array(prThreadSchema).max(500), reactions: prReactionsSchema,
  labels: z.array(prLabelSchema).default([]), assignees: z.array(prPersonSchema).default([]), reviewers: z.array(prPersonSchema).default([]),
  /** Who approved, and whether the viewer did (to show "Revogar aprovação"); `canUnapprove`: the host lets the viewer take it back (GitLab). */
  approvedBy: z.array(z.string()).default([]), approvedByMe: z.boolean().default(false), canUnapprove: z.boolean().default(false),
  /** History lines for the activity (system notes on GitLab, timeline events on GitHub), oldest first. */
  events: z.array(prEventSchema).max(500).default([]),
  /** For editing: the milestone id (GitLab) or number (GitHub), and the merge options saved on the MR (GitLab; null on GitHub). */
  milestone: z.string().nullable().default(null), milestoneTitle: z.string().nullable().default(null), squashOnMerge: z.boolean().nullable().default(null), removeSourceOnMerge: z.boolean().nullable().default(null),
  /** Photo of each person on the page (login → the host's avatar URL), and who is looking (what can be edited or deleted). */
  avatars: z.record(z.string(), z.string()).default({}), viewer: z.string().nullable().default(null),
  /** E-mail of each login when known (public e-mail, a name that is an e-mail, the viewer's git e-mail): the photo comes from Gravatar first. */
  emails: z.record(z.string(), z.string()).default({}) })
const prSha = z.string().regex(/^[0-9a-fA-F]{1,64}$/)
const prPath = z.string().min(1).max(1000).refine((v) => !v.split(/[\\/]/).includes('..') && !v.startsWith('-'))
const prPoint = z.object({ oldLine: z.number().int().positive().nullable(), newLine: z.number().int().positive().nullable(), oldPos: z.number().int().nonnegative(), newPos: z.number().int().nonnegative() }).strict().refine((v) => v.oldLine !== null || v.newLine !== null)
export type PullRequestSummary = z.output<typeof pullRequestSummarySchema>
export type PullRequestList = z.output<typeof pullRequestListSchema>
export type PullRequestDetail = z.output<typeof pullRequestDetailSchema>
export type PrPipeline = z.output<typeof prPipelineSchema>
export type PrJob = z.output<typeof prJobSchema>
export type PrCommit = z.output<typeof prCommitSchema>
export type PrLabel = z.output<typeof prLabelSchema>
export type PrPerson = z.output<typeof prPersonSchema>
export type PrVersion = z.output<typeof prVersionSchema>
export type PrFile = z.output<typeof prFileSchema>
/** What the "Nova solicitação" form can offer on this host (and which fields the host accepts when creating). */
export const prCreateOptionsSchema = z.object({
  viewer: z.string().nullable(), members: z.array(prPersonSchema), milestones: z.array(z.object({ id: z.string(), title: z.string(), due: z.string().nullable() })), labels: z.array(prLabelSchema),
  supports: z.object({ assignees: z.boolean(), reviewers: z.boolean(), milestone: z.boolean(), labels: z.boolean(), deleteSource: z.boolean(), squash: z.boolean(), uploads: z.boolean() })
})
export type PrCreateOptions = z.output<typeof prCreateOptionsSchema>
/** What a new PR would carry, from the local repository: commits of head that base doesn't have and the changed files. */
/** `message`: the body of the newest commit going in (with its title, the new request's title and description). */
export const prCompareSchema = z.object({ ahead: z.number().int().nonnegative(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), commits: z.array(prCommitSchema).max(200), files: z.array(prFileSchema).max(1000), message: z.string().default('') })
export type PrCompare = z.output<typeof prCompareSchema>
export const gitChangesSchema = z.object({ branch: z.string().nullable(), files: z.array(gitChangeSchema), lastMessage: z.string() })
export const gitRequestSchema = z.object({
  id: uuid, cardId: uuid, sourceId: uuid, repoName: z.string(), message: z.string(), files: z.array(z.string()), status: z.enum(['pending', 'done', 'denied', 'failed']),
  agentProfileId: uuid.nullable(), hash: z.string().nullable(), error: z.string().nullable(), createdAt: isoDate,
  /** The agent asked to amend the last commit of the card branch instead of creating a new one. */
  amend: z.boolean().optional()
})
export const gitCardRepoSchema = z.object({
  sourceId: uuid, name: z.string(), repoPath: z.string(), worktreePath: z.string(), ahead: z.number().int().nonnegative(), behind: z.number().int().nonnegative(), published: z.boolean(), hasRemote: z.boolean(),
  commits: z.array(z.object({ hash: z.string(), short: z.string(), subject: z.string(), author: z.string(), date: isoDate, agentProfileId: uuid.nullable() })), files: z.array(gitChangeSchema), request: gitRequestSchema.nullable(),
  state: z.enum(['active', 'failed', 'missing']), error: z.string().nullable(), prUrl: z.string().nullable(),
  /** Origin branch of this repository (each has its own; the origin can be changed on the card). */
  baseRef: z.string()
})
export const gitCardSchema = z.object({ branch: z.string().nullable(), baseBranch: z.string().nullable(), rule: gitResolvedRuleSchema, repos: z.array(gitCardRepoSchema), delivery: z.object({ complete: z.boolean(), pending: z.array(z.string()) }) })
const gitTarget = { sourceId: uuid, cardId: uuid.nullable() }
/** Human approval request (S02): `kind` identifies the type (workflow-choice, git-commit, agent-move, cleanup, ...); `payload` is specific to each type. */
export const specKitStateSchema = z.object({ active: z.boolean(), enabled: z.boolean(), reason: z.string().nullable(), permission: z.enum(['manual', 'free']).nullable(), permissionRequestId: uuid.nullable(), moveRequestId: uuid.nullable(), startRequestId: uuid.nullable(), provider: z.enum(['codex', 'claude', 'gemini']).nullable(), texts: z.object({ manual: z.string(), free: z.string() }).nullable(), artifacts: z.object({ featureDir: z.string(), spec: z.string().nullable(), plan: z.string().nullable(), tasks: z.string().nullable(), ready: z.boolean() }).nullable() })
export type SpecKitState = z.output<typeof specKitStateSchema>
export const approvalSchema = z.object({ id: uuid, kind: z.string(), subjectRef: z.string(), opHash: z.string(), payload: z.record(z.string(), z.unknown()), requestedActor: z.enum(['agent','system','user']), runId: uuid.nullable(), cardId: uuid.nullable(), projectId: uuid.nullable(), status: z.enum(['requested','approved','denied','expired']), decidedBy: z.literal('user').nullable(), decidedAt: isoDate.nullable(), note: z.string().nullable(), requestedAt: isoDate, expiresAt: isoDate, consumedAt: isoDate.nullable() })
export type Approval = z.output<typeof approvalSchema>

/** G10 — file-first SDD: where it is (without content) and what was read from the Constitution there. */
export const sddLocationSchema = z.object({ repo: z.string(), rootAbs: z.string(), ref: z.string(), via: z.enum(['worktree', 'ref']), sourceId: uuid, method: z.enum(['native', 'speckit']), worktreeBranch: z.string().nullable() })
export const constitutionViewSchema = z.object({ path: z.string(), content: z.string().nullable(), blobSha: z.string().nullable(), baseBlobSha: z.string().nullable(), headBlobSha: z.string().nullable(), state: z.enum(['in-sync', 'ahead', 'behind', 'diverged', 'missing']), method: z.enum(['native', 'speckit']), via: z.enum(['worktree', 'ref']) })
const migrationCandidateSchema = z.object({ content: z.string(), sha256: z.string() }).nullable()
export const constitutionMigrationPlanSchema = z.object({ kind: z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'existing']), action: z.enum(['template', 'preview-write', 'already-migrated', 'conflict', 'reconcile', 'use-existing']), method: z.enum(['native', 'speckit']), candidates: z.object({ db: migrationCandidateSchema, native: migrationCandidateSchema, speckit: migrationCandidateSchema }) })
const dbClassSchema = z.enum(['dev', 'test', 'prod', 'external'])
const dbConnectionFields = { projectId: uuid, name: z.string().trim().min(1).max(120), klass: dbClassSchema, host: z.string().trim().min(1).max(255), port: z.number().int().min(1).max(65535), database: z.string().trim().min(1).max(255), user: z.string().trim().min(1).max(255), sslMode: z.enum(['disable', 'require', 'verify-full']), allowWrite: z.boolean(), agentAccess: z.enum(['none', 'read']) }
export const dbConnectionSchema = z.object({ ...dbConnectionFields, id: uuid, parentId: uuid.nullable(), hasSecret: z.boolean(), origin: z.literal('manual'), envId: z.null() }).strict()
const dbConnectionSaveSchema = z.object({ ...dbConnectionFields, id: uuid.optional(), parentId: uuid.nullable().optional(), password: z.string().max(4096).optional(), passwordStorage: z.enum(['secure', 'session']).optional(), confirmWrite: z.string().max(120).optional() }).strict()
const dbFilterSchema = z.object({ column: z.number().int().positive(), operator: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'isNull', 'notNull']), value: z.string().max(10000).optional() }).strict()
const dbPageInputSchema = z.object({ where: z.string().max(2000).optional(), orderBy: z.string().max(2000).optional(), connectionId: uuid, oid: z.number().int().positive().max(4294967295), requestId: uuid, conditions: z.array(dbFilterSchema).max(100), order: z.array(z.object({ column: z.number().int().positive(), dir: z.enum(['asc', 'desc']) }).strict()).max(100), limit: z.number().int().min(1).max(1000), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict()
const dbColumnSchema = z.object({ attnum: z.number().int().positive(), name: z.string(), type: z.string() })
const dbValueMap = z.record(z.string().regex(/^[0-9]{1,5}$/), z.string().max(1000000).nullable())
const dbApplyInputSchema = z.object({ connectionId: uuid, requestId: uuid, oid: z.number().int().positive().max(4294967295), dryRun: z.boolean().optional(), inserts: z.array(dbValueMap).max(500), updates: z.array(z.object({ key: dbValueMap, set: dbValueMap }).strict()).max(500), deletes: z.array(z.object({ key: dbValueMap }).strict()).max(500) }).strict()
const dbCellSchema = z.object({ t: z.string().nullable(), big: z.literal(true).optional() })
export type DbConnection = z.output<typeof dbConnectionSchema>
export type SddLocation = z.output<typeof sddLocationSchema>
export type ConstitutionView = z.output<typeof constitutionViewSchema>
/** Code index symbol for the editor: absolute `path`, `relative` to the indexed folder. */
const codeSymbolSchema = z.object({ name: z.string(), qname: z.string(), kind: z.string(), path: z.string(), relative: z.string(), line: z.number().int(), endLine: z.number().int(), signature: z.string() })
export type CodeSymbol = z.output<typeof codeSymbolSchema>
/** State of the code index in a project: on or off and, per folder, files, symbols and the last indexing (ms since 1970). */
const codeIndexStatusSchema = z.object({ enabled: z.boolean(), roots: z.array(z.object({ root: z.string(), files: z.number().int(), symbols: z.number().int(), expected: z.number().int(), indexedAt: z.number().nullable(), ms: z.number().nullable() })) })
export type CodeIndexStatus = z.output<typeof codeIndexStatusSchema>

export const ipcContracts = {
  'app:info': { input: z.undefined(), output: appInfoSchema },
  'app:about': { input: z.undefined(), output: appAboutSchema },
  'storage:list': { input: z.undefined(), output: storageSnapshotSchema },
  'storage:remove': { input: z.object({ id: z.string().min(1).max(300) }).strict(), output: storageSnapshotSchema },
  'updates:state': { input: z.undefined(), output: appUpdateSchema },
  'updates:check': { input: z.undefined(), output: appUpdateSchema },
  'updates:install': { input: z.undefined(), output: appUpdateSchema },
  'updates:download': { input: z.undefined(), output: appUpdateSchema },
  'approvals:list': { input: z.object({ cardId: uuid.optional() }).strict(), output: z.array(approvalSchema) },
  'approvals:decide': { input: z.object({ id: uuid, approve: z.boolean(), note: z.string().max(4000).optional(), choice: z.object({ workflow: workflowKindSchema, method: z.enum(['native', 'speckit']).optional() }).strict().optional() }).strict(), output: approvalSchema },
  'approvals:apply-constitution': { input: z.object({ id: uuid }).strict(), output: approvalSchema },
  'db:feature-enabled': { input: z.undefined(), output: z.boolean() },
  'db:connections:list': { input: projectIdInput, output: z.array(dbConnectionSchema) },
  'db:connections:save': { input: dbConnectionSaveSchema, output: dbConnectionSchema },
  'db:connections:test': { input: dbConnectionSaveSchema, output: z.object({ ok: z.literal(true), version: z.string().optional(), pingMs: z.number().optional() }) },
  'db:connections:delete': { input: z.object({ connectionId: uuid }).strict(), output: z.object({}) },
  'db:connect': { input: z.object({ connectionId: uuid }).strict(), output: z.object({}) },
  'db:session-password': { input: z.object({ connectionId: uuid, password: z.string().max(4096) }).strict(), output: z.object({}) },
  'db:state': { input: z.object({ connectionId: uuid }).strict(), output: z.enum(['disconnected', 'connecting', 'ready', 'lost', 'error']) },
  'db:disconnect': { input: z.object({ connectionId: uuid }).strict(), output: z.object({}) },
  'db:cancel': { input: z.object({ connectionId: uuid, requestId: uuid }).strict(), output: z.object({}) },
  'db:databases': { input: z.object({ connectionId: uuid }).strict(), output: z.array(z.string()) },
  'db:schemas': { input: z.object({ connectionId: uuid, all: z.boolean().optional() }).strict(), output: z.array(z.object({ oid: z.number().int().positive(), name: z.string(), system: z.boolean().optional() })) },
  'db:tables': { input: z.object({ connectionId: uuid, schemaOid: z.number().int().positive().max(4294967295) }).strict(), output: z.array(z.object({ oid: z.number().int().positive(), name: z.string(), kind: z.string() })) },
  'db:describe': { input: z.object({ connectionId: uuid, oid: z.number().int().positive().max(4294967295) }).strict(), output: z.object({ oid: z.number(), schema: z.string(), name: z.string(), ctidAvailable: z.boolean(), estimatedTotal: z.number().nonnegative().nullable().optional(), columns: z.array(z.object({ attnum: z.number(), name: z.string(), typeSql: z.string(), kind: z.enum(['text','number','date','boolean','json','array','enum','uuid','bytea','other']), primaryKey: z.boolean(), nullable: z.boolean().optional(), comment: z.string().nullable().optional(), foreignKeys: z.array(z.string()).optional(), indexes: z.array(z.string()).optional() })) }) },
  'db:page': { input: dbPageInputSchema, output: z.object({ columns: z.array(dbColumnSchema), rows: z.array(z.array(dbCellSchema)), hasMore: z.boolean(), orderedBy: z.enum(['pk', 'user', 'ctid', 'none']), durationMs: z.number().nonnegative() }) },
  'db:apply': { input: dbApplyInputSchema, output: z.object({ sql: z.array(z.string()), applied: z.boolean(), counts: z.array(z.object({ command: z.string(), rowCount: z.number().int().nullable() })), durationMs: z.number().nonnegative() }) },
  'db:count': { input: dbPageInputSchema, output: z.object({ count: z.string(), durationMs: z.number().nonnegative() }) },
  'db:query:run': { input: z.object({ connectionId: uuid, requestId: uuid, sql: z.string().min(1).max(200000), limit: z.number().int().min(1).max(1000), confirmDestructive: z.string().max(255).optional() }).strict(), output: z.object({ columns: z.array(z.string()), rows: z.array(z.array(dbCellSchema)), truncated: z.boolean(), durationMs: z.number().nonnegative(), commands: z.array(z.object({ command: z.string(), rowCount: z.number().int().nullable() })) }) },
  'db:history:list': { input: z.object({ connectionId: uuid }).strict(), output: z.array(z.object({ id: uuid, at: z.string(), kind: z.enum(['table-page','sql','count']), sqlHash: z.string(), durationMs: z.number().nonnegative(), rows: z.number().int().nonnegative(), status: z.enum(['ok','error']), summary: z.string(), sql: z.string().optional() })) },
  'db:history:clear': { input: z.object({ connectionId: uuid }).strict(), output: z.object({}) },
  'notes:list': { input: z.undefined(), output: z.array(noteSchema) },
  'notes:create': { input: createNoteInputSchema, output: noteSchema },
  'notes:delete': { input: deleteNoteInputSchema, output: z.object({ deleted: z.boolean() }) },
  'backups:list': { input: z.undefined(), output: z.array(backupSummarySchema) },
  'backups:create': { input: z.undefined(), output: backupSummarySchema },
  'backups:restore': { input: restoreBackupInputSchema, output: z.object({ restored: z.literal(true) }) }
  , 'settings:get': { input: z.undefined(), output: appSettingsSchema }
  , 'settings:update': { input: updateAppSettingsInputSchema, output: appSettingsSchema }
  , 'profiles:list': { input: z.undefined(), output: z.array(agentProfileSchema) }
  , 'profiles:create': { input: createAgentProfileInputSchema, output: agentProfileSchema }
  , 'profiles:update': { input: z.object({ profileId: uuid, label: z.string().trim().min(1).max(80), scope: z.string().trim().min(1).max(80), color: agentColorSchema.optional(), billingMode: z.enum(['subscription','api','credits','unknown']).optional(), envPassthrough: z.array(z.string().trim().min(1).max(100)).max(50).optional() }).strict(), output: agentProfileSchema }
  , 'profiles:delete': { input: z.object({ profileId: uuid }).strict(), output: z.object({ deleted: z.boolean(), archived: z.boolean() }) }
  , 'profiles:removed': { input: z.undefined(), output: z.array(agentProfileSchema) }
  , 'profiles:disabled': { input: z.undefined(), output: z.array(agentProfileSchema) }
  , 'profiles:set-enabled': { input: z.object({ profileId: uuid, enabled: z.boolean() }).strict(), output: agentProfileSchema }
  , 'profiles:probe': { input: z.object({ profileId: uuid }).strict(), output: agentProbeSchema }
  , 'profiles:probe-all': { input: z.undefined(), output: z.array(agentProbeSchema) }
  , 'profiles:detect-provider': { input: z.object({ provider: z.enum(['codex', 'claude', 'gemini']) }).strict(), output: z.object({ installed: z.boolean(), version: z.string().nullable(), error: z.string().nullable() }) }
  , 'profiles:update-provider': { input: z.object({ provider: z.enum(['codex', 'claude', 'gemini']) }).strict(), output: z.object({ started: z.literal(true) }) }
  , 'profiles:update-terminal': { input: z.object({ provider: z.enum(['codex', 'claude', 'gemini']) }).strict(), output: z.object({ id: z.string().min(1).max(80) }) }
  , 'speckit:availability': { input: projectIdInput, output: z.object({ enabled: z.boolean(), reason: z.string().nullable() }) }
  , 'speckit:state': { input: z.object({ cardId: uuid }).strict(), output: specKitStateSchema }
  , 'speckit:choose': { input: z.object({ cardId: uuid, permission: z.enum(['manual', 'free']) }).strict(), output: specKitStateSchema }
  , 'speckit:request-move': { input: z.object({ cardId: uuid }).strict(), output: specKitStateSchema }
  , 'tools:status': { input: projectIdInput, output: toolsStatusSchema }
  , 'tools:run-terminal': { input: specKitRunInputSchema, output: z.object({ id: z.string() }) }
  , 'tools:spec-compat': { input: z.undefined(), output: specKitCompatSchema }
  , 'tools:probe-spec-kit': { input: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict(), output: specKitProbeResultSchema }
  , 'tools:inspect-folder': { input: z.object({ path: z.string().trim().min(1).max(2048) }).strict(), output: toolsFolderInfoSchema }
  , 'mcp:presets': { input: z.undefined(), output: z.array(mcpPresetSchema) }
  , 'mcp:list': { input: z.object({ projectId: uuid.optional() }).strict(), output: z.array(mcpServerSchema) }
  , 'mcp:save': { input: mcpServerInputSchema, output: mcpServerSchema }
  , 'mcp:detect': { input: z.object({ projectId: uuid }).strict(), output: z.object({ path: z.string().nullable(), servers: z.array(z.object({ name: z.string(), kind: z.enum(['stdio', 'http', 'sse']), exists: z.boolean() })) }) }
  , 'mcp:import': { input: z.object({ scope: z.enum(['global', 'project']), projectId: uuid.optional(), text: z.string().max(200_000).optional(), fromProjectFile: z.boolean().optional() }).strict(), output: z.object({ added: z.array(z.string()), skipped: z.array(z.string()) }) }
  , 'mcp:delete': { input: z.object({ id: uuid }).strict(), output: z.object({ deleted: z.literal(true) }) }
  , 'mcp:set-project-enabled': { input: z.object({ projectId: uuid, id: uuid, enabled: z.boolean() }).strict(), output: z.object({ ok: z.literal(true) }) }
  , 'tools:cached': { input: z.undefined(), output: toolVersionsSchema }
  , 'tools:latest': { input: z.object({ force: z.boolean() }).strict(), output: toolVersionsSchema }
  , 'profiles:install-terminal': { input: z.object({ provider: z.enum(['codex', 'claude', 'gemini']) }).strict(), output: z.object({ id: z.string().min(1).max(80) }) }
  , 'profiles:install-provider': { input: z.object({ provider: z.enum(['codex', 'claude', 'gemini']) }).strict(), output: z.object({ started: z.literal(true) }) }
  , 'profiles:install': { input: z.object({ profileId: uuid }).strict(), output: z.object({ started: z.literal(true) }) }
  , 'profiles:login': { input: z.object({ profileId: uuid }).strict(), output: z.object({ started: z.literal(true) }) }
  , 'profiles:login-terminal': { input: z.object({ profileId: uuid }).strict(), output: z.object({ id: z.string().min(1).max(80) }) }
  , 'projects:list': { input: z.undefined(), output: z.array(projectSchema) }
  , 'projects:create': { input: createProjectInputSchema, output: projectSchema }
  , 'projects:add-repositories': { input: z.object({ projectId: uuid, localPath: z.string().trim().min(1).max(2048) }).strict(), output: projectSchema }
  , 'projects:remove-repository': { input: z.object({ projectId: uuid, sourceId: uuid }).strict(), output: projectSchema }
  , 'projects:update': { input: updateProjectInputSchema, output: projectSchema }
  , 'projects:set-source-base': { input: z.object({ projectId: uuid, sourceId: uuid, branch: z.string().trim().min(1).max(200) }).strict(), output: projectSchema }
  , 'projects:set-base-branch': { input: z.object({ projectId: uuid, sourceId: uuid, branch: z.string().trim().min(1).max(200) }).strict(), output: projectSchema }
  , 'projects:reorder': { input: z.object({ projectIds: z.array(uuid).max(500) }).strict(), output: z.array(projectSchema) }
  , 'projects:delete': { input: projectIdInput, output: z.object({ deleted: z.boolean() }) }
  , 'constitution:get': { input: projectIdInput, output: constitutionStateSchema }
  , 'constitution:save': { input: z.object({ projectId: uuid, contentMd: z.string().max(400_000) }).strict(), output: constitutionStateSchema }
  , 'constitution:import': { input: projectIdInput, output: constitutionStateSchema }
  , 'constitution:set-proposal': { input: z.object({ proposalId: uuid, status: z.enum(['applied', 'dismissed']) }).strict(), output: constitutionStateSchema }
  , 'sdd:config-get': { input: projectIdInput, output: sddConfigSchema }
  , 'sdd:config-set': { input: z.object({ projectId: uuid, config: sddConfigSchema }).strict(), output: sddConfigSchema }
  , 'sdd:locate': { input: z.object({ projectId: uuid, cardId: uuid.nullable() }).strict(), output: sddLocationSchema }
  , 'sdd:detect-constitutions': { input: projectIdInput, output: constitutionMigrationPlanSchema }
  , 'constitution:read': { input: z.object({ projectId: uuid, cardId: uuid.nullable() }).strict(), output: constitutionViewSchema }
  , 'constitution:card-details': { input: z.object({ projectId: uuid, cardId: uuid }).strict(), output: z.object({ location: sddLocationSchema, view: constitutionViewSchema, baseRef: z.string(), baseContent: z.string().nullable(), history: z.string() }) }
  , 'constitution:write': { input: z.object({ projectId: uuid, cardId: uuid, content: z.string().max(400_000), expectBlobSha: z.string().nullable() }).strict(), output: constitutionViewSchema }
  , 'projects:inspect': { input: z.object({ localPath: z.string().trim().min(1).max(2048) }).strict(), output: projectInspectionSchema }
  , 'projects:branches': { input: z.object({ localPath: z.string().trim().min(1).max(2048) }).strict(), output: z.array(z.string()) }
  , 'projects:choose-directory': { input: z.object({ projectId: uuid }).strict().optional(), output: z.string().nullable() }
  , 'projects:set-profiles': { input: setProjectProfilesInputSchema, output: projectSchema }
  /** `types` null: the project goes back to using the default list. */
  , 'projects:set-card-types': { input: z.object({ projectId: uuid, types: cardTypeListSchema.nullable() }).strict(), output: projectSchema }
  , 'card-types:get-default': { input: z.undefined(), output: z.array(cardTypeDefSchema) }
  , 'card-types:set-default': { input: z.object({ types: cardTypeListSchema }).strict(), output: z.array(cardTypeDefSchema) }
  /** How many cards (including archived) use each type: in the project, or in the projects that follow the default list. */
  , 'card-types:usage': { input: z.object({ projectId: uuid.optional() }).strict(), output: z.record(z.string(), z.number().int().nonnegative()) }
  , 'board:get': { input: projectIdInput, output: projectBoardSchema }
  , 'cards:create': { input: createCardInputSchema, output: cardSchema }
  , 'cards:update': { input: updateCardInputSchema, output: cardSchema }
  , 'cards:move': { input: moveCardInputSchema, output: cardSchema }
  , 'cards:archive': { input: cardIdInput, output: cardSchema }
  , 'cards:finalize': { input: cardIdInput, output: cardSchema }
  , 'cards:restore': { input: cardIdInput, output: cardSchema }
  , 'cards:get': { input: cardIdInput, output: cardSchema }
  , 'cards:documents': { input: cardIdInput, output: cardDocumentsSchema }
  , 'cards:write-document': { input: z.object({ cardId: uuid, kind: cardDocumentKindSchema, contentMd: z.string().max(200_000) }).strict(), output: cardDocumentSchema }
  , 'cards:document-versions': { input: z.object({ cardId: uuid, kind: cardDocumentKindSchema }).strict(), output: z.array(documentVersionSchema) }
  , 'cards:toggle-task': { input: z.object({ cardId: uuid, line: z.number().int().nonnegative(), checked: z.boolean() }).strict(), output: cardDocumentSchema }
  , 'cards:start': { input: z.object({ cardId: uuid, config: agentConfigSchema, purpose: z.enum(['execution', 'test']).optional(), baseBranch: z.string().trim().min(1).max(200).optional(), replaceAgent: z.boolean().optional() }).strict(), output: runSchema }
  , 'cards:set-base-branch': { input: z.object({ cardId: uuid, branch: z.string().trim().min(1).max(200) }).strict(), output: z.object({ branch: z.string() }) }
  , 'cards:branches': { input: cardIdInput, output: z.object({ branches: z.array(z.string()), current: z.string().nullable(), selected: z.string().nullable(), locked: z.boolean() }) }
  , 'cards:resume': { input: z.object({ cardId: uuid, purpose: z.enum(['execution', 'test']).optional() }).strict(), output: runSchema }
  , 'chats:reset': { input: z.object({ chatId: uuid }).strict(), output: z.object({ reset: z.literal(true) }) }
  , 'chats:delete': { input: z.object({ chatId: uuid }).strict(), output: z.object({ deleted: z.literal(true) }) }
  , 'usage:refresh': { input: z.undefined(), output: z.array(agentUsageSchema) }
  , 'cards:mark-viewed': { input: cardIdInput, output: cardSchema }
  , 'agents:options': { input: z.object({ profileId: uuid }).strict(), output: agentOptionsSchema }
  , 'cards:agent-config': { input: cardIdInput, output: cardAgentsSchema }
  , 'cards:set-agent-config': { input: z.object({ cardId: uuid, purpose: agentPurposeSchema, config: agentConfigSchema }).strict(), output: cardAgentsSchema }
  , 'skills:list': { input: z.object({ scope: skillScopeSchema, projectId: uuid.optional() }).strict(), output: z.array(skillEntrySchema) }
  , 'skills:choose-source': { input: z.undefined(), output: z.string().nullable() }
  , 'skills:choose-folder': { input: z.undefined(), output: z.string().nullable() }
  , 'skills:delete': { input: z.object({ scope: skillScopeSchema, projectId: uuid.optional(), name: z.string().trim().min(1).max(64), provider: agentProviderSchema.optional() }).strict(), output: z.array(skillEntrySchema) }
  , 'skills:import-folder': { input: z.object({ scope: skillScopeSchema, projectId: uuid.optional(), folderPath: z.string().trim().min(1).max(2048), provider: agentProviderSchema }).strict(), output: z.object({ imported: z.array(z.string()), skipped: z.array(z.string()), skills: z.array(skillEntrySchema) }) }
  , 'skills:import': { input: z.object({ scope: skillScopeSchema, projectId: uuid.optional(), sourcePath: z.string().trim().min(1).max(2048), name: z.string().trim().min(1).max(64), provider: agentProviderSchema }).strict(), output: z.array(skillEntrySchema) }
  , 'skills:convert': { input: z.object({ scope: skillScopeSchema, projectId: uuid.optional(), name: z.string().trim().min(1).max(64), from: agentProviderSchema, to: agentProviderSchema, reviewProfileId: uuid.optional(), model: z.string().max(120).nullable().optional() }).strict(), output: z.object({ converted: z.literal(true), reviewing: z.boolean() }) }
  , 'chats:set-skill': { input: z.object({ chatId: uuid, skill: skillRefSchema.nullable() }).strict(), output: chatSchema }
  , 'voice:status': { input: z.undefined(), output: voiceStatusSchema }
  , 'voice:install': { input: z.undefined(), output: voiceStatusSchema }
  , 'voice:set-key': { input: z.object({ key: z.string().trim().max(200) }).strict(), output: voiceStatusSchema }
  , 'voice:transcribe': { input: z.object({ wav: z.instanceof(Uint8Array).refine((value) => value.byteLength <= 12 * 1024 * 1024, 'Gravação longa demais'), prompt: z.string().max(400).optional() }).strict(), output: z.object({ text: z.string() }) }
  , 'usage:list': { input: z.undefined(), output: z.array(agentUsageSchema) }
  , 'usage:history': { input: z.object({ granularity: z.enum(['day','week','month']), tz: z.string().min(1).max(100), groupBy: z.enum(['provider','profile','model','project','card','purpose']), from: isoDate.optional(), to: isoDate.optional() }).strict(), output: z.array(usageHistoryRowSchema) }
  , 'usage:export': { input: z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict(), output: z.object({ csv: z.string() }) }
  , 'usage:purge-request': { input: z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict(), output: approvalSchema }
  , 'usage:purge': { input: z.object({ from: isoDate.optional(), to: isoDate.optional(), approvalId: uuid }).strict(), output: z.object({ deleted: z.number().int().nonnegative(), csv: z.string() }) }
  , 'usage:save-csv': { input: z.object({ content: z.string().max(50_000_000), defaultName: z.string().trim().min(1).max(200) }).strict(), output: z.object({ saved: z.boolean(), path: z.string().nullable() }) }
  , 'cards:usage': { input: cardIdInput, output: cardUsageSchema }
  , 'cards:checklist': { input: cardIdInput, output: cardChecklistSchema }
  , 'cards:checklist-toggle': { input: z.object({ cardId: uuid, line: z.number().int().min(0).max(100_000), text: z.string().min(1).max(2000), checked: z.boolean() }).strict(), output: cardChecklistSchema }
  , 'code-index:symbols': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(200).optional() }).strict(), output: z.array(codeSymbolSchema) }
  , 'code-index:outline': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(4096) }).strict(), output: z.array(codeSymbolSchema.extend({ depth: z.number().int().nonnegative() })) }
  , 'code-index:definition': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), name: z.string().trim().min(1).max(200), path: z.string().min(1).max(4096).optional() }).strict(), output: z.array(codeSymbolSchema) }
  , 'code-index:references': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), name: z.string().trim().min(1).max(200), path: z.string().min(1).max(4096).optional() }).strict(), output: z.array(z.object({ path: z.string(), relative: z.string(), line: z.number().int(), caller: z.string() })) }
  , 'code-index:status': { input: z.object({ projectId: uuid, cardId: uuid.nullable() }).strict(), output: codeIndexStatusSchema }
  , 'code-index:set-enabled': { input: z.object({ projectId: uuid, enabled: z.boolean() }).strict(), output: codeIndexStatusSchema }
  , 'code-index:reindex': { input: z.object({ projectId: uuid, root: z.string().min(1).max(4096).optional() }).strict(), output: codeIndexStatusSchema }
  , 'files:read': { input: z.object({ chatId: uuid, path: z.string().trim().min(1).max(2048) }).strict(), output: z.object({ path: z.string(), relative: z.string(), content: z.string(), truncated: z.boolean(), size: z.number(), binary: z.boolean() }) }
  , 'workspace:roots': { input: z.object({ projectId: uuid, cardId: uuid.nullable() }).strict(), output: z.array(z.object({ path: z.string(), name: z.string(), branch: z.string().nullable(), worktree: z.boolean(), primary: z.boolean(), cardId: uuid.nullable(), cardTitle: z.string().nullable() })) }
  , 'workspace:external': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(4096), target: z.enum(['explorer', 'default', 'vscode']) }).strict(), output: z.object({}) }
  , 'workspace:comment': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), text: z.string().min(1).max(100_000) }).strict(), output: z.object({}) }
  , 'workspace:attach': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(4096) }).strict(), output: z.object({}) }
  , 'workspace:terminal': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(4096) }).strict(), output: z.object({ id: uuid, cwd: z.string(), shell: z.string() }) }
  , 'workspace:image': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(4096) }).strict(), output: z.string() }
  , 'workspace:list': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(4096) }).strict(), output: z.array(z.object({ path: z.string(), name: z.string(), directory: z.boolean() })) }
  , 'workspace:resolve-references': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), markdownPath: z.string().max(4096).optional(), targets: z.array(z.string().min(1).max(4096)).max(200) }).strict(), output: z.array(z.object({ target: z.string(), path: z.string(), directory: z.boolean() })) }
  , 'workspace:search': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), query: z.string().min(1).max(200), fuzzy: z.boolean().optional() }).strict(), output: z.object({ paths: z.array(z.string()), limited: z.boolean() }) }
  , 'workspace:read': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(4096) }).strict(), output: z.object({ path: z.string(), relative: z.string(), content: z.string(), truncated: z.boolean(), size: z.number(), binary: z.boolean() }) }
  , 'workspace:write': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(4096), content: z.string().max(1_000_000), expected: z.string().max(1_000_000) }).strict(), output: z.object({ path: z.string(), relative: z.string(), content: z.string(), truncated: z.boolean(), size: z.number(), binary: z.boolean() }) }
  , 'workspace:watch': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), watchId: z.string().min(1).max(100), paths: z.array(z.string().min(1).max(4096)).max(200) }).strict(), output: z.object({}).strict() }
  , 'workspace:create': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), parent: z.string().min(1).max(4096), name: z.string().min(1).max(1024), kind: z.enum(['file', 'folder']) }).strict(), output: z.object({ path: z.string() }) }
  , 'workspace:rename': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(4096), name: z.string().min(1).max(255) }).strict(), output: z.object({ path: z.string() }) }
  , 'workspace:trash': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(4096) }).strict(), output: z.object({}).strict() }
  , 'workspace:grep': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), query: z.string().min(1).max(500), caseSensitive: z.boolean(), wholeWord: z.boolean(), regex: z.boolean(), include: z.string().max(500).optional() }).strict(), output: z.object({ results: z.array(z.object({ path: z.string(), root: z.string(), line: z.number(), column: z.number(), preview: z.string(), matchStart: z.number(), matchEnd: z.number() })), limited: z.boolean() }) }
  , 'workspace:save-image': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), markdownPath: z.string().min(1).max(4096), data: z.string().min(1).max(14_000_000), mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']) }).strict(), output: z.object({ path: z.string(), relative: z.string() }) }
  , 'workspace:versions': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(4096) }).strict(), output: z.object({ path: z.string(), relative: z.string(), root: z.string(), before: z.string().nullable(), after: z.string().nullable(), baseLabel: z.string(), binary: z.boolean(), truncated: z.boolean() }) }
  , 'collab:list': { input: cardIdInput, output: collaborationSchema }
  , 'collab:send-change': { input: z.object({ changeId: uuid }).strict(), output: collaborationSchema }
  , 'collab:send-test-failures': { input: cardIdInput, output: collaborationSchema }
  , 'collab:decide-change': { input: z.object({ changeId: uuid, decision: z.enum(['accept', 'reject', 'suggest']), note: z.string().trim().max(4000).optional() }).strict(), output: collaborationSchema }
  , 'collab:answer-question': { input: z.object({ questionId: uuid, answer: z.string().trim().min(1).max(8000) }).strict(), output: collaborationSchema }
  , 'cards:delete': { input: z.object({ cardId: uuid, deleteArtifacts: z.boolean().optional() }).strict(), output: z.object({ deleted: z.boolean() }) }
  , 'cards:set-repos': { input: z.object({ cardId: uuid, sourceIds: z.array(uuid).max(50).nullable() }).strict(), output: cardSchema }
  , 'git:create-prs': { input: z.object({ cardId: uuid, draft: z.boolean().default(true), title: z.string().trim().max(240).optional(), body: z.string().max(20_000).optional(), sourceId: uuid.optional() }).strict(), output: z.object({ results: z.array(z.object({ repo: z.string(), url: z.string().nullable(), error: z.string().nullable() })) }) }
  , 'git-accounts:state': { input: z.object({ projectId: uuid }).strict(), output: gitAccountsStateSchema }
  , 'git-accounts:set': { input: z.object({ projectId: uuid, sourceId: uuid.optional(), provider: z.enum(['github', 'gitlab']), host: z.string().trim().min(1).max(253).regex(/^[a-z0-9.-]+(:[0-9]{1,5})?$/i), token: z.string().trim().min(1).max(500) }).strict(), output: gitAccountsStateSchema }
  , 'git-accounts:remove': { input: z.object({ projectId: uuid, sourceId: uuid.optional(), host: z.string().trim().min(1).max(253) }).strict(), output: gitAccountsStateSchema }
  , 'prs:list': { input: z.object({ sourceId: uuid, state: z.enum(['open', 'merged', 'closed', 'all']).optional(), page: z.number().int().min(1).max(200).optional() }).strict(), output: pullRequestListSchema }
  , 'prs:checks': { input: z.object({ sourceId: uuid, numbers: z.array(z.number().int().positive()).min(1).max(20) }).strict(), output: z.object({ checks: z.array(z.object({ number: z.number().int(), status: prPipelineStatusSchema, approvals: z.number().int().nonnegative().nullable().default(null) })) }) }
  , 'prs:commits': { input: z.object({ sourceId: uuid, number: z.number().int().positive() }).strict(), output: z.object({ commits: z.array(prCommitSchema).max(250) }) }
  , 'prs:pipelines': { input: z.object({ sourceId: uuid, number: z.number().int().positive() }).strict(), output: z.object({ pipelines: z.array(prPipelineSchema).max(10), canAct: z.boolean() }) }
  , 'prs:job-log': { input: z.object({ sourceId: uuid, number: z.number().int().positive(), jobId: z.string().regex(/^\d{1,20}$/) }).strict(), output: z.object({ text: z.string(), truncated: z.boolean() }) }
  , 'prs:pipeline-action': { input: z.object({ sourceId: uuid, number: z.number().int().positive(), pipelineId: z.string().regex(/^\d{1,20}$/), action: z.enum(['cancel', 'retry']) }).strict(), output: z.object({}) }
  , 'prs:job-action': { input: z.object({ sourceId: uuid, number: z.number().int().positive(), jobId: z.string().regex(/^\d{1,20}$/), action: z.enum(['cancel', 'retry']) }).strict(), output: z.object({}) }
  , 'prs:versions': { input: z.object({ sourceId: uuid, number: z.number().int().positive() }).strict(), output: z.object({ versions: z.array(prVersionSchema).max(100) }) }
  , 'prs:version-diff': { input: z.object({ sourceId: uuid, number: z.number().int().positive(), versionId: z.string().regex(/^\d{1,20}$/) }).strict(), output: z.object({ diff: z.string(), files: z.array(prFileSchema), headSha: z.string().nullable(), baseSha: z.string().nullable(), startSha: z.string().nullable() }) }
  , 'prs:unapprove': { input: z.object({ sourceId: uuid, number: z.number().int().positive() }).strict(), output: z.object({}) }
  /** Edits the PR/MR (only the fields given), marks/unmarks it as draft, or closes/reopens it (`state`). */
  , 'prs:update': { input: z.object({ sourceId: uuid, number: z.number().int().positive(), title: z.string().trim().min(1).max(240).optional(), body: z.string().max(20_000).optional(), base: z.string().min(1).max(250).refine((v) => !v.startsWith('-')).optional(), draft: z.boolean().optional(),
    assignees: z.array(z.string().min(1).max(100)).max(20).optional(), reviewers: z.array(z.string().min(1).max(100)).max(20).optional(), milestone: z.string().max(40).nullable().optional(), labels: z.array(z.string().min(1).max(255)).max(50).optional(),
    squash: z.boolean().optional(), deleteSourceBranch: z.boolean().optional(), state: z.enum(['close', 'reopen']).optional() }).strict(), output: z.object({ warning: z.string().nullable() }) }
  , 'prs:resolve': { input: z.object({ sourceId: uuid, number: z.number().int().positive(), threadId: z.string().min(1).max(200), resolved: z.boolean() }).strict(), output: z.object({}) }
  , 'prs:create-options': { input: z.object({ sourceId: uuid }).strict(), output: prCreateOptionsSchema }
  , 'prs:compare': { input: z.object({ sourceId: uuid, head: z.string().min(1).max(250).refine((v) => !v.startsWith('-')), base: z.string().min(1).max(250).refine((v) => !v.startsWith('-')) }).strict(), output: prCompareSchema }
  , 'prs:upload': { input: z.object({ sourceId: uuid, name: z.string().min(1).max(255).refine((v) => !/[\\/]/.test(v)), dataBase64: z.string().max(14_000_000) }).strict(), output: z.object({ markdown: z.string() }) }
  , 'prs:line-comment': { input: z.object({ sourceId: uuid, number: z.number().int().positive(), body: z.string().trim().min(1).max(20_000), path: prPath, oldPath: prPath, headSha: prSha, baseSha: prSha.nullable(), startSha: prSha.nullable(), start: prPoint, end: prPoint }).strict(), output: prThreadSchema }
  , 'prs:reply': { input: z.object({ sourceId: uuid, number: z.number().int().positive(), threadId: z.string().min(1).max(200), body: z.string().trim().min(1).max(20_000), resolve: z.boolean().optional() }).strict(), output: prThreadCommentSchema }
  /** Edits, deletes or reacts (👍/👎, toggled) to one comment. */
  , 'prs:note': { input: z.object({ sourceId: uuid, number: z.number().int().positive(), kind: z.enum(['note', 'review', 'issue']), id: z.string().regex(/^\d{1,20}$/), action: z.enum(['edit', 'delete', 'react']), body: z.string().trim().min(1).max(20_000).optional(), reaction: z.enum(['up', 'down']).optional() }).strict(), output: z.object({ body: z.string().optional(), reactions: prReactionsSchema.optional() }) }
  , 'prs:react': { input: z.object({ sourceId: uuid, number: z.number().int().positive(), kind: z.enum(['up', 'down']) }).strict(), output: prReactionsSchema }
  , 'prs:merge': { input: z.object({ sourceId: uuid, number: z.number().int().positive(), method: prMergeMethodSchema, deleteSourceBranch: z.boolean(), message: z.string().max(20_000).nullable() }).strict(), output: z.object({ merged: z.literal(true), branchDeleted: z.boolean(), warning: z.string().nullable() }) }
  , 'prs:default-base': { input: z.object({ sourceId: uuid }).strict(), output: z.object({ branch: z.string().nullable() }) }
  , 'prs:view': { input: z.object({ sourceId: uuid, number: z.number().int().positive() }).strict(), output: pullRequestDetailSchema }
  , 'prs:comment': { input: z.object({ sourceId: uuid, number: z.number().int().positive(), body: z.string().trim().min(1).max(20_000) }).strict(), output: z.object({}) }
  , 'prs:review': { input: z.object({ sourceId: uuid, number: z.number().int().positive(), action: z.enum(['approve', 'request-changes', 'comment']), body: z.string().max(20_000) }).strict(), output: z.object({}) }
  , 'prs:create': { input: z.object({ sourceId: uuid, head: z.string().min(1).max(250).refine((v) => !v.startsWith('-')), base: z.string().min(1).max(250).refine((v) => !v.startsWith('-')), title: z.string().trim().min(1).max(240), body: z.string().max(20_000), draft: z.boolean(), squash: z.boolean().optional(),
    assignees: z.array(z.string().min(1).max(100)).max(20).optional(), reviewers: z.array(z.string().min(1).max(100)).max(20).optional(), milestone: z.string().max(40).nullable().optional(), labels: z.array(z.string().min(1).max(255)).max(50).optional(), deleteSourceBranch: z.boolean().optional() }).strict(), output: z.object({ url: z.string(), number: z.number().int().positive().nullable().default(null), warning: z.string().nullable().default(null) }) }
  , 'prs:open': { input: z.object({ sourceId: uuid, url: z.string().url().max(2000) }).strict(), output: z.object({ opened: z.literal(true) }) }
  , 'git:open-pr': { input: z.object({ cardId: uuid, url: z.string().url().max(2000) }).strict(), output: z.object({ opened: z.literal(true) }) }
  , 'playwright:sources': { input: projectIdInput, output: z.array(z.object({ id: uuid, name: z.string(), node: z.boolean() })) }
  , 'playwright:versions': { input: z.undefined(), output: z.array(z.string()) }
  , 'playwright:status': { input: projectIdInput, output: playwrightStatusSchema }
  , 'playwright:install-browser': { input: projectIdInput, output: playwrightStatusSchema }
  , 'playwright:install': { input: z.object({ projectId: uuid, version: z.string().trim().min(1).max(40), browser: z.boolean(), skills: z.array(z.enum(['claude', 'agents'])).max(2), sourceId: uuid.optional() }).strict(), output: playwrightStatusSchema }
  , 'playwright:select': { input: z.object({ projectId: uuid, version: z.string().trim().min(1).max(40) }).strict(), output: playwrightStatusSchema }
  , 'playwright:remove': { input: z.object({ projectId: uuid, version: z.string().trim().min(1).max(40) }).strict(), output: playwrightStatusSchema }
  , 'history:get': { input: cardIdInput, output: cardHistorySchema }
  , 'history:contest': { input: contestAssessmentInputSchema, output: cardHistorySchema }
  , 'history:select-workflow': { input: z.object({ cardId: uuid, workflow: workflowKindSchema, method: cardSddMethodSchema.optional(), reason: z.string().trim().max(4000).optional() }).strict(), output: cardHistorySchema }
  , 'history:add-decision': { input: z.object({ cardId: uuid, kind: decisionKindSchema, statement: z.string().trim().min(1).max(4000), rationale: z.string().trim().max(4000).optional() }).strict(), output: cardHistorySchema }
  , 'history:set-decision': { input: z.object({ decisionId: uuid, status: z.enum(['approved', 'superseded']) }).strict(), output: cardHistorySchema }
  , 'history:rebuild': { input: cardIdInput, output: z.object({ events: z.number().int().nonnegative(), assessments: z.number().int().nonnegative(), decisions: z.number().int().nonnegative() }) }
  , 'history:open-folder': { input: cardIdInput, output: z.object({ path: z.string() }) }
  , 'git:file-read': { input: z.object({ sourceId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(2048) }).strict(), output: z.object({ content: z.string() }) }
  , 'git:file-path': { input: z.object({ sourceId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(2048) }).strict(), output: z.object({ projectId: uuid, path: z.string() }) }
  , 'git:file-write': { input: z.object({ sourceId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(2048), content: z.string().max(2_000_000) }).strict(), output: z.object({}) }
  , 'terminal:open': { input: z.object({ projectId: uuid.nullable(), cardId: uuid.nullable() }).strict(), output: z.object({ id: z.string(), cwd: z.string(), shell: z.string() }) }
  , 'terminal:info': { input: z.object({ id: z.string().min(1).max(80) }).strict(), output: z.object({ id: z.string(), cwd: z.string(), shell: z.string(), text: z.string(), seq: z.number(), exited: z.boolean() }) }
  , 'terminal:resize': { input: z.object({ id: z.string().min(1).max(80), cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(1000) }).strict(), output: z.object({}) }
  , 'terminal:write': { input: z.object({ id: z.string().min(1).max(80), data: z.string().max(200_000) }).strict(), output: z.object({}) }
  , 'terminal:kill': { input: z.object({ id: z.string().min(1).max(80) }).strict(), output: z.object({}) }
  , 'windows:open': { input: z.object({ kind: z.enum(['board', 'chats', 'git', 'db', 'chat', 'files', 'file', 'terminal']), projectId: uuid, cardId: uuid.optional(), chatId: uuid.optional(), terminalId: z.string().min(1).max(80).optional(), path: z.string().max(4096).optional(), paths: z.array(z.string().min(1).max(4096)).max(50).optional(), purpose: agentPurposeSchema.optional(), placement: z.enum(['new', 'left', 'right', 'top', 'bottom', 'fill', 'second']), x: z.number().int().min(-100000).max(100000).optional(), y: z.number().int().min(-100000).max(100000).optional() }).strict(), output: z.object({}) }
  , 'windows:return-file': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), path: z.string().min(1).max(4096) }).strict(), output: z.object({}) }
  , 'windows:place': { input: z.object({ placement: z.enum(['new', 'left', 'right', 'top', 'bottom', 'fill']) }).strict(), output: z.object({}) }
  , 'metrics:card': { input: cardIdInput, output: z.array(runMetricSchema) }
  , 'workflow:get': { input: projectIdInput, output: workflowState }
  , 'workflow:open-path': { input: z.object({ projectId: uuid, which: z.enum(['artifacts', 'sdd']) }).strict(), output: z.object({ path: z.string() }) }
  , 'workflow:set': { input: z.object({ projectId: uuid, config: workflowConfigSchema }).strict(), output: workflowState }
  , 'chats:background': { input: z.object({ chatId: uuid }).strict(), output: z.array(backgroundTaskSchema) }
  , 'chats:list': { input: projectIdInput.extend({ cardId: uuid.nullable().optional() }).strict(), output: z.array(chatSchema) }
  , 'chats:create': { input: z.object({ projectId: uuid, cardId: uuid.nullable(), purpose: chatPurposeSchema, profileId: uuid, skill: skillRefSchema.nullable().optional() }).strict(), output: chatSchema }
  , 'messages:list': { input: z.object({ chatId: uuid }).strict(), output: z.array(chatMessageSchema) }
  , 'runs:live': { input: z.object({ chatId: uuid }).strict(), output: z.object({ runId: uuid, text: z.string(), seq: z.number().int() }).nullable() }
  , 'agents:permissions': { input: z.object({ chatId: uuid }).strict(), output: z.array(agentPermissionSchema) }
  , 'agents:permission-decide': { input: z.object({ runId: uuid, requestId: uuid, allow: z.boolean(), always: z.boolean().optional() }).strict(), output: z.object({ decided: z.boolean() }) }
  , 'agents:permission-auto': { input: z.object({ chatId: uuid }).strict(), output: z.object({ enabled: z.boolean() }) }
  , 'agents:permission-auto-off': { input: z.object({ chatId: uuid }).strict(), output: z.object({ enabled: z.boolean() }) }
  , 'agents:start': { input: z.object({ chatId: uuid, prompt: z.string().trim().min(1).max(100_000), planning: z.boolean(), attachments: z.array(z.string().min(1).max(2048)).max(20).optional(), choice: z.object({ model: z.string().trim().max(120).nullable().optional(), effort: effortSchema.nullable().optional(), mode: permissionModeSchema.optional() }).strict().optional() }).strict(), output: runSchema }
  , 'files:preview': { input: z.object({ path: z.string() }), output: z.string().nullable() }
  , 'files:open': { input: z.object({ path: z.string().max(2048) }).strict(), output: z.object({ opened: z.literal(true) }) }
  , 'files:choose': { input: z.undefined(), output: z.array(z.string()) }
  , 'files:save-pasted': { input: z.object({ name: z.string().max(200), base64: z.string().max(40_000_000) }).strict(), output: z.string() }
  , 'agents:cancel': { input: z.object({ runId: uuid }).strict(), output: z.object({ cancelled: z.boolean() }) }
  , 'agents:run-now': { input: z.object({ runId: uuid }).strict(), output: z.object({ started: z.boolean() }) }
  , 'agents:capacity': { input: z.undefined(), output: runCapacitySchema }
  , 'plans:list': { input: cardIdInput, output: z.array(planSchema) }
  , 'plans:approve': { input: z.object({ planId: uuid }).strict(), output: planSchema }
  , 'worktrees:get': { input: cardIdInput, output: worktreeSchema.nullable() }
  , 'worktrees:prepare': { input: cardIdInput, output: worktreeSchema }
  , 'worktrees:snapshot': { input: cardIdInput, output: gitSnapshotSchema }
  , 'worktrees:candidates': { input: cardIdInput, output: z.array(z.object({ cardId: uuid, title: z.string(), branch: z.string(), path: z.string() })) }
  , 'worktrees:options': { input: z.object({ projectId: uuid }).strict(), output: z.object({ cards: z.array(z.object({ cardId: uuid, title: z.string(), branch: z.string(), path: z.string() })), external: z.array(z.object({ path: z.string(), repoPath: z.string(), repoName: z.string(), branch: z.string().nullable() })) }) }
  , 'git:external-worktree-open': { input: z.object({ projectId: uuid, path: z.string().min(1).max(2048), target: z.enum(['folder', 'vscode']) }).strict(), output: z.object({ opened: z.literal(true) }) }
  , 'worktrees:adopt': { input: z.object({ cardId: uuid, path: z.string().min(1).max(2048) }).strict(), output: z.object({}) }
  , 'worktrees:link': { input: z.object({ cardId: uuid, fromCardId: uuid.nullable() }).strict(), output: z.object({}) }
  , 'tests:run': { input: z.object({ cardId: uuid, executable: z.string().min(1).max(2048), args: z.array(z.string().max(4096)).max(100) }).strict(), output: testRunSchema }
  , 'tests:run-card': { input: cardIdInput, output: testRunSchema }
  , 'tests:plan': { input: cardIdInput, output: z.object({ repos: z.array(z.object({ name: z.string(), label: z.string(), command: z.string(), changed: z.boolean() })), fallback: z.string() }) }
  , 'tests:repo-commands': { input: projectIdInput, output: z.array(repoTestCommandSchema) }
  , 'tests:set-repo-command': { input: z.object({ projectId: uuid, sourceId: uuid, command: z.string().max(2048), name: z.string().max(60), applicable: z.boolean() }).strict(), output: z.array(repoTestCommandSchema) }
  , 'tests:detect-command': { input: cardIdInput, output: z.object({ command: z.string() }) }
  , 'tests:command': { input: projectIdInput, output: z.object({ command: z.string(), name: z.string() }) }
  , 'tests:set-command': { input: z.object({ projectId: uuid, command: z.string().max(2048), name: z.string().max(60).optional() }).strict(), output: z.object({ command: z.string(), name: z.string() }) }
  , 'quality:status': { input: cardIdInput, output: z.object({ test: testRunSchema.nullable(), review: reviewSchema.nullable() }) }
  , 'reviews:prepare-local': { input: cardIdInput, output: reviewSchema }
  , 'reviews:approve-local': { input: z.object({ reviewId: uuid }).strict(), output: reviewSchema }
  , 'git:repos': { input: z.object({ projectId: uuid }).strict(), output: z.array(gitRepoSchema) }
  , 'git:worktree-info': { input: z.object({ projectId: uuid.optional(), cardId: uuid, sourceId: uuid.optional() }).strict(), output: gitWorktreeInfoSchema }
  , 'git:worktree-delete': { input: z.object({ projectId: uuid.optional(), cardId: uuid, sourceId: uuid.optional(), deleteBranch: z.boolean(), force: z.boolean().optional() }).strict(), output: z.object({ output: z.string(), keptBranches: z.array(z.string()) }) }
  , 'git:external-worktree-info': { input: z.object({ sourceId: uuid, path: z.string().min(1).max(4000) }).strict(), output: z.object({ path: z.string(), branch: z.string().nullable(), files: z.number(), unpushed: z.number() }) }
  , 'git:external-worktree-delete': { input: z.object({ sourceId: uuid, path: z.string().min(1).max(4000), deleteBranch: z.boolean() }).strict(), output: z.object({ output: z.string(), keptBranches: z.array(z.string()) }) }
  , 'git:upstream': { input: z.object({ sourceId: uuid, cardId: uuid.nullable() }).strict(), output: z.object({ branch: z.string().nullable(), upstream: z.string().nullable(), remotes: z.array(z.string()) }) }
  , 'git:set-upstream': { input: z.object({ sourceId: uuid, cardId: uuid.nullable(), remote: z.string().min(1).max(100), branch: z.string().min(1).max(250) }).strict(), output: z.object({ upstream: z.string() }) }
  , 'git:detect': { input: z.object({ projectId: uuid }).strict(), output: z.object({ repos: z.array(gitRepoSchema), changed: z.boolean() }) }
  , 'git:setup-targets': { input: z.object({ projectId: uuid }).strict(), output: z.array(z.object({ sourceId: uuid, name: z.string(), path: z.string() })) }
  , 'git:setup': { input: z.object({ projectId: uuid, sourceId: uuid, mode: z.enum(['init', 'origin']), url: z.string().trim().max(500).optional() }).strict(), output: z.array(gitRepoSchema) }
  , 'git:graph': { input: z.object({ projectId: uuid, sourceId: uuid, cardId: uuid.nullable().optional(), limit: z.number().int().min(20).max(20000).optional() }).strict(), output: gitGraphSchema }
  , 'git:commit-detail': { input: z.object({ sourceId: uuid, hash: z.string().regex(/^[0-9a-f]{7,64}$/) }).strict(), output: z.object({ body: z.string(), files: z.array(gitCommitFileSchema) }) }
  , 'git:changes': { input: z.object(gitTarget).strict(), output: gitChangesSchema }
  , 'git:commit-diff': { input: z.object({ sourceId: uuid, hash: z.string().regex(/^[0-9a-f]{7,64}$/), path: z.string().min(1).max(4096) }).strict(), output: z.string() }
  , 'git:diff': { input: z.object({ ...gitTarget, path: z.string().min(1).max(4096), staged: z.boolean() }).strict(), output: z.string() }
  , 'git:stage': { input: z.object({ ...gitTarget, paths: z.array(z.string().min(1).max(4096)).max(5000), stage: z.boolean() }).strict(), output: gitChangesSchema }
  , 'git:discard-unstaged': { input: z.object({ ...gitTarget, paths: z.array(z.string().min(1).max(4096)).min(1).max(5000) }).strict(), output: gitChangesSchema }
  , 'git:stash-file': { input: z.object({ ...gitTarget, path: z.string().min(1).max(4096) }).strict(), output: gitChangesSchema }
  , 'git:ignore-file': { input: z.object({ ...gitTarget, path: z.string().min(1).max(4096), kind: z.enum(['file', 'directory', 'extension']) }).strict(), output: gitChangesSchema }
  , 'git:commit': { input: z.object({ ...gitTarget, message: z.string().max(2000), description: z.string().max(20_000).optional(), amend: z.boolean().optional(), paths: z.array(z.string().min(1).max(4096)).max(5000).optional() }).strict(), output: z.object({ hash: z.string() }) }
  , 'git:suggest-message': { input: z.object({ ...gitTarget, paths: z.array(z.string().min(1).max(4096)).max(5000).optional() }).strict(), output: z.object({ message: z.string() }) }
  , 'git:rename-commit': { input: z.object({ ...gitTarget, hash: z.string().regex(/^[0-9a-f]{40,64}$/), message: z.string().trim().min(1).max(2000) }).strict(), output: z.object({ hash: z.string() }) }
  , 'git:branch-action': { input: z.object({ sourceId: uuid, cardId: uuid.nullable().optional(), action: z.enum(['checkout', 'pull', 'pull-rebase', 'push', 'rebase-onto', 'merge', 'create', 'rename', 'delete', 'delete-remote']), name: z.string().min(1).max(250), newName: z.string().max(250).optional(), force: z.boolean().optional() }).strict(), output: z.object({ output: z.string() }) }
  , 'git:checkout-remote': { input: z.object({ ...gitTarget, name: z.string().min(1).max(250) }).strict(), output: z.object({ output: z.string() }) }
  , 'git:commit-action': { input: z.object({ sourceId: uuid, cardId: uuid.nullable().optional(), action: z.enum(['checkout', 'cherry-pick', 'revert', 'rebase', 'reset-soft', 'reset-mixed', 'reset-hard', 'branch', 'tag']), hash: z.string().regex(/^[0-9a-f]{7,64}$/), name: z.string().max(250).optional() }).strict(), output: z.object({ output: z.string() }) }
  , 'git:stash-action': { input: z.object({ sourceId: uuid, cardId: uuid.nullable().optional(), action: z.enum(['apply', 'pop', 'drop']), ref: z.string().regex(/^stash@\{\d+\}$/) }).strict(), output: z.object({ output: z.string(), conflicts: z.number().int().nonnegative().optional() }) }
  , 'git:undo-state': { input: z.object({ sourceId: uuid, cardId: uuid.nullable().optional() }).strict(), output: z.object({ undo: z.object({ label: z.string() }).nullable(), redo: z.object({ label: z.string() }).nullable() }) }
  , 'git:undo': { input: z.object({ sourceId: uuid, cardId: uuid.nullable().optional() }).strict(), output: z.object({ output: z.string() }) }
  , 'git:redo': { input: z.object({ sourceId: uuid, cardId: uuid.nullable().optional() }).strict(), output: z.object({ output: z.string() }) }
  , 'git:stash-detail': { input: z.object({ ...gitTarget, ref: z.string().regex(/^stash@\{\d+\}$/), commit: z.string().regex(/^[0-9a-f]{40,64}$/) }).strict(), output: z.object({ files: z.array(gitCommitFileSchema) }) }
  , 'git:stash-rename': { input: z.object({ ...gitTarget, ref: z.string().regex(/^stash@\{\d+\}$/), commit: z.string().regex(/^[0-9a-f]{40,64}$/), message: z.string().trim().min(1).max(500) }).strict(), output: z.object({ ref: z.string(), commit: z.string() }) }
  , 'git:conflicts': { input: z.object({ sourceId: uuid, cardId: uuid.nullable().optional() }).strict(), output: z.object({ operation: z.enum(['merge', 'rebase', 'cherry-pick', 'revert']).nullable(), files: z.array(z.string()) }) }
  , 'git:conflict-ai': { input: z.object({ sourceId: uuid, cardId: uuid.nullable().optional(), path: z.string().min(1).max(1000), profileId: uuid, model: z.string().trim().max(120).nullable().optional(), effort: effortSchema.nullable().optional() }).strict(), output: z.object({ chatId: uuid, runId: uuid }) }
  , 'git:conflict-file': { input: z.object({ sourceId: uuid, cardId: uuid.nullable().optional(), path: z.string().min(1).max(1000) }).strict(), output: z.string() }
  , 'git:conflict-save': { input: z.object({ sourceId: uuid, cardId: uuid.nullable().optional(), path: z.string().min(1).max(1000), content: z.string().max(2_000_000) }).strict(), output: z.object({ left: z.number().int() }) }
  , 'git:conflicts-all': { input: z.object({ projectId: uuid }).strict(), output: z.array(z.object({ sourceId: uuid, cardId: uuid.nullable(), repo: z.string(), cardTitle: z.string().nullable(), operation: z.enum(['merge', 'rebase', 'cherry-pick', 'revert']), files: z.array(z.string()) })) }
  , 'git:file-versions': { input: z.object({ ...gitTarget, path: z.string().min(1).max(4096), mode: z.enum(['unstaged', 'staged', 'commit']), hash: z.string().regex(/^[0-9a-f]{7,64}$/).optional() }).strict(), output: z.object({ before: z.string().nullable(), after: z.string().nullable(), binary: z.boolean(), truncated: z.boolean() }) }
  , 'git:conflict-resolve': { input: z.object({ sourceId: uuid, cardId: uuid.nullable().optional(), path: z.string().min(1).max(1000), side: z.enum(['ours', 'theirs', 'marked']) }).strict(), output: z.object({ left: z.number().int() }) }
  , 'git:conflict-finish': { input: z.object({ sourceId: uuid, cardId: uuid.nullable().optional(), action: z.enum(['continue', 'abort']) }).strict(), output: z.object({ output: z.string() }) }
  , 'app:set-titlebar-theme': { input: z.object({ light: z.boolean() }).strict(), output: z.object({ ok: z.literal(true) }) }
  , 'app:set-brand-color': { input: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict(), output: z.object({ ok: z.literal(true) }) }
  , 'app:open-link': { input: z.object({ url: z.string().min(1).max(2048) }).strict(), output: z.object({ opened: z.literal(true) }) }
  , 'git:sync': { input: z.object({ ...gitTarget, action: z.enum(['fetch', 'pull', 'push', 'stash', 'pop']), pull: z.enum(['ff', 'ff-only', 'rebase']).optional(), force: z.boolean().optional(), branch: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/).optional() }).strict(), output: z.object({ output: z.string(), conflicts: z.number().int().nonnegative().optional() }) }
  , 'git:card': { input: cardIdInput, output: gitCardSchema }
  , 'git:base-options': { input: z.object({ sourceId: uuid }).strict(), output: z.array(z.string()) }
  , 'git:set-base': { input: z.object({ cardId: uuid, sourceId: uuid, baseRef: z.string().trim().min(1).max(200) }).strict(), output: z.object({ baseRef: z.string() }) }
  , 'git:policy-get': { input: z.object({ projectId: uuid }).strict(), output: gitPolicySchema }
  , 'git:policy-set': { input: z.object({ projectId: uuid, policy: gitPolicySchema }).strict(), output: gitPolicySchema }
  , 'git:requests': { input: cardIdInput, output: z.array(gitRequestSchema) }
  , 'git:request-decide': { input: z.object({ requestId: uuid, decision: z.enum(['allow', 'deny']), message: z.string().max(2000).optional() }).strict(), output: gitRequestSchema }
} as const

export type IpcChannel = keyof typeof ipcContracts
export type IpcInput<C extends IpcChannel> = z.input<(typeof ipcContracts)[C]['input']>
export type IpcOutput<C extends IpcChannel> = z.output<(typeof ipcContracts)[C]['output']>
export type GitRule = z.output<typeof gitRuleSchema>
export type GitPolicy = z.output<typeof gitPolicySchema>
export type GitRepo = z.output<typeof gitRepoSchema>
export type GitRow = z.output<typeof gitRowSchema>
export type GitRef = z.output<typeof gitRefSchema>
export type GitWorktreeInfo = z.output<typeof gitWorktreeInfoSchema>
export type GitGraph = z.output<typeof gitGraphSchema>
export type GitChange = z.output<typeof gitChangeSchema>
export type GitChanges = z.output<typeof gitChangesSchema>
export type GitCommitFile = z.output<typeof gitCommitFileSchema>
export type GitRequest = z.output<typeof gitRequestSchema>
export type GitCard = z.output<typeof gitCardSchema>
export type GitCardRepo = z.output<typeof gitCardRepoSchema>
export type Note = z.output<typeof noteSchema>
export type BackupSummary = z.output<typeof backupSummarySchema>
export type AppTheme = z.output<typeof themeSchema>
export type CustomTheme = z.output<typeof customThemeSchema>
export type ThemeRef = z.output<typeof themeRefSchema>
export type AppLanguage = z.output<typeof languageSchema>
export type AppSettings = z.output<typeof appSettingsSchema>
export type AgentProfile = z.output<typeof agentProfileSchema>
export type Project = z.output<typeof projectSchema>
export type ProjectInspection = z.output<typeof projectInspectionSchema>
export type ProjectSource = z.output<typeof projectSourceSchema>
export type BoardColumn = z.output<typeof boardColumnSchema>
export type CardDocumentKind = z.output<typeof cardDocumentKindSchema>
export type CardDocument = z.output<typeof cardDocumentSchema>
export type CardDocuments = z.output<typeof cardDocumentsSchema>
export type DocumentVersion = z.output<typeof documentVersionSchema>
export type AgentPurpose = z.output<typeof agentPurposeSchema>
export type AgentConfig = z.output<typeof agentConfigSchema>
export type CardAgents = z.output<typeof cardAgentsSchema>
export type ModelOption = z.output<typeof modelOptionSchema>
export type AgentOptions = z.output<typeof agentOptionsSchema>
export type Effort = z.output<typeof effortSchema>
export type CardRunState = z.output<typeof cardRunStateSchema>
export type Card = z.output<typeof cardSchema>
export type CardTypeDef = z.output<typeof cardTypeDefSchema>
export type ProjectBoard = z.output<typeof projectBoardSchema>
export type AgentProbe = z.output<typeof agentProbeSchema>
export type Chat = z.output<typeof chatSchema>
export type ChatPurpose = z.output<typeof chatPurposeSchema>
export type Constitution = z.output<typeof constitutionSchema>
export type ConstitutionProposal = z.output<typeof constitutionProposalSchema>
export type ConstitutionState = z.output<typeof constitutionStateSchema>
export type CardChecklist = z.output<typeof cardChecklistSchema>
export type ChatMessage = z.output<typeof chatMessageSchema>
export type Run = z.output<typeof runSchema>
export type RunEvent = z.output<typeof runEventSchema>
/** `seq` comes with the events saved in the run (it lets a chat that reloaded the text so far skip what it already has). */
export type PushedRunEvent = Pick<RunEvent, 'runId' | 'eventType' | 'payload'> & { seq?: number }
export type Plan = z.output<typeof planSchema>
export type Worktree = z.output<typeof worktreeSchema>
export type GitSnapshot = z.output<typeof gitSnapshotSchema>
export type TestRun = z.output<typeof testRunSchema>
export type TestRunRepo = z.output<typeof testRunRepoSchema>
export type RepoTestCommand = z.output<typeof repoTestCommandSchema>
export type Review = z.output<typeof reviewSchema>

export interface GearModApi {
  invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>>
  onRunEvent(listener: (event: PushedRunEvent) => void): () => void
  getDroppedFilePath(file: File): string
}
export * from './questions'
export * from './assessments'
export * from './sql-danger'
export * from './error-codes'
