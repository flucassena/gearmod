/** Reading the Tasks document: only first-level items count as tasks; criteria are indented inside each task. */
import { tm } from './i18n'
const topLevelItem = /^[-*+]\s+\[( |x|X)\]\s+(.*)$/
const anyItem = /^\s*[-*+]\s+\[( |x|X)\]\s+/

export interface TaskCount { done: number; total: number }

export function countTasks(markdown: string): TaskCount {
  let done = 0, total = 0
  for (const line of markdown.split(/\r?\n/)) {
    const match = topLevelItem.exec(line)
    if (!match) continue
    total += 1
    if (match[1] !== ' ') done += 1
  }
  return { done, total }
}

/** Error in Portuguese for the agent to fix when Tasks departs from the format (the card counter depends on it). */
export function validateTasks(markdown: string): string | null {
  if (!markdown.trim()) return null
  if (countTasks(markdown).total === 0) return 'O documento Tasks precisa ter ao menos uma task de primeiro nível no formato "- [ ] T001 Descrição".'
  const indentedOnly = markdown.split(/\r?\n/).some((line) => /^\s+[-*+]\s+\[( |x|X)\]/.test(line) && !/^(\s{2,}|\t)/.test(line))
  return indentedOnly ? 'Os critérios de aceite devem ficar recuados (dois espaços) abaixo da task.' : null
}

const plainText = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const checkVerb = /^(rodar|executar|verificar|validar|confirmar|garantir|checar|conferir|testar manualmente|abrir|navegar|run|execute|verify|validate|confirm|ensure|check|open|navigate|manually test)\b/
const checkTarget = /\b(lint|type-?check|typecheck|tsc|suite|testes|tests?|regress\w*|continua\w* funcionando|still works?|build|manual\w*|e2e|end-to-end|playwright|smoke|na tela|no navegador|o app|a aplicacao|on screen|in the browser|the app)\b/

/**
 * Tasks that are only verification ("run lint, type-check and the suite", "confirm that X still works"): that belongs to the test step
 * (Test plan) or the developer's done rule, not to a task. Writing tests remains a normal task.
 */
export function verificationOnlyTasks(markdown: string): string[] {
  const found: string[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const match = topLevelItem.exec(line)
    if (!match) continue
    const id = /\bT\d{2,4}\b/.exec(match[2]!)?.[0]
    const text = plainText(match[2]!.replace(/\bT\d{2,4}\b/, '').replace(/\[[^\]]*\]/g, '').trim())
    if (checkVerb.test(text) && checkTarget.test(text)) found.push(id ?? match[2]!.slice(0, 40))
  }
  return found
}

/** Checks or unchecks the item (of any level) on the given line, counting lines from 0. */
export function setTaskChecked(markdown: string, lineIndex: number, checked: boolean): string {
  const lines = markdown.split('\n')
  const line = lines[lineIndex]
  if (line === undefined || !anyItem.test(line)) throw new Error(tm().tasks.notChecklistItem)
  lines[lineIndex] = line.replace(/\[( |x|X)\]/, checked ? '[x]' : '[ ]')
  return lines.join('\n')
}
