import type { CardAttachment } from '@gearmod/contracts'

/** Lowercase without accents, so "relatorio" finds "Relatório". */
const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Newest first. */
export const sortAttachments = (items: CardAttachment[]): CardAttachment[] => [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

/** "12 B", "3.4 KB", "5.2 MB", "1.3 GB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

/** Attachments whose name matches the text (ignoring case and accents); names that start with it come first, then the ones that contain it. */
export function matchAttachments(query: string, items: CardAttachment[]): CardAttachment[] {
  const q = fold(query.trim())
  if (!q) return items
  const rank = (item: CardAttachment): number => { const name = fold(item.fileName); return name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2 }
  return items.map((item, index) => ({ item, index, rank: rank(item) })).filter((entry) => entry.rank < 2).sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.item)
}

export const toggleSelection = (selected: string[], id: string): string[] => selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]
/** "Select all" toggles: with everything selected it clears, otherwise it selects every attachment. */
export const selectAll = (selected: string[], items: CardAttachment[]): string[] => items.length > 0 && items.every((item) => selected.includes(item.id)) ? [] : items.map((item) => item.id)
export function selectionSummary(selected: string[], items: CardAttachment[]): { count: number; bytes: number } {
  const chosen = items.filter((item) => selected.includes(item.id))
  return { count: chosen.length, bytes: chosen.reduce((sum, item) => sum + item.sizeBytes, 0) }
}

export interface MentionFile { path: string; relative: string; name: string; directory: boolean }
export type MentionEntry = { kind: 'card'; attachment: CardAttachment } | { kind: 'file'; hit: MentionFile }
/** List of "@": the card's attachments that match come first (at most `cardMax`), then the project files, with `max` items in total. */
export function combineMentions(query: string, attachments: CardAttachment[], files: MentionFile[], max = 8, cardMax = 4): MentionEntry[] {
  const cards = matchAttachments(query, attachments.filter((item) => item.available)).slice(0, cardMax).map((attachment): MentionEntry => ({ kind: 'card', attachment }))
  return [...cards, ...files.map((hit): MentionEntry => ({ kind: 'file', hit }))].slice(0, max)
}

const listeners = new Map<string, Set<() => void>>()
/** Tells the folder of this card to reload (a message with attachments left the chat). */
export function notifyCardAttachments(cardId: string | null): void { if (cardId) listeners.get(cardId)?.forEach((listener) => listener()) }
export function onCardAttachments(cardId: string, listener: () => void): () => void {
  const set = listeners.get(cardId) ?? new Set(); set.add(listener); listeners.set(cardId, set)
  return () => { set.delete(listener) }
}
