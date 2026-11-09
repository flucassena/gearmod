import { randomUUID } from 'node:crypto'
import type { AgentPermission } from '@gearmod/contracts'
import type { AgentEvent } from './adapters'

/** Callbacks exist only while their originating run is alive. Never replay approvals on resume. */
export class AgentPermissions {
  private readonly pending = new Map<string, { request: AgentPermission; finish(allow: boolean): void }>()
  /** Chats with a permission request waiting for the user right now. */
  chats(): string[] { return [...new Set([...this.pending.values()].map(({ request }) => request.chatId))] }
  list(chatId: string): AgentPermission[] { return [...this.pending.values()].filter(({ request }) => request.chatId === chatId).map(({ request }) => request) }
  request(input: Omit<AgentPermission, 'id'>, signal: AbortSignal, publish: (event: AgentEvent) => void): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
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
  decide(runId: string, requestId: string, allow: boolean): boolean {
    const item = this.pending.get(requestId)
    if (!item || item.request.runId !== runId) return false
    item.finish(allow); return true
  }
  closeRun(runId: string): void { for (const item of this.pending.values()) if (item.request.runId === runId) item.finish(false) }
}
