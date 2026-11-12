import { describe, expect, it } from 'vitest'
import { ipcContracts } from '@gearmod/contracts'
import { cardIdOf, stateChangingChannels } from './card-state-events'

describe('state-changing actions', () => {
  it('only lists channels that exist', () => {
    for (const channel of stateChangingChannels) expect(Object.keys(ipcContracts)).toContain(channel)
  })
  it('covers authorizing a commit and answering what waits for the user', () => {
    for (const channel of ['approvals:decide', 'git:request-decide', 'git:commit', 'collab:answer-question', 'collab:decide-change'] as const) expect(stateChangingChannels.has(channel)).toBe(true)
  })
  it('does not fire for plain reads', () => {
    for (const channel of ['approvals:list', 'git:requests', 'git:changes', 'projects:list'] as const) expect(stateChangingChannels.has(channel as never)).toBe(false)
  })
})

describe('cardIdOf', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  it('takes the card from the input, then from the result (an approval or a commit request carries it)', () => {
    expect(cardIdOf({ cardId: id }, undefined)).toBe(id)
    expect(cardIdOf({ id: 'approval' }, { id: 'approval', cardId: id })).toBe(id)
  })
  it('is null when the action is not tied to one card', () => {
    expect(cardIdOf({ requestId: 'x' }, { decided: true })).toBeNull()
    expect(cardIdOf(undefined, null)).toBeNull()
    expect(cardIdOf({ cardId: '' }, { cardId: 5 })).toBeNull()
  })
})
