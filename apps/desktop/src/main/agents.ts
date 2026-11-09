import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentProbe, AgentProfile } from '@gearmod/contracts'
import { readAccountEmail } from './account'
import { applyEnvPolicy } from './env-policy'
import type { ProfileRepository } from './projects'
import { tm } from './i18n'
import { openInTerminal } from './linux-terminal'
import { openInMacTerminal } from './mac-terminal'

const exec = promisify(execFile)
export interface CommandRunner { run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> }
const systemRunner: CommandRunner = { async run(command, args, env) {
  const executable = resolveCommand(command, env)
  if (process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(executable).toLowerCase())) {
    // Verbatim: without it Node escapes the quotes as `\"`, which cmd.exe does not understand ("'\"C:\...\claude.cmd\"' is not recognized").
    const commandLine = [executable, ...args].map(quoteCmdArgument).join(' ')
    return exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], { env, timeout: 10_000, windowsHide: true, windowsVerbatimArguments: true })
  }
  return exec(executable, args, { env, timeout: 10_000, windowsHide: true })
} }

/** How install/update/login open a terminal: `cmd` on Windows, Terminal.app on the Mac, a terminal emulator window on Linux. Injectable for tests. */
export interface TerminalLaunch {
  platform: NodeJS.Platform
  spawn: typeof spawn
  openInTerminal(command: string, args: string[], env: NodeJS.ProcessEnv): void
}
const systemLaunch: TerminalLaunch = { platform: process.platform, spawn, openInTerminal: process.platform === 'darwin' ? openInMacTerminal : openInTerminal }

export class AgentProbeService {
  constructor(private readonly profiles: ProfileRepository, private readonly runner: CommandRunner = systemRunner, private readonly launch: TerminalLaunch = systemLaunch) {}

  async probe(profileId: string): Promise<AgentProbe> {
    const profile = this.profiles.list().find((item) => item.id === profileId)
    if (!profile) throw new Error(tm().common.profileNotFound)
    const env = this.environment(profile)
    const command = currentCommand(profile, env)
    try {
      const versionResult = await this.runner.run(command, ['--version'], env)
      if (isAbsolute(command) && command !== profile.executablePath) this.profiles.setExecutable(profile.id, command)
      const version = versionResult.stdout.trim() || versionResult.stderr.trim() || null
      const authenticated = await this.authentication(profile, command, env)
      const account = authenticated ? readAccountEmail(profile) : null
      return { profileId, provider: profile.provider, installed: true, authenticated, version, executablePath: command, capabilities: profile.provider === 'codex' ? ['app-server', 'streaming', 'resume', 'approvals', 'plan'] : profile.provider === 'gemini' ? ['stream-json', 'resume', 'plan', 'skills', 'mcp'] : ['stream-json', 'resume', 'permissions', 'plan'], checkedAt: new Date().toISOString(), error: null, account }
    } catch (error) {
      return { profileId, provider: profile.provider, installed: false, authenticated: false, version: null, executablePath: command, capabilities: [], checkedAt: new Date().toISOString(), error: safeError(error), account: null }
    }
  }

  async probeAll(): Promise<AgentProbe[]> { return Promise.all(this.profiles.list().map((profile) => this.probe(profile.id))) }

  async detectProvider(provider: 'codex' | 'claude' | 'gemini'): Promise<{ installed: boolean; version: string | null; error: string | null }> {
    try {
      const result = await systemRunner.run(provider, ['--version'], process.env)
      return { installed: true, version: result.stdout.trim() || result.stderr.trim() || null, error: null }
    } catch (error) { return { installed: false, version: null, error: safeError(error) } }
  }

  installProvider(provider: 'codex' | 'claude' | 'gemini'): { started: true } {
    const packageName = provider === 'codex' ? '@openai/codex@latest' : provider === 'gemini' ? '@google/gemini-cli@latest' : '@anthropic-ai/claude-code@latest'
    if (this.launch.platform === 'win32') {
      const child = this.launch.spawn('cmd.exe', ['/d', '/c', 'start', '', 'cmd.exe', '/k', 'npm', 'install', '-g', packageName], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
    } else {
      this.launch.openInTerminal('npm', ['install', '-g', packageName], process.env)
    }
    return { started: true }
  }

  /** Updates the agent CLI in a terminal opened for the user to follow: `claude update` (works for native and npm installs) or Codex's npm. */
  updateProvider(provider: 'codex' | 'claude' | 'gemini'): { started: true } {
    const command = provider === 'claude' ? ['claude', 'update'] : provider === 'gemini' ? ['npm', 'install', '-g', '@google/gemini-cli@latest'] : ['npm', 'install', '-g', '@openai/codex@latest']
    if (this.launch.platform === 'win32') this.launch.spawn('cmd.exe', ['/d', '/c', 'start', '', 'cmd.exe', '/k', ...command], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    else this.launch.openInTerminal(command[0]!, command.slice(1), process.env)
    return { started: true }
  }

  /**
   * Update command to run in the in-app terminal: `claude update` (native and npm installs) or the npm package of Codex/Gemini.
   * Runs with the user's environment (it is npm, not an agent) from the home folder.
   */
  updatePlan(provider: 'codex' | 'claude' | 'gemini'): CliPlan {
    const env = { ...process.env }, title = providerUpdateTitle(provider)
    if (provider === 'claude') {
      const command = resolveCommand('claude', env)
      if (process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(command).toLowerCase())) return { file: env.ComSpec || 'cmd.exe', args: `/d /s /c "${[command, 'update'].map(quoteCmdArgument).join(' ')}"`, env, cwd: homedir(), title }
      return { file: command, args: ['update'], env, cwd: homedir(), title }
    }
    const npm = ['npm', 'install', '-g', provider === 'gemini' ? '@google/gemini-cli@latest' : '@openai/codex@latest']
    if (process.platform === 'win32') return { file: env.ComSpec || 'cmd.exe', args: `/d /s /c "${npm.join(' ')}"`, env, cwd: homedir(), title }
    return { file: npm[0]!, args: npm.slice(1), env, cwd: homedir(), title }
  }

  /** Install command of the agent CLI (its npm package) to run in the in-app terminal, like `updatePlan`. */
  installPlan(provider: 'codex' | 'claude' | 'gemini'): CliPlan {
    const env = { ...process.env }, title = providerInstallTitle(provider)
    const npm = ['npm', 'install', '-g', provider === 'codex' ? '@openai/codex@latest' : provider === 'gemini' ? '@google/gemini-cli@latest' : '@anthropic-ai/claude-code@latest']
    if (process.platform === 'win32') return { file: env.ComSpec || 'cmd.exe', args: `/d /s /c "${npm.join(' ')}"`, env, cwd: homedir(), title }
    return { file: npm[0]!, args: npm.slice(1), env, cwd: homedir(), title }
  }

  install(profileId: string): { started: true } {
    const profile = this.profiles.get(profileId)
    return this.installProvider(profile.provider)
  }

  /**
   * Login command of the profile's CLI, ready to run in the in-app terminal. The profile folder is created first:
   * Codex refuses to start when `CODEX_HOME` points to a folder that does not exist (Claude creates its own).
   */
  loginPlan(profileId: string): CliPlan {
    const profile = this.profiles.get(profileId)
    mkdirSync(profile.configDir, { recursive: true })
    const env = { ...applyEnvPolicy(profile, process.env), ...profileHome(profile) }
    const command = currentCommand(profile, { ...process.env, ...env })
    const args = loginArgs(profile)
    // A `.cmd` shim (npm) only runs through cmd.exe; the native `.exe` runs directly.
    if (process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(command).toLowerCase())) return { file: env.ComSpec || env.COMSPEC || 'cmd.exe', args: `/d /s /c "${[command, ...args].map(quoteCmdArgument).join(' ')}"`, env, cwd: homedir(), title: profile.label }
    return { file: command, args, env, cwd: homedir(), title: profile.label }
  }

  /** Login in a separate terminal window (kept for "Redo login" in the agent editor). */
  login(profileId: string): { started: true } {
    const profile = this.profiles.get(profileId)
    mkdirSync(profile.configDir, { recursive: true })
    const env = this.environment(profile), command = currentCommand(profile, env), args = loginArgs(profile)
    if (this.launch.platform === 'win32') {
      const child = this.launch.spawn('cmd.exe', ['/d', '/c', 'start', '', command, ...args], { env, detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
    } else {
      this.launch.openInTerminal(command, args, env)
    }
    return { started: true }
  }

  private environment(profile: AgentProfile): NodeJS.ProcessEnv { return { ...process.env, ...profileHome(profile) } }

  private async authentication(profile: AgentProfile, command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    // Gemini: logged in = the profile's OAuth credential or an API key enabled for the profile (nothing is executed or consumed here).
    if (profile.provider === 'gemini') return existsSync(join(profile.configDir, '.gemini', 'oauth_creds.json')) || Boolean(env.GEMINI_API_KEY && profile.envPassthrough.includes('GEMINI_API_KEY'))
    try {
      const result = await this.runner.run(command, profile.provider === 'codex' ? ['login', 'status'] : ['auth', 'status'], env)
      if (profile.provider === 'codex') return /logged in/i.test(`${result.stdout}\n${result.stderr}`)
      const status = JSON.parse(result.stdout) as { loggedIn?: boolean }
      return status.loggedIn === true
    } catch { return false }
  }
}

/** `args` as text is the raw Windows command line (needed by cmd.exe, which does not accept the usual quoting). */
export interface CliPlan { file: string; args: string[] | string; env: NodeJS.ProcessEnv; cwd: string; title: string }

// Gemini CLI has no login subcommand: opening the interactive CLI shows the login choice (Google or key); then just exit with /quit.
const loginArgs = (profile: AgentProfile): string[] => profile.provider === 'codex' ? ['login'] : profile.provider === 'gemini' ? [] : ['auth', 'login']

/** The variable that points the CLI to the profile's own folder (each profile has its own account). */
const providerUpdateTitle = (provider: 'codex' | 'claude' | 'gemini'): string => provider === 'claude' ? 'claude update' : 'npm install -g'
const providerInstallTitle = (provider: 'codex' | 'claude' | 'gemini'): string => `npm install -g ${provider === 'codex' ? '@openai/codex' : provider === 'gemini' ? '@google/gemini-cli' : '@anthropic-ai/claude-code'}`

function profileHome(profile: AgentProfile): NodeJS.ProcessEnv {
  return profile.provider === 'codex' ? { CODEX_HOME: profile.configDir } : profile.provider === 'gemini' ? { GEMINI_CLI_HOME: profile.configDir } : { CLAUDE_CONFIG_DIR: profile.configDir }
}

/**
 * The CLI to run now: looks it up again on each check (an update may have installed a newer copy elsewhere, e.g. npm instead of
 * the Codex desktop app) and only falls back to the path saved in the profile when the lookup finds nothing.
 */
function currentCommand(profile: AgentProfile, env: NodeJS.ProcessEnv): string {
  const fresh = resolveCommand(profile.provider, env)
  return isAbsolute(fresh) ? fresh : resolveCommand(profile.executablePath || profile.provider, env)
}

export function resolveCommand(command: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') return command
  if (isAbsolute(command)) {
    if (existsSync(command)) return command
    command = /claude/i.test(command) ? 'claude' : /gemini/i.test(command) ? 'gemini' : 'codex'
  }
  const folders = [...new Set([
    ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean),
    join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm'),
    join(homedir(), '.local', 'bin'),
    join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links')
  ])]
  if (command === 'codex') {
    // The desktop installation uses versioned folders and may not be in the
    // PATH inherited by an application launched from Windows Explorer.
    const desktopBin = join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin')
    if (existsSync(desktopBin)) {
      for (const entry of readdirSync(desktopBin, { withFileTypes: true }).filter((item) => item.isDirectory()).sort((a, b) => statSync(join(desktopBin, b.name)).mtimeMs - statSync(join(desktopBin, a.name)).mtimeMs)) {
        folders.push(join(desktopBin, entry.name))
      }
    }
    const npmVendor = join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex')
    const roots = [join(npmVendor, 'node_modules', '@openai', 'codex-win32-x64', 'vendor'), join(npmVendor, 'vendor')]
    for (const root of roots) {
      if (!existsSync(root)) continue
      // Current npm package: `vendor/<target>/bin/codex.exe`; older ones: `vendor/<target>/codex/codex.exe`.
      for (const entry of readdirSync(root)) folders.unshift(join(root, entry, 'codex'), join(root, entry, 'bin'))
    }
  }
  for (const extension of ['.exe', '.cmd', '.bat']) {
    for (const folder of folders) {
      const candidate = join(folder, `${command}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return command
}

function quoteCmdArgument(value: string): string { return `"${value.replace(/"/g, '""')}"` }

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  return value.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, '[redacted]').slice(0, 500)
}
