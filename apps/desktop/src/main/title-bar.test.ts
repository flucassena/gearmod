import { describe, expect, it } from 'vitest'
import { titleBarOverlay } from './title-bar'

describe('title bar overlay', () => {
  it('stays transparent on Windows', () => {
    expect(titleBarOverlay('win32', false, 44)).toEqual({ color: '#00000000', symbolColor: '#d4d9d5', height: 44 })
    expect(titleBarOverlay('win32', true, 44).symbolColor).toBe('#26303a')
  })

  it('uses the theme background on Linux, where a transparent overlay turns white', () => {
    expect(titleBarOverlay('linux', false, 44).color).toBe('#0b0b0b')
    expect(titleBarOverlay('linux', true, 44).color).toBe('#f4f6f8')
  })
})
