/**
 * Tracks consecutive closes of the auto-opened initial side chat (`FreeChat` with `docked: true`)
 * without sending any message. After 5 consecutive unused closes, suggests turning off `chatLateralInicial`.
 */

export type InitialChatDismissState = {
  streak: number
  declined: boolean
}

export type InitialChatEvent = 'closed-unused' | 'message-sent' | 'declined' | 'confirmed' | 'reenabled'

export const initialChatDismissLimit = 5
const storageKey = 'gearmod.initialChatDismiss'
const defaultState: InitialChatDismissState = { streak: 0, declined: false }

export function parseInitialChatDismiss(raw: string | null): InitialChatDismissState {
  if (!raw) return defaultState
  try {
    const parsed = JSON.parse(raw) as { streak?: unknown; declined?: unknown } | null
    if (!parsed || typeof parsed !== 'object') return defaultState
    const streak = typeof parsed.streak === 'number' && Number.isInteger(parsed.streak) && parsed.streak >= 0 ? parsed.streak : 0
    const declined = typeof parsed.declined === 'boolean' ? parsed.declined : false
    return { streak, declined }
  } catch {
    return defaultState
  }
}

export function nextInitialChatDismiss(
  state: InitialChatDismissState,
  event: InitialChatEvent
): { state: InitialChatDismissState; shouldPrompt: boolean } {
  if (event === 'closed-unused') {
    const streak = state.streak + 1
    return {
      state: { streak, declined: state.declined },
      shouldPrompt: !state.declined && streak === initialChatDismissLimit
    }
  }
  if (event === 'message-sent') {
    return { state: { streak: 0, declined: state.declined }, shouldPrompt: false }
  }
  if (event === 'declined') {
    return { state: { streak: 0, declined: true }, shouldPrompt: false }
  }
  return { state: defaultState, shouldPrompt: false }
}

export function readInitialChatDismiss(): InitialChatDismissState {
  try {
    return parseInitialChatDismiss(localStorage.getItem(storageKey))
  } catch {
    return defaultState
  }
}

export function saveInitialChatDismiss(state: InitialChatDismissState): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state))
  } catch {
    /* local preference only */
  }
}

export function recordInitialChatEvent(event: InitialChatEvent): { state: InitialChatDismissState; shouldPrompt: boolean } {
  const result = nextInitialChatDismiss(readInitialChatDismiss(), event)
  saveInitialChatDismiss(result.state)
  return result
}
