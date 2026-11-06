import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boundsFor, readWindowState, writeWindowState } from './window-state'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))) })

const screen = { x: 0, y: 0, width: 1920, height: 1040 }

describe('window state file', () => {
  it('saves and reads back the size, position and maximized flag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-window-')); roots.push(root)
    const file = join(root, 'window-state.json')
    expect(readWindowState(file)).toBeNull()
    writeWindowState(file, { x: 40, y: 30, width: 1280, height: 800, maximized: true })
    expect(readWindowState(file)).toEqual({ x: 40, y: 30, width: 1280, height: 800, maximized: true })
  })

  it('ignores a corrupt or absurd file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-window-')); roots.push(root)
    const file = join(root, 'window-state.json')
    await writeFile(file, '{ nope'); expect(readWindowState(file)).toBeNull()
    await writeFile(file, JSON.stringify({ width: 10, height: 10 })); expect(readWindowState(file)).toBeNull()
    await writeFile(file, JSON.stringify({ width: 900, height: 700, x: 'a' })); expect(readWindowState(file)).toEqual({ width: 900, height: 700, maximized: false })
  })
})

describe('boundsFor', () => {
  it('keeps the saved position and size when they are on a screen', () => {
    expect(boundsFor({ x: 100, y: 80, width: 1200, height: 800, maximized: false }, [screen])).toEqual({ x: 100, y: 80, width: 1200, height: 800 })
  })

  it('drops the position when its screen is gone, and never exceeds the screen size', () => {
    expect(boundsFor({ x: 2500, y: 100, width: 3000, height: 2000, maximized: false }, [screen])).toEqual({ width: 1920, height: 1040 })
  })

  it('accepts a position on a second monitor to the left (negative coordinates)', () => {
    const left = { x: -1280, y: 0, width: 1280, height: 1024 }
    expect(boundsFor({ x: -1200, y: 50, width: 900, height: 700, maximized: false }, [left, screen])).toEqual({ x: -1200, y: 50, width: 900, height: 700 })
  })
})
