import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentProbe, AgentProfile } from '@gearmod/contracts'
import { readAccountEmail } from './account'
import { checkAntigravity, type AntigravityCheck } from './antigravity-auth'
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
  constructor(private readonly profiles: ProfileRepository, private readonly runner: CommandRunner = systemRunner, private readonly launch: TerminalLaunch = systemLaunch, private readonly antigravity: AntigravityCheck = checkAntigravity) {}

  async probe(profileId: string): Promise<AgentProbe> {
    const profile = this.profiles.list().find((item) => item.id === profileId)
    if (!profile) throw new Error(tm().common.profileNotFound)
    const env = this.environment(profile)
    const command = currentCommand(profile, env)
    try {
      const versionResult = await this.runner.run(command, ['--version'], env)
      if (isAbsolute(command) && command !== profile.executablePath) this.profiles.setExecutable(profile.id, command)
      const version = versionResult.stdout.trim() || versionResult.stderr.trim() || null
      // Antigravity: one ACP handshake answers both "logged in?" and "which account?" (the e-mail is not in any file the app can read).
      const gemini = profile.provider === 'gemini' ? await this.antigravity(command, env) : null
      const authenticated = gemini ? gemini.authenticated : await this.authentication(profile, command, env)
      const account = gemini ? gemini.account : authenticated ? readAccountEmail(profile) : null
      return { profileId, provider: profile.provider, installed: true, authenticated, version, executablePath: command, capabilities: profile.provider === 'codex' ? ['app-server', 'streaming', 'resume', 'approvals', 'plan'] : profile.provider === 'gemini' ? ['acp', 'resume', 'plan', 'approvals', 'mcp'] : ['stream-json', 'resume', 'permissions', 'plan'], checkedAt: new Date().toISOString(), error: null, account }
    } catch (error) {
      return { profileId, provider: profile.provider, installed: false, authenticated: false, version: null, executablePath: command, capabilities: [], checkedAt: new Date().toISOString(), error: safeError(error), account: null }
    }
  }

  async probeAll(): Promise<AgentProbe[]> { return Promise.all(this.profiles.list().map((profile) => this.probe(profile.id))) }

  async detectProvider(provider: 'codex' | 'claude' | 'gemini'): Promise<{ installed: boolean; version: string | null; error: string | null }> {
    try {
      const result = await systemRunner.run(providerCommand(provider), ['--version'], process.env)
      return { installed: true, version: result.stdout.trim() || result.stderr.trim() || null, error: null }
    } catch (error) { return { installed: false, version: null, error: safeError(error) } }
  }

  installProvider(provider: 'codex' | 'claude' | 'gemini'): { started: true } {
    if (provider === 'gemini') return this.antigravityInstallWindow()
    const packageName = provider === 'codex' ? '@openai/codex@latest' : '@anthropic-ai/claude-code@latest'
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
    if (provider === 'gemini') return this.antigravityInstallWindow()
    const command = provider === 'claude' ? ['claude', 'update'] : ['npm', 'install', '-g', '@openai/codex@latest']
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
    if (provider === 'gemini') return antigravityInstallPlan(env, title)
    if (provider === 'claude') {
      const command = resolveCommand('claude', env)
      if (process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(command).toLowerCase())) return { file: env.ComSpec || 'cmd.exe', args: `/d /s /c "${[command, 'update'].map(quoteCmdArgument).join(' ')}"`, env, cwd: homedir(), title }
      return { file: command, args: ['update'], env, cwd: homedir(), title }
    }
    const npm = ['npm', 'install', '-g', '@openai/codex@latest']
    if (process.platform === 'win32') return { file: env.ComSpec || 'cmd.exe', args: `/d /s /c "${npm.join(' ')}"`, env, cwd: homedir(), title }
    return { file: npm[0]!, args: npm.slice(1), env, cwd: homedir(), title }
  }

  /**
   * Install command of the agent CLI to run in the in-app terminal, like `updatePlan`: the npm package of Claude/Codex, or Google's
   * official Antigravity installer (it asks questions on screen, so it always runs where the user can answer).
   */
  installPlan(provider: 'codex' | 'claude' | 'gemini'): CliPlan {
    const env = { ...process.env }, title = providerInstallTitle(provider)
    if (provider === 'gemini') return antigravityInstallPlan(env, title)
    const npm = ['npm', 'install', '-g', provider === 'codex' ? '@openai/codex@latest' : '@anthropic-ai/claude-code@latest']
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

  /** Antigravity installer (install and update) in a separate, visible window: it asks questions the user has to answer. */
  private antigravityInstallWindow(): { started: true } {
    const plan = antigravityInstallPlan({ ...process.env }, providerInstallTitle('gemini'), this.launch.platform)
    const args = Array.isArray(plan.args) ? plan.args : [plan.args]
    if (this.launch.platform === 'win32') this.launch.spawn('cmd.exe', ['/d', '/c', 'start', '', plan.file, '-NoExit', ...args], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    else this.launch.openInTerminal(plan.file, args, process.env)
    return { started: true }
  }

  private environment(profile: AgentProfile): NodeJS.ProcessEnv { return { ...process.env, ...profileHome(profile) } }

  private async authentication(profile: AgentProfile, command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
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

// Antigravity: `agy acp --login` signs in with Google in the terminal and exits (the plain `agy` opens the full interactive CLI).
const loginArgs = (profile: AgentProfile): string[] => profile.provider === 'codex' ? ['login'] : profile.provider === 'gemini' ? ['acp', '--login'] : ['auth', 'login']

const providerUpdateTitle = (provider: 'codex' | 'claude' | 'gemini'): string => provider === 'claude' ? 'claude update' : provider === 'gemini' ? 'Antigravity CLI' : 'npm install -g'
const providerInstallTitle = (provider: 'codex' | 'claude' | 'gemini'): string => provider === 'gemini' ? 'Antigravity CLI' : `npm install -g ${provider === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code'}`

/** Executable name of each provider: Gemini profiles run Google's Antigravity CLI (`agy`). */
export const providerCommand = (provider: 'codex' | 'claude' | 'gemini'): string => (provider === 'gemini' ? 'agy' : provider)

/** Google's official installer; it also updates an existing install. */
export function antigravityInstallPlan(env: NodeJS.ProcessEnv, title: string, platform: NodeJS.Platform = process.platform): CliPlan {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://antigravity.google/cli/install.ps1 | iex'], env, cwd: homedir(), title }
  return { file: 'bash', args: ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'], env, cwd: homedir(), title }
}

/** The variable that points the CLI to the profile's own folder (each profile has its own account). Antigravity has none: one account per OS user. */
function profileHome(profile: AgentProfile): NodeJS.ProcessEnv {
  return profile.provider === 'codex' ? { CODEX_HOME: profile.configDir } : profile.provider === 'gemini' ? {} : { CLAUDE_CONFIG_DIR: profile.configDir }
}

/**
 * The CLI to run now: looks it up again on each check (an update may have installed a newer copy elsewhere, e.g. npm instead of
 * the Codex desktop app) and only falls back to the path saved in the profile when the lookup finds nothing.
 * A Gemini profile saved with the old Gemini CLI path is ignored: only `agy` runs it now.
 */
function currentCommand(profile: AgentProfile, env: NodeJS.ProcessEnv): string {
  const name = providerCommand(profile.provider)
  const fresh = resolveCommand(name, env)
  const saved = profile.provider === 'gemini' && profile.executablePath && !/(^|[\\/])agy(\.exe)?$/i.test(profile.executablePath) ? null : profile.executablePath
  return isAbsolute(fresh) ? fresh : resolveCommand(saved || name, env)
}

export function resolveCommand(command: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') return command
  if (isAbsolute(command)) {
    if (existsSync(command)) return command
    command = /claude/i.test(command) ? 'claude' : /(^|[\\/])agy(\.exe)?$/i.test(command) ? 'agy' : /gemini/i.test(command) ? 'gemini' : 'codex'
  }
  const folders = [...new Set([
    ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean),
    join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm'),
    join(homedir(), '.local', 'bin'),
    join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'),
    // Antigravity's installer puts `agy.exe` here; a GearMod started before the install does not see it in the PATH.
    join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'agy', 'bin')
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
