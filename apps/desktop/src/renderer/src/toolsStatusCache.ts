import type { ToolsStatus } from '@gearmod/contracts'

/** Fired on `window` (detail: project id) whenever the tools were probed again, so the panel, the tab dot and the gear dot all follow the new result. */
export const toolsChangedEvent = 'gearmod:tools-changed'

const statusKey = (projectId: string): string => `gearmod.tools-status.${projectId}`
export const cachedStatus = (projectId: string): ToolsStatus | undefined => {
  try { const raw = localStorage.getItem(statusKey(projectId)); return raw ? JSON.parse(raw) as ToolsStatus : undefined } catch { return undefined }
}
const saveStatus = (projectId: string, status: ToolsStatus): void => { try { localStorage.setItem(statusKey(projectId), JSON.stringify(status)) } catch { /* the cache is just a visual convenience */ } }

/** Looks at what is installed (uv, Python, specify, OpenSpec), keeps the result and tells everyone who shows it. */
export async function probeTools(projectId: string): Promise<ToolsStatus> {
  const next = await window.gearmod.invoke('tools:status', { projectId })
  saveStatus(projectId, next)
  window.dispatchEvent(new CustomEvent(toolsChangedEvent, { detail: projectId }))
  return next
}
