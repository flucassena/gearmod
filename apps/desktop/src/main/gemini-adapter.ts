import { runGeminiAcp } from './gemini-acp'
import type { AgentAdapter, AgentRunOptions, AgentRunResult, ProcessFactory } from './adapters'
import { tm } from './i18n'

/**
 * Gemini profiles run through Google's Antigravity CLI (`agy`). Since 2026-06-18 the Gemini CLI no longer accepts personal Google
 * accounts; Antigravity accepts them and speaks ACP, so every mode (plan, default, accept edits, automatic) goes through
 * `runGeminiAcp`. The provider id stays `gemini` so existing data, schemas and settings keep working.
 */
export class GeminiCliAdapter implements AgentAdapter {
  constructor(private readonly processes: ProcessFactory) {}
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    if (options.signal?.aborted) throw new Error(tm().common.executionCancelled)
    return runGeminiAcp(this.processes, options)
  }
}
