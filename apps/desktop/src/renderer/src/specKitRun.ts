import type { SpecKitRunInput } from '@gearmod/contracts'
import { tasks } from './backgroundTasks'
import { tr } from './i18n'
import { probeTools } from './toolsStatusCache'

export interface RunningSpecRun { terminalId: string; taskId: string }
/** Fired on `window` (detail: project id) when a Spec Kit terminal exits and the tools were probed again. */
export const specRunFinishedEvent = 'gearmod:spec-run-finished'

const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
const samePath = (a: string, b: string): boolean => norm(a) === norm(b)

/**
 * Spec Kit was just started in a folder: the project's SDD settings follow it, so nobody has to configure it again by hand. The folder joins the project
 * when it is not there yet, becomes the SDD repository, and the Constitution path becomes Spec Kit's. Best effort: a failure here never hides that the install worked.
 */
async function useSpecKitForSdd(projectId: string, path: string): Promise<void> {
  try {
    let status = await probeTools(projectId), repo = status.repos.find((item) => samePath(item.path, path))
    if (!repo) {
      await window.gearmod.invoke('projects:add-repositories', { projectId, localPath: path })
      window.dispatchEvent(new Event('gearmod:board-changed'))
      status = await probeTools(projectId); repo = status.repos.find((item) => samePath(item.path, path))
    }
    if (!repo) return
    const config = await window.gearmod.invoke('sdd:config-get', { projectId })
    await window.gearmod.invoke('sdd:config-set', { projectId, config: { ...config, sourceId: repo.sourceId, method: 'speckit', root: '', featuresDir: 'specs', constitution: { ...config.constitution, speckit: '.specify/memory/constitution.md' } } })
  } catch { /* the user can still pick it in the SDD tab */ }
}

const running = new Map<string, RunningSpecRun>()

/**
 * Starts a Spec Kit step (install, update, init…) in an app terminal and follows it in the process list (title bar), so the dialog can be closed and
 * it goes on in the background. When it ends, the tools are probed again at once, even with nothing open, so the "update available" notice and the dots
 * do not stay lit for something that was just done. A second click while it runs returns the same run.
 */
export async function startSpecRun(projectId: string, input: SpecKitRunInput, title: string): Promise<RunningSpecRun> {
  const key = `spec-kit:${input.kind}:${input.path ?? ''}`
  const current = running.get(key)
  if (current) return current
  const { id } = await window.gearmod.invoke('tools:run-terminal', input)
  const taskId = tasks.begin({ key, title })
  const entry = { terminalId: id, taskId }
  running.set(key, entry)
  const stop = window.gearmod.onRunEvent((event) => {
    if (event.eventType !== 'gearmod/terminal-exit' || String(event.payload.id ?? '') !== id) return
    stop(); running.delete(key)
    const code = Number(event.payload.code ?? 0)
    tasks.end(taskId, code === 0 ? undefined : tr().settings.agentUpdate.exitCode(code))
    const started = code === 0 && (input.kind === 'init' || input.kind === 'init-with-git') && input.path ? input.path : ''
    void (started ? useSpecKitForSdd(projectId, started) : Promise.resolve()).then(() => probeTools(projectId)).catch(() => undefined).finally(() => window.dispatchEvent(new CustomEvent(specRunFinishedEvent, { detail: projectId })))
  })
  return entry
}
