import type { ModelOption } from '@gearmod/contracts'

/** "Opus 5.5" → family "opus #" and version [5, 5]; "GPT-5.4-mini" → "gpt-#-mini" and [5, 4]. Labels without a number have no version. */
function familyOf(label: string): { family: string; version: number[] | null } {
  const match = /\d+(?:\.\d+)*/.exec(label)
  return { family: label.replace(/\d+(?:\.\d+)*/, '#').trim().toLowerCase(), version: match ? match[0].split('.').map(Number) : null }
}

const newer = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

/**
 * Model menu: the newest version of each family stays on the main list (in the order the agent gave); the older versions go to
 * "More models". Applies to every agent (Claude, Codex, Antigravity), since it only reads the labels.
 */
export function splitModels(models: ModelOption[]): { main: ModelOption[]; older: ModelOption[] } {
  const best = new Map<string, { id: string; version: number[] }>()
  for (const model of models) {
    const { family, version } = familyOf(model.label)
    if (!version) continue
    const current = best.get(family)
    if (!current || newer(version, current.version)) best.set(family, { id: model.id, version })
  }
  const isMain = (model: ModelOption): boolean => { const { family, version } = familyOf(model.label); return !version || best.get(family)?.id === model.id }
  return { main: models.filter(isMain), older: models.filter((model) => !isMain(model)) }
}
