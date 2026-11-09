import { tasks } from './backgroundTasks'
import { tr } from './i18n'

export type UpdatableProvider = 'codex' | 'claude' | 'gemini'
export interface RunningUpdate { terminalId: string; taskId: string }
/** `install`: first install of the CLI (npm), same flow and dialog as the update. */
export type AgentCliJob = 'update' | 'install'

/** Fired on `window` when an agent CLI update terminal exits, so whatever shows installed versions can probe again. */
export const agentUpdateFinishedEvent = 'gearmod:agent-update-finished'

const running = new Map<string, RunningUpdate>()

/** Exit code of the update command → `undefined` when it worked, or the error text for the process list. */
export function updateOutcome(code: number, job: AgentCliJob = 'update'): string | undefined { return code === 0 ? undefined : (job === 'install' ? tr().settings.agentInstall : tr().settings.agentUpdate).exitCode(code) }

/**
 * Starts the agent CLI update in an app terminal and follows it in the process list (title bar), so the dialog can be closed
 * and the update goes on in the background. A second click while it runs returns the same update.
 */
export async function startAgentUpdate(provider: UpdatableProvider, name: string, job: AgentCliJob = 'update'): Promise<RunningUpdate> {
  const key = `agent-${job}:${provider}`, current = running.get(key)
  if (current) return current
  const { id } = await window.gearmod.invoke(job === 'install' ? 'profiles:install-terminal' : 'profiles:update-terminal', { provider })
  const taskId = tasks.begin({ key, title: (job === 'install' ? tr().settings.agentInstall : tr().settings.agentUpdate).taskTitle(name) })
  const entry = { terminalId: id, taskId }
  running.set(key, entry)
  const stop = window.gearmod.onRunEvent((event) => {
    if (event.eventType !== 'gearmod/terminal-exit' || String(event.payload.id ?? '') !== id) return
    stop(); running.delete(key)
    tasks.end(taskId, updateOutcome(Number(event.payload.code ?? 0), job))
    window.dispatchEvent(new Event(agentUpdateFinishedEvent))  // the Settings gear dot checks the installed versions again
  })
  return entry
}
