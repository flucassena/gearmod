import { describe, expect, it } from 'vitest'
import { isMac } from './platform'

describe('platform', () => {
  it('recognizes the Mac from navigator.platform', () => {
    expect(isMac('MacIntel')).toBe(true)
    expect(isMac('Win32')).toBe(false)
    expect(isMac('Linux x86_64')).toBe(false)
  })
})
