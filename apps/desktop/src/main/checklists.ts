import { checklistKey, type CardChecklist } from '@gearmod/contracts'
import type { AppDatabase } from './database'
import { tm } from './i18n'

const item = /^\s*[-*+]\s+\[( |x|X)\]\s+\S/m
const line = /^(\s*[-*+]\s+)\[( |x|X)\](\s+)(.*)$/
type Marks = CardChecklist['marks']

/** Checklist items (main and indented) with their text and whether they are checked. */
function itemsOf(markdown: string): Array<{ key: string; checked: boolean }> {
  return markdown.split(/\r?\n/).flatMap((text) => { const match = line.exec(text); return match ? [{ key: checklistKey(match[4]!), checked: match[2] !== ' ' }] : [] })
}

/** Failure note the tester appends to an unchecked item: ` — failed: <reason>` (`falhou` in pt-BR). Only these words count: any other note (e.g. `pendente:`) is not a failure. */
const failureNote = /\s(?:—|–|--?)\s*(?:fail(?:ed|ure|s)?|falh(?:ou|a|as)|erros?|errors?|reprovad[oa])\s*:\s*\S/iu
/** Note for an item the tester could not verify (needs a manual check, missing tool...): ` — pending: <what is missing>`. It is not a failure. */
const blockedNote = /\s(?:—|–|--?)\s*(?:pending|pendente|blocked|bloqueado|manual)\s*:\s*\S/iu

/** Items the tester left unchecked with a failure note (not the ones simply not verified yet), as written in the checklist. */
export function failedChecklistItems(markdown: string): string[] {
  return markdown.split(/\r?\n/).flatMap((text) => { const match = line.exec(text); return match && match[2] === ' ' && failureNote.test(match[4]!) ? [match[4]!.trim()] : [] })
}

/** Unchecked items the tester could not verify and explained why (`pending:`/`pendente:`): they wait for the user, nothing to send to the developer. */
export function blockedChecklistItems(markdown: string): string[] {
  return markdown.split(/\r?\n/).flatMap((text) => { const match = line.exec(text); return match && match[2] === ' ' && !failureNote.test(match[4]!) && blockedNote.test(match[4]!) ? [match[4]!.trim()] : [] })
}

/** Tester's checklist: what they will verify, checked off as they verify (by the agent or the user). The app shows it beside the test chat. */
export class ChecklistRepository {
  constructor(private readonly database: AppDatabase) {}

  get(cardId: string): CardChecklist {
    const row = this.database.db.prepare("SELECT content_md AS contentMd, updated_at AS updatedAt, marks FROM card_checklists WHERE card_id = ? AND purpose = 'test'").get(cardId) as { contentMd: string; updatedAt: string; marks: string | null } | undefined
    let marks: Marks = {}
    try { if (row?.marks) marks = JSON.parse(row.marks) as Marks } catch { /* bad marks: start over without them */ }
    return { cardId, contentMd: row?.contentMd ?? '', updatedAt: row?.updatedAt ?? null, marks }
  }

  /**
   * Saves the whole checklist; it must have at least one `- [ ]` or `- [x]` item. Each item whose state changed compared to what
   * was saved is marked as changed by `by` (the agent, when it saves; the user, when they click).
   */
  write(cardId: string, contentMd: string, by: 'user' | 'agent' = 'agent'): CardChecklist {
    if (!item.test(contentMd)) throw new Error(tm().checklists.invalidFormat)
    const before = this.get(cardId), was = new Map(itemsOf(before.contentMd).map((entry) => [entry.key, entry.checked])), at = new Date().toISOString(), marks: Marks = {}
    for (const entry of itemsOf(contentMd)) {
      const old = before.marks[entry.key]
      if (was.get(entry.key) === entry.checked && old) marks[entry.key] = old
      else if (was.get(entry.key) !== entry.checked && (was.has(entry.key) || entry.checked)) {
        // The agent's OK stays recorded: the user can uncheck and check again without erasing it; only the agent itself redoes or removes it.
        if (by === 'agent') marks[entry.key] = entry.checked ? { by, at, agent: at } : { by, at }
        else marks[entry.key] = { by, at, ...(old?.agent ? { agent: old.agent } : {}) }
      }
    }
    this.database.db.prepare(`INSERT INTO card_checklists(card_id, purpose, content_md, updated_at, marks) VALUES (?, 'test', ?, ?, ?)
      ON CONFLICT(card_id, purpose) DO UPDATE SET content_md = excluded.content_md, updated_at = excluded.updated_at, marks = excluded.marks`).run(cardId, contentMd, at, JSON.stringify(marks))
    return this.get(cardId)
  }

  /** The user checks or unchecks an item by its markdown line; checks the text so as not to change another item if the agent rewrote the checklist. */
  toggle(cardId: string, lineNumber: number, text: string, checked: boolean): CardChecklist {
    const current = this.get(cardId), eol = current.contentMd.includes('\r\n') ? '\r\n' : '\n', lines = current.contentMd.split(/\r?\n/)
    const match = line.exec(lines[lineNumber] ?? '')
    if (!match || checklistKey(match[4]!) !== checklistKey(text)) throw new Error(tm().checklists.changedWhileClicking)
    lines[lineNumber] = `${match[1]}[${checked ? 'x' : ' '}]${match[3]}${match[4]}`
    return this.write(cardId, lines.join(eol), 'user')
  }
}
