import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { holdScript, shellQuote } from './linux-terminal'

/**
 * Opens a command in a Terminal.app window on the Mac. Terminal does not take a command or an environment as arguments,
 * so the app writes a `.command` script (what Terminal runs when it opens one) with the environment and the command,
 * and opens it with `open -a Terminal`. The script deletes itself as soon as it starts, because it carries the environment.
 */
export interface MacTerminalDeps {
  writeScript(path: string, content: string): void
  spawn(command: string, args: string[]): void
}

const systemDeps: MacTerminalDeps = {
  writeScript: (path, content) => writeFileSync(path, content, { encoding: 'utf8', mode: 0o700 }),
  spawn(command, args) {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  },
}

/** The `.command` script: deletes itself, exports `env` (only names the shell accepts), then runs the command and waits for Enter. */
export function macTerminalScript(command: string, args: string[], env: NodeJS.ProcessEnv): string {
  const exports = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]))
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
  return ['#!/bin/sh', 'rm -f "$0"', ...exports, 'clear', holdScript(command, args), ''].join('\n')
}

/** Same contract as the Linux `openInTerminal`: opens `command args` in a visible terminal window, with `env`. */
export function openInMacTerminal(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, deps: MacTerminalDeps = systemDeps, folder = tmpdir()): void {
  const script = join(folder, `gearmod-${randomUUID()}.command`)
  deps.writeScript(script, macTerminalScript(command, args, env))
  deps.spawn('open', ['-a', 'Terminal', script])
}
