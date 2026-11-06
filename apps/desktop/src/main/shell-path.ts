import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Opened from the Linux applications menu or the Mac Dock/Finder, the app gets the desktop session's PATH, without what the user's shell adds
 * (nvm, `~/.npm-global/bin`, ...). Then `claude`/`codex`/`npm` are not found, neither by the probe nor by the in-app terminal.
 * At startup the app reads the PATH of the user's login shell (the same one a terminal gets) and merges it into its own.
 */
const marker = '__GEARMOD_PATH__'

/** PATH printed by the shell between the markers (`env` output, works in sh, bash, zsh and fish); null when it is not there. */
export function pathFromShellOutput(output: string): string | null {
  const start = output.indexOf(marker), end = output.lastIndexOf(marker)
  if (start < 0 || end <= start) return null
  const line = output.slice(start + marker.length, end).split(/\r?\n/).find((item) => item.startsWith('PATH='))
  return line ? line.slice('PATH='.length) : null
}

/** First the shell's folders (same order as in a terminal), then the ones only the app had, then the extras; no repeats. POSIX only (`:`). */
export function mergePath(shellPath: string | null, current: string | undefined, extras: string[] = []): string {
  const folders = [...(shellPath ?? '').split(':'), ...(current ?? '').split(':'), ...extras].filter(Boolean)
  return [...new Set(folders)].join(':')
}

/** Usual user install folders, added only when they exist (covers a shell that failed or has no PATH setup). On the Mac also Homebrew's. */
export function userBinFolders(home: string, exists: (path: string) => boolean = existsSync, platform: NodeJS.Platform = 'linux'): string[] {
  const user = ['.local/bin', '.npm-global/bin', '.bun/bin', '.volta/bin'].map((folder) => join(home, folder))
  const system = platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []
  return [...user, ...system].filter(exists)
}

/** Shell used to read the PATH: the user's, or the system default (zsh on the Mac since Catalina). */
export function loginShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
}

export interface ShellPathDeps { run(shell: string, args: string[], env: NodeJS.ProcessEnv): string }
const systemDeps: ShellPathDeps = {
  run: (shell, args, env) => execFileSync(shell, args, { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }),
}

/** Updates `env.PATH` with the login shell's PATH on Linux and macOS. A shell that fails or takes too long keeps the current PATH plus the extras. */
export function loadShellPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, deps: ShellPathDeps = systemDeps, home = homedir()): void {
  if (platform !== 'linux' && platform !== 'darwin') return
  let shellPath: string | null = null
  try {
    const output = deps.run(loginShell(env, platform), ['-ilc', `echo ${marker}; command env; echo ${marker}`], { ...env, DISABLE_AUTO_UPDATE: 'true' })
    shellPath = pathFromShellOutput(output)
  } catch { /* keeps the current PATH */ }
  env.PATH = mergePath(shellPath, env.PATH, userBinFolders(home, existsSync, platform))
}
