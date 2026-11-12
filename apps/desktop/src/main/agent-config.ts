import { agentConfigSchema, defaultPermissionMode, permissionModes, providerLabels, type AgentConfig, type AgentOptions, type AgentPurpose, type CardAgents, type Effort, type ModelOption } from '@gearmod/contracts'
import type { AppDatabase } from './database'
import type { BoardRepository, ProfileRepository } from './projects'
import { tm } from './i18n'

const claudeEfforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** Claude accepts model aliases; Opus for planning and Sonnet for executing are the starting recommendations. */
export const claudeModels: ModelOption[] = [
  { id: 'fable', label: 'Fable', get description() { return tm().modelOptions.fableDescription }, efforts: claudeEfforts, recommendedFor: [], defaultEffort: 'high' },
  { id: 'opus', label: 'Opus', get description() { return tm().modelOptions.opusDescription }, efforts: claudeEfforts, recommendedFor: ['planning'], defaultEffort: 'high' },
  { id: 'sonnet', label: 'Sonnet', get description() { return tm().modelOptions.sonnetDescription }, efforts: claudeEfforts, recommendedFor: ['execution', 'test'], defaultEffort: 'medium' },
  { id: 'haiku', label: 'Haiku', get description() { return tm().modelOptions.haikuDescription }, efforts: ['low', 'medium', 'high'], recommendedFor: [], defaultEffort: 'low' }
]

/**
 * Models offered by Antigravity. The list shown comes from the signed-in account (`listGeminiModels`, read from `session/new`:
 * a paid plan lists more models); this one, seen on a free account with `agy` 1.5.5, is the fallback when the account cannot be read.
 * A model the account does not offer is skipped at run time and the account default is used. Effort = "thinking level".
 */
const antigravityEfforts: Effort[] = ['low', 'medium', 'high']
const isEffort = (value: string): value is Effort => (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as string[]).includes(value)

/** The account's models as picker options: "Auto" first (account default); thinking levels only on Gemini models. */
export function antigravityModelOptions(models: Array<{ id: string; label: string }>, thoughtLevels: string[]): ModelOption[] {
  const efforts = thoughtLevels.filter(isEffort)
  const description = (id: string): string => id.startsWith('claude') ? tm().modelOptions.antigravityClaudeDescription : id.startsWith('gpt') ? tm().modelOptions.antigravityGptDescription : id.includes('flash') ? tm().modelOptions.flashDescription : tm().modelOptions.antigravityGeminiDescription
  return [geminiModels[0]!, ...models.map((model): ModelOption => {
    const gemini = model.id.startsWith('gemini')
    return { id: model.id, label: model.label, description: description(model.id), efforts: gemini ? efforts : [], recommendedFor: [], defaultEffort: gemini && efforts.includes('high') ? 'high' : null }
  })]
}

export const geminiModels: ModelOption[] = [
  { id: 'auto', label: 'Auto', get description() { return tm().modelOptions.autoDescription }, efforts: antigravityEfforts, recommendedFor: ['planning', 'execution', 'test'], defaultEffort: null },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', get description() { return tm().modelOptions.flashDescription }, efforts: antigravityEfforts, recommendedFor: [], defaultEffort: 'high' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', get description() { return tm().modelOptions.antigravityClaudeDescription }, efforts: [], recommendedFor: [], defaultEffort: null },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6', get description() { return tm().modelOptions.antigravityClaudeDescription }, efforts: [], recommendedFor: [], defaultEffort: null },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B', get description() { return tm().modelOptions.antigravityGptDescription }, efforts: [], recommendedFor: [], defaultEffort: null }
]

export type CodexModelLister = (profileId: string) => Promise<ModelOption[]>

/** Model, effort and mode per card and per purpose (plan/execute), with each agent's "most used". */
export class AgentConfigRepository {
  private readonly codexCache = new Map<string, ModelOption[]>()
  private readonly listedCache = new Map<string, ModelOption[]>()
  constructor(private readonly database: AppDatabase, private readonly board: BoardRepository, private readonly profiles: ProfileRepository, private readonly listCodexModels?: CodexModelLister, private readonly listGeminiModels?: CodexModelLister, private readonly listClaudeModels?: CodexModelLister) {}

  get(cardId: string): CardAgents {
    this.board.card(cardId)
    const rows = this.database.db.prepare('SELECT purpose, profile_id AS profileId, model, effort, mode FROM card_agent_settings WHERE card_id = ?').all(cardId) as Array<AgentConfig & { purpose: AgentPurpose }>
    const pick = (purpose: AgentPurpose): AgentConfig | null => { const row = rows.find((item) => item.purpose === purpose); return row ? agentConfigSchema.parse({ profileId: row.profileId, model: row.model, effort: row.effort, mode: row.mode }) : null }
    return { planning: pick('planning'), execution: pick('execution'), test: pick('test') }
  }

  set(cardId: string, purpose: AgentPurpose, config: AgentConfig): CardAgents {
    this.board.card(cardId)
    const profile = this.profiles.get(config.profileId)
    const info = permissionModes[profile.provider].find((mode) => mode.id === config.mode)
    if (!info || !info.purposes.includes(purpose)) throw new Error(tm().agentConfig.modeNotAvailable(config.mode, purpose === 'planning' ? tm().agentConfig.toPlan : purpose === 'test' ? tm().agentConfig.toTest : tm().agentConfig.toExecute, providerLabels[profile.provider]))
    if (info.needsApprovalUi) throw new Error(tm().agentConfig.modeNeedsApprovalUi(info.label))
    this.database.db.prepare(`INSERT INTO card_agent_settings(card_id, purpose, profile_id, model, effort, mode, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(card_id, purpose) DO UPDATE SET profile_id = excluded.profile_id, model = excluded.model, effort = excluded.effort, mode = excluded.mode, updated_at = excluded.updated_at`)
      .run(cardId, purpose, config.profileId, config.model, config.effort, config.mode, new Date().toISOString())
    return this.get(cardId)
  }

  /** Configuration used in a turn: the one saved on the card (if it is for the same agent) or the default (most used, otherwise recommended). */
  resolve(cardId: string, profileId: string, purpose: AgentPurpose): AgentConfig {
    const saved = this.get(cardId)[purpose]
    if (saved && saved.profileId === profileId) return saved
    const provider = this.profiles.get(profileId).provider
    const used = this.mostUsed(profileId, purpose)
    const recommended = provider === 'claude' ? claudeModels.find((model) => model.recommendedFor.includes(purpose)) : provider === 'gemini' ? geminiModels.find((model) => model.recommendedFor.includes(purpose)) : undefined
    return { profileId, model: used?.model ?? recommended?.id ?? null, effort: used?.effort ?? recommended?.defaultEffort ?? null, mode: defaultPermissionMode(provider, purpose) }
  }

  recordUse(config: AgentConfig, purpose: AgentPurpose): void {
    this.database.db.prepare(`INSERT INTO agent_usage_stats(profile_id, purpose, model, effort, count, last_used_at) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(profile_id, purpose, model, effort) DO UPDATE SET count = count + 1, last_used_at = excluded.last_used_at`).run(config.profileId, purpose, config.model ?? '', config.effort ?? '', new Date().toISOString())
  }

  mostUsed(profileId: string, purpose: AgentPurpose): { model: string | null; effort: Effort | null } | null {
    const row = this.database.db.prepare('SELECT model, effort FROM agent_usage_stats WHERE profile_id = ? AND purpose = ? ORDER BY count DESC, last_used_at DESC LIMIT 1').get(profileId, purpose) as { model: string; effort: string } | undefined
    return row ? { model: row.model || null, effort: (row.effort || null) as Effort | null } : null
  }

  async options(profileId: string): Promise<AgentOptions> {
    const profile = this.profiles.get(profileId)
    let models = profile.provider === 'gemini' ? geminiModels : claudeModels
    let error: string | undefined
    if (profile.provider === 'codex') {
      if (!this.codexCache.has(profileId) && this.listCodexModels) {
        try { const listed = await this.listCodexModels(profileId); if (listed.length) this.codexCache.set(profileId, listed); else error = tm().adapters.noCodexModels }
        catch (reason) { error = (reason instanceof Error ? reason.message : String(reason)).slice(0, 300) }
      }
      models = this.codexCache.get(profileId) ?? []
    }
    // Claude and Antigravity: the models of the signed-in account (Fable, newer versions, paid-plan models), read without spending
    // anything. Not cached when the account could not be read (e.g. not signed in yet): the next open tries again; meanwhile, the fixed list.
    const lister = profile.provider === 'gemini' ? this.listGeminiModels : profile.provider === 'claude' ? this.listClaudeModels : undefined
    if (lister) {
      if (!this.listedCache.has(profileId)) { try { const listed = await lister(profileId); if (listed.length > 1) this.listedCache.set(profileId, listed) } catch { /* fixed list below */ } }
      models = this.listedCache.get(profileId) ?? models
    }
    return { models, ...(error ? { error } : {}), mostUsed: { planning: this.mostUsed(profileId, 'planning'), execution: this.mostUsed(profileId, 'execution'), test: this.mostUsed(profileId, 'test') } }
  }
}
