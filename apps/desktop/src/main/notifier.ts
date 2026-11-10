import type { ChatPurpose } from '@gearmod/contracts'

import { tm } from './i18n'

export type FinishStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
export interface NoticeInput {
  status: FinishStatus
  purpose: ChatPurpose
  /** Title of the card (or of the free chat). */
  title: string
  hasPlan: boolean
  pending: { changes: number; questions: number }
  error?: string | null
}
export interface Notice { title: string; body: string }

const clip = (text: string, max = 140): string => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat }

/** What to notify when an agent finishes (null = no notification): completion, plan ready, failure, or something that needs the user. */
export function finishNotice(input: NoticeInput): Notice | null {
  if (input.status !== 'completed' && input.status !== 'failed') return null
  const name = input.title.trim() || tm().notifier.newCard
  if (input.pending.changes > 0) return { title: tm().notifier.changeAwaitingApproval, body: name }
  if (input.pending.questions > 0) return { title: tm().notifier.questionForYou, body: name }
  if (input.status === 'failed') {
    const what = input.purpose === 'planning' ? tm().notifier.planningFailed : input.purpose === 'test' ? tm().notifier.testFailed : input.purpose === 'free' || input.purpose === 'constitution' || input.purpose === 'conflict' || input.purpose === 'test-setup' ? tm().notifier.chatFailed : tm().notifier.executionFailed
    return { title: what, body: input.error ? `${name} — ${clip(input.error, 100)}` : name }
  }
  if (input.purpose === 'execution') return { title: tm().notifier.executionDone, body: name }
  if (input.purpose === 'test') return { title: tm().notifier.testDone, body: name }
  if (input.purpose === 'planning') return input.hasPlan ? { title: tm().notifier.planReady, body: name } : null
  return { title: tm().notifier.agentReplied, body: name }
}

export interface OpenTarget { projectId: string; cardId: string | null; chatId: string | null; purpose: ChatPurpose | null }

/** Sends the system notification (only when the app is out of focus and notifications are on); clicking it opens the card chat or the free chat. */
export class Notifier {
  constructor(private readonly deps: { enabled(): boolean; focused(): boolean; show(notice: Notice, onClick: () => void): void; open(target: OpenTarget): void }) {}

  notify(notice: Notice, target: OpenTarget): boolean {
    if (!this.deps.enabled() || this.deps.focused()) return false
    this.deps.show(notice, () => this.deps.open(target))
    return true
  }
}
