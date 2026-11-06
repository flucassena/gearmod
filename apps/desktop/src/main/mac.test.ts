import { describe, expect, it } from 'vitest'
import { appMenuTemplate, primaryModifier, titleBarOptions } from './mac'

describe('macOS window and menu', () => {
  it('has the app, edit and window menus only on the Mac (copy/paste need them there)', () => {
    expect(appMenuTemplate('darwin')!.map((item) => item.role)).toEqual(['appMenu', 'editMenu', 'windowMenu'])
    expect(appMenuTemplate('win32')).toBeNull()
    expect(appMenuTemplate('linux')).toBeNull()
  })

  it('puts the Mac window buttons on the left, centered in the strip, and keeps the overlay elsewhere', () => {
    expect(titleBarOptions('darwin', 44)).toEqual({ titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 15 } })
    expect(titleBarOptions('win32', 44)).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#d4d9d5', height: 44 } })
    expect(titleBarOptions('linux', 44).titleBarOverlay).toMatchObject({ color: '#0b0b0b' })
  })

  it('uses Cmd on the Mac and Ctrl elsewhere for the development shortcuts', () => {
    expect(primaryModifier('darwin', { control: false, meta: true })).toBe(true)
    expect(primaryModifier('darwin', { control: true, meta: false })).toBe(false)
    expect(primaryModifier('win32', { control: true, meta: false })).toBe(true)
  })
})
