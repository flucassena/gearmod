import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron'
import { titleBarOverlay } from './title-bar'

/**
 * What changes on macOS in the window and the menu. Pure functions (the platform comes as a parameter) so they can be tested anywhere.
 */

/**
 * Menu bar on macOS. Elsewhere the app has no menu (the top strip belongs to the app), but on the Mac copy/paste/undo
 * (Cmd+C, Cmd+V, Cmd+Z...), Cmd+Q and Cmd+H only work through the menu: without it, no text field accepts Cmd+V.
 */
export function appMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] | null {
  return platform === 'darwin' ? [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }] : null
}

/** Size of the Mac window buttons (close, minimize, zoom), used to center them in the top strip. */
const trafficLightsHeight = 14

/**
 * Own title bar. Windows and Linux: the system buttons sit on the right, over an overlay (starts in the dark theme).
 * macOS: the three buttons stay on the left, centered in the strip (the app leaves room for them in the CSS).
 */
export function titleBarOptions(platform: NodeJS.Platform, height: number): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'> {
  if (platform === 'darwin') return { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: Math.round((height - trafficLightsHeight) / 2) } }
  return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(platform, false, height) }
}

/** The development shortcuts (devtools, reload) use Cmd on the Mac and Ctrl elsewhere. */
export function primaryModifier(platform: NodeJS.Platform, input: { control: boolean; meta: boolean }): boolean {
  return platform === 'darwin' ? input.meta : input.control
}
