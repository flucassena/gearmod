import type { Project } from '@gearmod/contracts'

export function projectStatus(activity: Project['activity']): { primary: 'waiting' | 'finished' | 'running' | undefined; extra: number } {
  const active = (['waiting', 'finished', 'running'] as const).filter((kind) => (activity[kind] ?? 0) > 0)
  return { primary: active[0], extra: Math.max(0, active.length - 1) }
}
