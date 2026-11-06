import { describe, expect, it } from 'vitest'
import { macTerminalScript, openInMacTerminal } from './mac-terminal'

describe('terminal on the Mac', () => {
  it('writes a script that deletes itself, carries the environment and runs the command', () => {
    const script = macTerminalScript('claude', ['/login'], { PATH: '/opt/homebrew/bin:/usr/bin', CLAUDE_CONFIG_DIR: "/Users/ana/it's here", 'BAD-NAME': 'x', EMPTY: undefined })
    const lines = script.split('\n')
    expect(lines[0]).toBe('#!/bin/sh')
    expect(lines[1]).toBe('rm -f "$0"')
    expect(script).toContain('export PATH=/opt/homebrew/bin:/usr/bin')
    expect(script).toContain("export CLAUDE_CONFIG_DIR='/Users/ana/it'\\''s here'")
    expect(script).not.toContain('BAD-NAME')
    expect(script).not.toContain('EMPTY')
    expect(script).toContain('claude /login;')
  })

  it('opens the script with Terminal', () => {
    const written: string[] = [], spawned: Array<{ command: string; args: string[] }> = []
    openInMacTerminal('npm', ['install', '-g', 'x'], { PATH: '/usr/bin' }, { writeScript: (path) => written.push(path), spawn: (command, args) => spawned.push({ command, args }) }, '/tmp')
    expect(written[0]).toMatch(/gearmod-.+\.command$/)
    expect(spawned).toEqual([{ command: 'open', args: ['-a', 'Terminal', written[0]] }])
  })
})
