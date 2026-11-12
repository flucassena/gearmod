import type { IpcChannel } from '@gearmod/contracts'

/**
 * Actions the user takes that change what is waiting for them (a commit authorized, a question answered, a change decided, a card moved...).
 * Everything that shows that state (the chat's "needs you", the Git tab dot, the board tile, the sidebar) refreshes on `gearmod/card-updated`, but only
 * what the agent does used to send it; the user's own actions waited for the next poll. After one of these channels succeeds the app now sends the event
 * at once, so every screen follows without delay.
 */
export const stateChangingChannels: ReadonlySet<IpcChannel> = new Set<IpcChannel>([
  'approvals:decide', 'plans:approve', 'reviews:approve-local', 'speckit:choose', 'speckit:request-move',
  'git:request-decide', 'git:commit', 'git:commit-action', 'git:rename-commit', 'git:conflict-resolve',
  'collab:decide-change', 'collab:answer-question', 'collab:send-change',
  'cards:move', 'cards:archive', 'cards:finalize', 'cards:resume', 'cards:mark-viewed'
])

/** The card the action was about: the input's, or the one in the result (an approval or a commit request carries its card). Null when it is not tied to one card. */
export function cardIdOf(input: unknown, output: unknown): string | null {
  const read = (value: unknown): string | null => {
    const id = value && typeof value === 'object' ? (value as { cardId?: unknown }).cardId : undefined
    return typeof id === 'string' && id ? id : null
  }
  return read(input) ?? read(output)
}
