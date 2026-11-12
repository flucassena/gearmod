import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  initialChatDismissLimit,
  nextInitialChatDismiss,
  parseInitialChatDismiss,
  readInitialChatDismiss,
  recordInitialChatEvent
} from './initialChatPref'

describe('initialChatPref', () => {
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('increments unused closes up to 5 and prompts only on the 5th consecutive close', () => {
    let state = { streak: 0, declined: false }
    for (let i = 1; i < initialChatDismissLimit; i++) {
      const step = nextInitialChatDismiss(state, 'closed-unused')
      expect(step.state.streak).toBe(i)
      expect(step.shouldPrompt).toBe(false)
      state = step.state
    }
    const fifth = nextInitialChatDismiss(state, 'closed-unused')
    expect(fifth.state.streak).toBe(5)
    expect(fifth.shouldPrompt).toBe(true)
    const sixth = nextInitialChatDismiss(fifth.state, 'closed-unused')
    expect(sixth.shouldPrompt).toBe(false)
  })

  it('resets the streak when a message is sent before reaching 5 closes', () => {
    let result = recordInitialChatEvent('closed-unused')
    result = recordInitialChatEvent('closed-unused')
    expect(result.state.streak).toBe(2)

    result = recordInitialChatEvent('message-sent')
    expect(result.state.streak).toBe(0)
    expect(result.shouldPrompt).toBe(false)

    for (let i = 1; i <= 4; i++) {
      result = recordInitialChatEvent('closed-unused')
      expect(result.shouldPrompt).toBe(false)
    }
    result = recordInitialChatEvent('closed-unused')
    expect(result.state.streak).toBe(5)
    expect(result.shouldPrompt).toBe(true)
  })

  it('blocks future prompts after the user declines and resets when manually re-enabled', () => {
    for (let i = 0; i < 5; i++) recordInitialChatEvent('closed-unused')
    const declined = recordInitialChatEvent('declined')
    expect(declined).toEqual({ state: { streak: 0, declined: true }, shouldPrompt: false })

    for (let i = 0; i < 6; i++) {
      expect(recordInitialChatEvent('closed-unused').shouldPrompt).toBe(false)
    }

    const reenabled = recordInitialChatEvent('reenabled')
    expect(reenabled).toEqual({ state: { streak: 0, declined: false }, shouldPrompt: false })

    for (let i = 1; i < 5; i++) {
      expect(recordInitialChatEvent('closed-unused').shouldPrompt).toBe(false)
    }
    expect(recordInitialChatEvent('closed-unused').shouldPrompt).toBe(true)
  })

  it('resets the streak when the user confirms disabling and falls back on invalid storage', () => {
    for (let i = 0; i < 5; i++) recordInitialChatEvent('closed-unused')
    expect(recordInitialChatEvent('confirmed')).toEqual({
      state: { streak: 0, declined: false },
      shouldPrompt: false
    })
    expect(parseInitialChatDismiss('{bad')).toEqual({ streak: 0, declined: false })
    expect(parseInitialChatDismiss('{"streak":-2,"declined":"yes"}')).toEqual({ streak: 0, declined: false })
    store.set('gearmod.initialChatDismiss', 'not-json')
    expect(readInitialChatDismiss()).toEqual({ streak: 0, declined: false })
  })
})
