import { findConflicts } from './conflicts'

/** One conflict block split into lines (each one keeps its line break), plus the raw block text used while nothing is picked. */
export interface PickBlock { index: number; oursName: string; theirsName: string; ours: string[]; theirs: string[]; raw: string }
export interface PickModel { blocks: PickBlock[]; /** Text before each block and after the last one: `gaps.length === blocks.length + 1`. */ gaps: string[] }
/** Lines picked per block: absent = still in conflict. */
export type Picks = Record<number, { ours: boolean[]; theirs: boolean[] }>

export const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

/** Splits a file with conflict markers into plain text and conflict blocks. */
export function parsePicks(text: string): PickModel {
  const blocks: PickBlock[] = [], gaps: string[] = []
  let at = 0
  findConflicts(text).forEach((found, index) => {
    gaps.push(text.slice(at, found.from))
    blocks.push({ index, oursName: found.oursName, theirsName: found.theirsName, ours: splitLines(text.slice(found.ours.from, found.ours.to)), theirs: splitLines(text.slice(found.theirs.from, found.theirs.to)), raw: text.slice(found.from, found.to) })
    at = found.to
  })
  gaps.push(text.slice(at))
  return { blocks, gaps }
}

export const pickedCount = (pick: Picks[number] | undefined): number => pick ? pick.ours.filter(Boolean).length + pick.theirs.filter(Boolean).length : 0
/** A block counts as resolved when at least one line was picked from either side. */
export const isResolved = (picks: Picks, index: number): boolean => pickedCount(picks[index]) > 0

/** The file as it would be written: picked lines (side A, then side B) in place of each block; blocks with nothing picked keep their markers. */
export function composePicks(model: PickModel, picks: Picks): string {
  let out = ''
  model.blocks.forEach((block, index) => {
    out += model.gaps[index]
    const pick = picks[block.index]
    out += isResolved(picks, block.index) ? block.ours.filter((_, line) => pick!.ours[line]).join('') + block.theirs.filter((_, line) => pick!.theirs[line]).join('') : block.raw
  })
  return out + model.gaps[model.blocks.length]
}

/** Ticks or unticks one line (`line` omitted = the whole side). */
export function togglePick(model: PickModel, picks: Picks, index: number, side: 'ours' | 'theirs', line?: number): Picks {
  const block = model.blocks[index]; if (!block) return picks
  const current = picks[index] ?? { ours: block.ours.map(() => false), theirs: block.theirs.map(() => false) }
  const next = { ours: [...current.ours], theirs: [...current.theirs] }
  if (line === undefined) { const all = !next[side].every(Boolean); next[side] = next[side].map(() => all) } else next[side][line] = !next[side][line]
  return { ...picks, [index]: next }
}

/** Picks every line of one side (and none of the other), or both. */
export function pickWhole(model: PickModel, picks: Picks, index: number, choice: 'ours' | 'theirs' | 'both' | 'none'): Picks {
  const block = model.blocks[index]; if (!block) return picks
  return { ...picks, [index]: { ours: block.ours.map(() => choice === 'ours' || choice === 'both'), theirs: block.theirs.map(() => choice === 'theirs' || choice === 'both') } }
}

/** Sets every line of one side (or of both) in every block. */
export function pickEvery(model: PickModel, picks: Picks, side: 'ours' | 'theirs' | 'both', value: boolean): Picks {
  const next: Picks = { ...picks }
  for (const block of model.blocks) {
    const current = next[block.index] ?? { ours: block.ours.map(() => false), theirs: block.theirs.map(() => false) }
    next[block.index] = { ours: side === 'theirs' ? current.ours : block.ours.map(() => value), theirs: side === 'ours' ? current.theirs : block.theirs.map(() => value) }
  }
  return next
}

/** Is every line of that side picked, in every block? */
export const sideFullyPicked = (model: PickModel, picks: Picks, side: 'ours' | 'theirs'): boolean => model.blocks.some((block) => block[side].length > 0) && model.blocks.every((block) => block[side].every((_, line) => picks[block.index]?.[side][line]))

/** Where block `index` starts in the composed output text (to scroll the output to it). */
export function blockOffset(model: PickModel, picks: Picks, index: number): number {
  let at = 0
  for (let step = 0; step < model.blocks.length; step++) {
    at += model.gaps[step]!.length
    if (step === index) return at
    const block = model.blocks[step]!, pick = picks[block.index]
    at += isResolved(picks, block.index) ? block.ours.filter((_, line) => pick!.ours[line]).join('').length + block.theirs.filter((_, line) => pick!.theirs[line]).join('').length : block.raw.length
  }
  return at
}

/** Start of every output line that came from a picked line, with its side (to color it like the panes). */
export function pickedLines(model: PickModel, picks: Picks): Array<{ at: number; side: 'ours' | 'theirs' }> {
  const found: Array<{ at: number; side: 'ours' | 'theirs' }> = []
  let at = 0
  model.blocks.forEach((block, step) => {
    at += model.gaps[step]!.length
    if (!isResolved(picks, block.index)) { at += block.raw.length; return }
    const pick = picks[block.index]!
    block.ours.forEach((line, index) => { if (pick.ours[index]) { found.push({ at, side: 'ours' }); at += line.length } })
    block.theirs.forEach((line, index) => { if (pick.theirs[index]) { found.push({ at, side: 'theirs' }); at += line.length } })
  })
  return found
}
