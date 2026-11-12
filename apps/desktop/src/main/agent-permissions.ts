import { randomUUID } from 'node:crypto'
import type { AgentPermission } from '@gearmod/contracts'
import type { AgentEvent } from './adapters'

/** Callbacks exist only while their originating run is alive. Never replay approvals on resume. */
/** Never approved on their own: leaving plan mode starts the implementation, so the user always decides it. */
const alwaysAsk = new Set(['ExitPlanMode'])

export class AgentPermissions {
  /**
   * Chats where the user chose "allow everything from now on". The scope is the chat (not one run, which is a single turn), only in memory
   * (a restart asks again), and tied to planning vs. execution: a run of the other kind turns it off, so approving reads while planning
   * never approves commands later when the chat starts implementing.
   */
  private readonly always = new Map<string, { planning: boolean }>()
  private readonly pending = new Map<string, { request: AgentPermission; finish(allow: boolean): void }>()
  /** Chats with a permission request waiting for the user right now. */
  chats(): string[] { return [...new Set([...this.pending.values()].map(({ request }) => request.chatId))] }
  list(chatId: string): AgentPermission[] { return [...this.pending.values()].filter(({ request }) => request.chatId === chatId).map(({ request }) => request) }
  autoAllowed(chatId: string): boolean { return this.always.has(chatId) }
  /** Turns "allow everything" off for the chat; returns whether it was on. */
  stopAuto(chatId: string): boolean { return this.always.delete(chatId) }
  request(input: Omit<AgentPermission, 'id'>, signal: AbortSignal, publish: (event: AgentEvent) => void): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    const auto = this.always.get(input.chatId)
    if (auto && auto.planning !== Boolean(input.planning)) { this.always.delete(input.chatId); publish({ type: 'gearmod/permission-resolved', payload: { requestId: null, chatId: input.chatId, allow: false } }) }
    else if (auto && !alwaysAsk.has(input.kind)) return Promise.resolve(true)
    const request = { ...input, id: randomUUID() }
    return new Promise((resolve) => {
      const abort = (): void => finish(false)
      const finish = (allow: boolean): void => {
        if (!this.pending.delete(request.id)) return
        signal.removeEventListener('abort', abort)
        publish({ type: 'gearmod/permission-resolved', payload: { requestId: request.id, chatId: request.chatId, allow } })
        resolve(allow)
      }
      this.pending.set(request.id, { request, finish })
      signal.addEventListener('abort', abort, { once: true })
      publish({ type: 'gearmod/permission-requested', payload: { ...request } })
    })
  }
  /** `always` (only with allow): also approves, from now on, every other request of the chat, and what is already waiting in it. */
  decide(runId: string, requestId: string, allow: boolean, always = false): boolean {
    const item = this.pending.get(requestId)
    if (!item || item.request.runId !== runId) return false
    const { chatId, planning } = item.request
    if (allow && always && !alwaysAsk.has(item.request.kind)) {
      this.always.set(chatId, { planning: Boolean(planning) })
      for (const other of [...this.pending.values()]) if (other.request.chatId === chatId && !alwaysAsk.has(other.request.kind)) other.finish(true)
    }
    item.finish(allow); return true
  }
  closeRun(runId: string): void { for (const item of this.pending.values()) if (item.request.runId === runId) item.finish(false) }
}
