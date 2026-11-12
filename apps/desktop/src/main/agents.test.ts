import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentProbeService, resolveCommand, type CommandRunner, type TerminalLaunch } from './agents'
import { AppDatabase } from './database'
import { ProfileRepository } from './projects'
import { seedProfiles } from './test-helpers'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('AgentProbeService', () => {
  it('probes version and authentication in the isolated profile directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-probe-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    const runner: CommandRunner = { async run(command, args, env) { calls.push({ command, args, env }); return args[0] === '--version' ? { stdout: 'codex-cli 1.0.0', stderr: '' } : { stdout: 'Logged in using ChatGPT', stderr: '' } } }
    const profile = profiles.list().find((item) => item.provider === 'codex')!
    const result = await new AgentProbeService(profiles, runner).probe(profile.id)
    expect(result).toMatchObject({ installed: true, authenticated: true, version: 'codex-cli 1.0.0' })
    expect(calls[0]?.env.CODEX_HOME).toBe(profile.configDir)
    expect(calls[1]?.args).toEqual(['login', 'status'])
    database.close()
  })

  it('reports an unavailable executable without pretending authentication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-probe-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
    // Built at runtime so the fake key does not look like a real secret in the source.
    const fakeKey = ['sk', 'fake', 'value'].join('-')
    const runner: CommandRunner = { async run() { throw new Error(`spawn failed with ${fakeKey}`) } }
    const result = await new AgentProbeService(profiles, runner).probe(profiles.list()[0]!.id)
    expect(result.installed).toBe(false); expect(result.authenticated).toBe(false); expect(result.error).not.toContain(fakeKey)
    database.close()
  })

  it('creates the profile folder before the Codex login (Codex refuses a CODEX_HOME that does not exist)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-probe-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root)
    const profile = profiles.create({ provider: 'codex', label: 'Codex', scope: 'Pessoal' })
    expect(existsSync(profile.configDir)).toBe(false)
    const plan = new AgentProbeService(profiles).loginPlan(profile.id)
    expect(existsSync(profile.configDir)).toBe(true)
    expect(plan.env.CODEX_HOME).toBe(profile.configDir)
    expect(typeof plan.args === 'string' ? plan.args : plan.args.join(' ')).toMatch(/login/)
    expect(plan.title).toBe('Codex')
    database.close()
  })

  it('logs Claude in with `auth login` in its own folder and without secrets from the app environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-probe-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root)
    const profile = profiles.create({ provider: 'claude', label: 'Claude', scope: 'Pessoal' })
    process.env.GEARMOD_TEST_SECRET_TOKEN = 'secret'
    try {
      const plan = new AgentProbeService(profiles).loginPlan(profile.id)
      expect(plan.env.CLAUDE_CONFIG_DIR).toBe(profile.configDir)
      expect(plan.env.GEARMOD_TEST_SECRET_TOKEN).toBeUndefined()
      expect(typeof plan.args === 'string' ? plan.args : plan.args.join(' ')).toMatch(/auth.+login/)
    } finally { delete process.env.GEARMOD_TEST_SECRET_TOKEN }
    database.close()
  })
  it.runIf(process.platform === 'win32')('finds Codex in the current npm package layout before the desktop app copy, and probes pick it up over a saved path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-probe-')); roots.push(root)
    const vendor = join(root, 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin')
    const desktop = join(root, 'Programs', 'OpenAI', 'Codex', 'bin')
    mkdirSync(vendor, { recursive: true }); mkdirSync(desktop, { recursive: true }); mkdirSync(join(root, 'Local'), { recursive: true })
    writeFileSync(join(vendor, 'codex.exe'), ''); writeFileSync(join(desktop, 'codex.exe'), '')
    const env = { PATH: desktop, APPDATA: join(root, 'Roaming'), LOCALAPPDATA: join(root, 'Local'), USERPROFILE: root }
    expect(resolveCommand('codex', env)).toBe(join(vendor, 'codex.exe'))
    const saved = { PATH: process.env.PATH, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE }
    Object.assign(process.env, env)
    try {
      const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
      const profiles = new ProfileRepository(database, root), profile = profiles.create({ provider: 'codex', label: 'Codex', scope: 'Pessoal' })
      profiles.setExecutable(profile.id, join(desktop, 'codex.exe'))
      const calls: string[] = []
      const runner: CommandRunner = { async run(command, args) { calls.push(command); return args[0] === '--version' ? { stdout: 'codex-cli 0.166.0', stderr: '' } : { stdout: 'Logged in', stderr: '' } } }
      await new AgentProbeService(profiles, runner).probe(profile.id)
      expect(calls[0]).toBe(join(vendor, 'codex.exe'))
      expect(profiles.get(profile.id).executablePath).toBe(join(vendor, 'codex.exe'))
      database.close()
    } finally { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  })

  it('updates Codex through npm and Claude with `claude update`', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-probe-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const service = new AgentProbeService(new ProfileRepository(database, root))
    const text = (plan: { file: string; args: string[] | string }): string => `${plan.file} ${typeof plan.args === 'string' ? plan.args : plan.args.join(' ')}`
    expect(text(service.updatePlan('codex'))).toContain('npm install -g @openai/codex@latest')
    expect(text(service.updatePlan('claude'))).toMatch(/claude.*update/i)
    expect(text(service.installPlan('claude'))).toContain('npm install -g @anthropic-ai/claude-code@latest')
    expect(text(service.installPlan('codex'))).toContain('npm install -g @openai/codex@latest')
    database.close()
  })
})

describe('AgentProbeService terminals', () => {
  const noRunner: CommandRunner = { async run() { throw new Error('not used') } }
  function fakeLaunch(platform: NodeJS.Platform): TerminalLaunch & { spawned: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }>; opened: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> } {
    const spawned: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
    const opened: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    return {
      platform, spawned, opened,
      spawn: ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => { spawned.push({ command, args, env: options.env }); return { unref() {} } }) as unknown as TerminalLaunch['spawn'],
      openInTerminal: (command, args, env = process.env) => { opened.push({ command, args, env }) },
    }
  }
  async function setup(): Promise<{ profiles: ProfileRepository; close: () => void }> {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-launch-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
    return { profiles, close: () => database.close() }
  }

  it('opens install, update and login in a terminal window on Linux', async () => {
    const { profiles, close } = await setup()
    const launch = fakeLaunch('linux')
    const service = new AgentProbeService(profiles, noRunner, launch)
    service.installProvider('codex')
    service.updateProvider('claude')
    service.updateProvider('gemini')
    const claude = profiles.list().find((item) => item.provider === 'claude')!
    service.login(claude.id)
    expect(launch.spawned).toEqual([])
    expect(launch.opened.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: 'npm', args: ['install', '-g', '@openai/codex@latest'] },
      { command: 'claude', args: ['update'] },
      { command: 'bash', args: ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'] },
      { command: resolveCommand(claude.executablePath || claude.provider, launch.opened[3]!.env), args: ['auth', 'login'] },
    ])
    // The login runs with the profile's isolated config directory.
    expect(launch.opened[3]!.env.CLAUDE_CONFIG_DIR).toBe(claude.configDir)
    close()
  })

  it('lets the no-terminal error reach the caller on Linux', async () => {
    const { profiles, close } = await setup()
    const launch = fakeLaunch('linux')
    launch.openInTerminal = () => { throw new Error('sem terminal') }
    expect(() => new AgentProbeService(profiles, noRunner, launch).installProvider('claude')).toThrow('sem terminal')
    close()
  })

  it('keeps using cmd.exe on Windows', async () => {
    const { profiles, close } = await setup()
    const launch = fakeLaunch('win32')
    const service = new AgentProbeService(profiles, noRunner, launch)
    service.installProvider('claude')
    service.updateProvider('claude')
    const codex = profiles.list().find((item) => item.provider === 'codex')!
    service.login(codex.id)
    expect(launch.opened).toEqual([])
    expect(launch.spawned.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: 'cmd.exe', args: ['/d', '/c', 'start', '', 'cmd.exe', '/k', 'npm', 'install', '-g', '@anthropic-ai/claude-code@latest'] },
      { command: 'cmd.exe', args: ['/d', '/c', 'start', '', 'cmd.exe', '/k', 'claude', 'update'] },
      { command: 'cmd.exe', args: ['/d', '/c', 'start', '', resolveCommand(codex.executablePath || codex.provider, launch.spawned[2]!.env!), 'login'] },
    ])
    expect(launch.spawned[2]!.env!.CODEX_HOME).toBe(codex.configDir)
    close()
  })
})
