import { readFileSync, writeFileSync } from 'node:fs'

export interface Rect { x: number; y: number; width: number; height: number }
export interface WindowState { x?: number; y?: number; width: number; height: number; maximized: boolean }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Last state of the main window, or null when there is none (first run) or the file is unreadable. */
export function readWindowState(file: string): WindowState | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<WindowState>
    if (!finite(data.width) || !finite(data.height) || data.width < 200 || data.height < 200) return null
    return { ...(finite(data.x) && finite(data.y) ? { x: Math.round(data.x), y: Math.round(data.y) } : {}), width: Math.round(data.width), height: Math.round(data.height), maximized: data.maximized === true }
  } catch { return null }
}

export function writeWindowState(file: string, state: WindowState): void {
  try { writeFileSync(file, JSON.stringify(state)) } catch { /* the next close tries again */ }
}

/**
 * Bounds to open the window with: the saved size, and the saved position only if the title strip is still reachable on some screen
 * (a monitor may have been unplugged since). Without a usable position the system centers it. The size never exceeds the screen.
 */
export function boundsFor(state: WindowState, workAreas: Rect[]): Partial<Rect> {
  const largest = workAreas.reduce<Rect | undefined>((best, area) => (!best || area.width * area.height > best.width * best.height ? area : best), undefined)
  const width = largest ? Math.min(state.width, largest.width) : state.width, height = largest ? Math.min(state.height, largest.height) : state.height
  if (state.x === undefined || state.y === undefined) return { width, height }
  const { x, y } = state
  // The top-left corner of the title strip (a 120 x 40 piece) must fall inside a screen.
  const reachable = workAreas.some((area) => x + 120 > area.x && x < area.x + area.width - 40 && y >= area.y - 8 && y + 40 < area.y + area.height)
  return reachable ? { x, y, width, height } : { width, height }
}
