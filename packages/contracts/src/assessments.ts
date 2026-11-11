import { z } from 'zod'

/**
 * Complexity Engine, decisions and card events (docs/09). Assessments are never overwritten: each one is a new version,
 * with scores, weights, justifications and evidence. The limits and weights are initial heuristics, configurable per project.
 */
export const complexityDimensions = ['escopo', 'acoplamento', 'incerteza', 'risco', 'novidade', 'validacao'] as const
export const complexityDimensionSchema = z.enum(complexityDimensions)
export const dimensionLabels: Record<ComplexityDimension, string> = { escopo: 'Escopo', acoplamento: 'Acoplamento', incerteza: 'Incerteza', risco: 'Risco', novidade: 'Novidade técnica', validacao: 'Dificuldade de validação' }
export const defaultComplexityWeights: Record<ComplexityDimension, number> = { escopo: 2, acoplamento: 2, incerteza: 2, risco: 3, novidade: 1, validacao: 1 }
/** 0–7 simple, 8–16 medium, 17+ complex (with the default weights the maximum is 33). */
export const defaultComplexityLimits = { simpleMax: 7, mediumMax: 16 }
/** The simple/medium/complex limits an assessment was scored with (kept with it, so a later change in the settings does not rewrite the history). */
export const complexityLimitsSchema = z.object({ simpleMax: z.number().int().nonnegative(), mediumMax: z.number().int().nonnegative() })

const score = z.number().int().min(0).max(3)
const weight = z.number().int().min(0).max(5)
export const dimensionScoresSchema = z.object({ escopo: score, acoplamento: score, incerteza: score, risco: score, novidade: score, validacao: score }).strict()
export const dimensionWeightsSchema = z.object({ escopo: weight, acoplamento: weight, incerteza: weight, risco: weight, novidade: weight, validacao: weight }).strict()
export const complexityLevelSchema = z.enum(['simple', 'medium', 'complex'])
export const confidenceSchema = z.enum(['low', 'medium', 'high'])
/** Card flow: `light` = small task (implement and validate); `spec` = GearMod's Specification, Plan and Tasks; `sdd` = the project's configured method. */
export const workflowKindSchema = z.enum(['light', 'spec', 'sdd'])
/** Method used in the `sdd` flow. `native` = GearMod's full SDD; the others read the configured central folder. */
export const sddMethodSchema = z.enum(['native', 'speckit', 'openspec', 'custom'])
/** Why the assessment was (re)done. Reassess only on these triggers, never on every message. */
export const assessmentTriggerSchema = z.enum(['initial', 'requirements-changed', 'new-dependency', 'risk', 'architecture', 'scope', 'failures', 'user-correction'])
export const evidenceKindSchema = z.enum(['file', 'commit', 'diff', 'message', 'investigation', 'test', 'api', 'artifact'])
/** Reproducible reference: path (with line) or hash, and the repository commit at the time of the assessment. */
export const evidenceSchema = z.object({ kind: evidenceKindSchema, ref: z.string().trim().min(1).max(1000), detail: z.string().max(2000).default(''), line: z.number().int().positive().nullable().default(null), commit: z.string().max(64).nullable().default(null) })
const isoDate = z.string().datetime()
const uuid = z.string().uuid()
export const assessmentSchema = z.object({
  id: uuid, cardId: uuid, version: z.number().int().positive(), preliminary: z.boolean(), scores: dimensionScoresSchema, weights: dimensionWeightsSchema,
  limits: complexityLimitsSchema.nullable().default(null), total: z.number().int().nonnegative(), level: complexityLevelSchema, confidence: confidenceSchema, criticalRisks: z.array(z.string()), justifications: z.record(z.string(), z.string()),
  evidence: z.array(evidenceSchema), workflow: workflowKindSchema, trigger: assessmentTriggerSchema, reason: z.string(), actor: z.enum(['agent', 'user']),
  profileId: uuid.nullable(), provider: z.string().nullable(), model: z.string().nullable(), effort: z.string().nullable(), codeVersion: z.string().nullable(), supersedesId: uuid.nullable(), createdAt: isoDate
})
export const decisionKindSchema = z.enum(['requirement', 'scope', 'assumption', 'technical', 'workflow', 'other'])
/** `proposed` = agent recommendation; `approved` = decided by the user; `superseded` = replaced by another decision. */
export const decisionSchema = z.object({ id: uuid, cardId: uuid, number: z.number().int().positive(), kind: decisionKindSchema, statement: z.string(), rationale: z.string(), status: z.enum(['proposed', 'approved', 'superseded']), actor: z.enum(['agent', 'user']), supersedesId: uuid.nullable(), createdAt: isoDate })
/** Understanding of the request (skill gearmod-discovery): what planning needs to know, without extensive documentation. */
export const discoveryBriefSchema = z.object({
  objetivo: z.string().max(4000), motivacao: z.string().max(4000).default(''), escopo: z.array(z.string().max(1000)).max(50).default([]), exclusoes: z.array(z.string().max(1000)).max(50).default([]),
  criterios: z.array(z.string().max(1000)).max(50).default([]), pendencias: z.array(z.string().max(1000)).max(50).default([]), contextoTecnico: z.string().max(8000).default(''), prontidao: z.enum(['pronto', 'precisa-esclarecer']), registradoEm: isoDate.optional()
})
/** Cached code exploration: valid as long as the repositories' version (HEAD) does not change. */
export const explorationSchema = z.object({ summary: z.string(), modules: z.array(z.string()), repositories: z.array(z.string()), evidence: z.array(evidenceSchema), codeVersions: z.record(z.string(), z.string()), stale: z.boolean(), createdAt: isoDate })
export const cardComplexitySchema = z.object({ total: z.number().int(), level: complexityLevelSchema, confidence: confidenceSchema, preliminary: z.boolean(), recommended: workflowKindSchema, workflow: workflowKindSchema.nullable(), delta: z.number().int().nullable(), version: z.number().int(), createdAt: isoDate })
export const historyEventTypes = ['assessment.created', 'assessment.revised', 'assessment.contested', 'evidence.recorded', 'user.decision', 'agent.decision', 'decision.superseded', 'workflow.selected', 'workflow.method-recommended', 'discovery.recorded', 'exploration.recorded', 'artifact.updated', 'execution.started', 'execution.completed', 'handoff.completed', 'verification.completed', 'harness.alert', 'policy.decided', 'approval.requested', 'approval.approved', 'approval.denied', 'approval.consumed'] as const
export const historyEventSchema = z.object({ id: uuid, v: z.literal(1), type: z.enum(historyEventTypes), at: isoDate, cardId: uuid, projectId: uuid, source: z.object({ actor: z.enum(['agent', 'user', 'system']), profileId: z.string().nullable().optional(), runId: z.string().nullable().optional(), chatId: z.string().nullable().optional() }), refs: z.array(z.string()), payload: z.record(z.string(), z.unknown()) })
/**
 * Execution limits (Harness). Null = no limit. `maxAttempts`: consecutive failures with the same error before stopping the
 * automatic resumes; `scopeCheck`: warn when the agent changes files outside the areas named in the Plan; `scopeIgnore`: paths/folders (one per entry, e.g. `cards/`) the check never flags, such as the folder where the workflow keeps the card's own documents and evidence.
 */
/** `includeEquivalentCost`: by default `maxCostUsd` sums only billed cost (`cost_kind='billed'`); turning it on also includes the estimated equivalent of subscription plans. */
export const harnessConfigSchema = z.object({ timeoutMinutes: z.number().int().min(1).max(24 * 60).nullable(), maxTokens: z.number().int().min(1000).nullable(), maxCostUsd: z.number().min(0.01).nullable(), includeEquivalentCost: z.boolean().default(false), maxAttempts: z.number().int().min(1).max(20), scopeCheck: z.boolean(), scopeIgnore: z.array(z.string().max(300)).max(50).default([]) }).strict()
export const defaultHarnessConfig: HarnessConfig = { timeoutMinutes: null, maxTokens: null, maxCostUsd: null, includeEquivalentCost: false, maxAttempts: 3, scopeCheck: true, scopeIgnore: [] }
export type HarnessConfig = z.output<typeof harnessConfigSchema>
/** S11 — minimal `PolicyEngine`: rule per action (the first that matches decides); with no rule for the action, it stays `ask` (nothing changes on its own). */
export const policyActionSchema = z.enum(['commit', 'move', 'choose-workflow'])
export const policyDecisionSchema = z.enum(['allow', 'ask', 'deny'])
export const policyRuleSchema = z.object({ action: policyActionSchema, decision: policyDecisionSchema }).strict()
export const policyConfigSchema = z.object({ rules: z.array(policyRuleSchema).max(50) }).strict().default({ rules: [] })
export const defaultPolicyConfig: PolicyConfig = { rules: [] }
export type PolicyAction = z.output<typeof policyActionSchema>
export type PolicyDecision = z.output<typeof policyDecisionSchema>
export type PolicyRule = z.output<typeof policyRuleSchema>
export type PolicyConfig = z.output<typeof policyConfigSchema>

/**
 * G01 (`02` §4.1) — location of the file-first SDD: only where it is, never the content (that is still SQLite, read-only in legacy
 * after G14). Coexists with the old fields (`sddPath`, `customManifest`, `complexMethod` with `openspec`/`custom`): the
 * reading normalizes the old ones to this format (`normalizeLegacySdd`); writing only saves in this format.
 */
export const sddConfigSchema = z.object({
  method: z.enum(['native', 'speckit']),
  sourceId: z.string().uuid().nullable(),
  root: z.string().max(512),
  constitution: z.object({ native: z.string().max(512), speckit: z.string().max(512) }).strict(),
  featuresDir: z.string().max(512)
}).strict()
export const defaultSddConfig: SddConfig = { method: 'native', sourceId: null, root: '', constitution: { native: '.gearmod/constitution.md', speckit: '.specify/memory/constitution.md' }, featuresDir: 'specs' }
export type SddConfig = z.output<typeof sddConfigSchema>

export const workflowConfigSchema = z.object({
  weights: dimensionWeightsSchema, limits: z.object({ simpleMax: z.number().int().min(0).max(100), mediumMax: z.number().int().min(0).max(100) }).strict().refine((value) => value.simpleMax < value.mediumMax, 'O limite de simples precisa ser menor que o de média'),
  complexMethod: sddMethodSchema, sddPath: z.string().trim().max(2048).nullable(), artifactsDir: z.string().trim().max(2048).nullable(), customManifest: z.string().trim().max(2048).nullable(),
  harness: harnessConfigSchema, playwrightCli: z.boolean(), playwrightVersion: z.string().max(40).nullable().optional(), policy: policyConfigSchema, exportUsage: z.boolean().default(false),
  sdd: sddConfigSchema.default(defaultSddConfig),
  /** Only filled on read, when the stored `complexMethod` was `openspec`/`custom` (they no longer exist on write). */
  legacyMethod: z.enum(['openspec', 'custom']).nullable().default(null)
}).strict()
export const defaultWorkflowConfig: WorkflowConfig = { weights: defaultComplexityWeights, limits: defaultComplexityLimits, complexMethod: 'native', sddPath: null, artifactsDir: null, customManifest: null, harness: defaultHarnessConfig, playwrightCli: false, policy: defaultPolicyConfig, exportUsage: false, sdd: defaultSddConfig, legacyMethod: null }

/**
 * G01: normalizes a raw `workflow_config` (already parsed JSON, from before `sdd`) to the new format, before
 * `workflowConfigSchema.safeParse`. Never throws; `sddPath`/`customManifest` remain in the return (still read by the
 * rest of the app until G06/G09 migrate), only `sdd`/`legacyMethod` are added when they do not exist yet.
 */
export function normalizeLegacySdd(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.sdd && typeof raw.sdd === 'object') return raw
  const legacyMethods = ['openspec', 'custom'] as const
  const storedMethod = raw.complexMethod
  const isLegacy = typeof storedMethod === 'string' && (legacyMethods as readonly string[]).includes(storedMethod)
  const method = storedMethod === 'speckit' ? 'speckit' : 'native'
  const speckitPath = typeof raw.sddPath === 'string' && raw.sddPath.trim() ? raw.sddPath.trim() : defaultSddConfig.constitution.speckit
  return {
    ...raw,
    sdd: { ...defaultSddConfig, method, constitution: { ...defaultSddConfig.constitution, speckit: speckitPath } },
    legacyMethod: isLegacy ? storedMethod : null
  }
}
export const sddDetectionSchema = z.object({ method: z.enum(['speckit', 'openspec']), path: z.string(), repository: z.string().nullable(), commands: z.array(z.string()) })
export const cardSddMethodSchema = z.enum(['native', 'speckit'])
export const cardHistorySchema = z.object({ assessments: z.array(assessmentSchema), decisions: z.array(decisionSchema), discovery: discoveryBriefSchema.nullable(), exploration: explorationSchema.nullable(), workflow: workflowKindSchema.nullable(), sddMethod: cardSddMethodSchema.nullable().default(null), recommendedSddMethod: cardSddMethodSchema.nullable().default(null), sddMethodReason: z.string().default(''), artifactsDir: z.string(), events: z.array(historyEventSchema) })
export const contestAssessmentInputSchema = z.object({ cardId: uuid, scores: dimensionScoresSchema, reason: z.string().trim().min(1).max(4000) }).strict()

export type ComplexityDimension = (typeof complexityDimensions)[number]
export type DimensionScores = z.output<typeof dimensionScoresSchema>
export type DimensionWeights = z.output<typeof dimensionWeightsSchema>
export type ComplexityLevel = z.output<typeof complexityLevelSchema>
export type Confidence = z.output<typeof confidenceSchema>
export type WorkflowKind = z.output<typeof workflowKindSchema>
export type SddMethod = z.output<typeof sddMethodSchema>
export type AssessmentTrigger = z.output<typeof assessmentTriggerSchema>
export type Evidence = z.output<typeof evidenceSchema>
export type Assessment = z.output<typeof assessmentSchema>
export type Decision = z.output<typeof decisionSchema>
export type DecisionKind = z.output<typeof decisionKindSchema>
export type DiscoveryBrief = z.output<typeof discoveryBriefSchema>
export type Exploration = z.output<typeof explorationSchema>
export type CardComplexity = z.output<typeof cardComplexitySchema>
export type HistoryEvent = z.output<typeof historyEventSchema>
export type HistoryEventType = (typeof historyEventTypes)[number]
export type WorkflowConfig = z.output<typeof workflowConfigSchema>
export type SddDetection = z.output<typeof sddDetectionSchema>
export type CardHistory = z.output<typeof cardHistorySchema>

export function weightedTotal(scores: DimensionScores, weights: DimensionWeights): number {
  return complexityDimensions.reduce((sum, dimension) => sum + scores[dimension] * weights[dimension], 0)
}

export function complexityLevel(total: number, limits: { simpleMax: number; mediumMax: number }): ComplexityLevel {
  return total <= limits.simpleMax ? 'simple' : total <= limits.mediumMax ? 'medium' : 'complex'
}

/** Flow recommended by the level. Safety rule: maximum risk never stays in the light flow, whatever the score. */
export function recommendedWorkflow(level: ComplexityLevel, scores: DimensionScores): WorkflowKind {
  const base: WorkflowKind = level === 'simple' ? 'light' : level === 'medium' ? 'spec' : 'sdd'
  return base === 'light' && scores.risco >= 3 ? 'spec' : base
}

export const levelLabels: Record<ComplexityLevel, string> = { simple: 'simples', medium: 'média', complex: 'complexa' }
export const workflowLabels: Record<WorkflowKind, string> = { light: 'Fluxo curto (implementar e validar)', spec: 'Spec leve (Especificação, Plano e Tasks)', sdd: 'SDD completo (método do projeto)' }
export const triggerLabels: Record<AssessmentTrigger, string> = { initial: 'Avaliação inicial', 'requirements-changed': 'Requisitos mudaram', 'new-dependency': 'Dependência nova', risk: 'Risco novo', architecture: 'Mudança arquitetural', scope: 'Escopo corrigido', failures: 'Falhas recorrentes', 'user-correction': 'Correção do usuário' }
