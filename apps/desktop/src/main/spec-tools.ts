import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SpecKitRunInput, ToolsFolderInfo, ToolsStatus } from '@gearmod/contracts'
import type { AppDatabase } from './database'
import { nativeCommands, type CommandRunner } from './playwright-cli'
import { tm } from './i18n'

/** First `x.y.z` version in a `--version` output; `null` if there is none. */
const versionOf = (output: string): string | null => /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)?.[1] ?? null

/** Folders (and name pattern) that `specify init` creates for each integration; just a hint of which agent was configured. */
const integrationTraces: Array<{ id: string; folder: string; pattern: RegExp }> = [
  { id: 'claude', folder: join('.claude', 'commands'), pattern: /^speckit/i }, { id: 'claude', folder: join('.claude', 'skills'), pattern: /^speckit/i },
  { id: 'codex', folder: join('.codex', 'prompts'), pattern: /^speckit/i }, { id: 'codex', folder: join('.agents', 'skills'), pattern: /^speckit/i },
  { id: 'copilot', folder: join('.github', 'prompts'), pattern: /^speckit/i }, { id: 'cursor', folder: join('.cursor', 'commands'), pattern: /^speckit/i },
  { id: 'gemini', folder: join('.gemini', 'commands'), pattern: /^speckit/i }, { id: 'windsurf', folder: join('.windsurf', 'workflows'), pattern: /^speckit/i },
  { id: 'opencode', folder: join('.opencode', 'command'), pattern: /^speckit/i }, { id: 'qwen', folder: join('.qwen', 'commands'), pattern: /^speckit/i }
]

/** Spec Kit integrations in a repository: `.specify/integration.json` (when the CLI writes it) or the command files it leaves behind. */
export function specKitIntegrations(repo: string): string[] {
  const found = new Set<string>()
  try {
    const saved = JSON.parse(readFileSync(join(repo, '.specify', 'integration.json'), 'utf8')) as { integration?: unknown; integrations?: unknown }
    for (const item of [saved.integration, ...(Array.isArray(saved.integrations) ? saved.integrations : [])]) if (typeof item === 'string' && item) found.add(item)
  } catch { /* no file: falls back to the traces */ }
  for (const trace of integrationTraces) { try { if (readdirSync(join(repo, trace.folder)).some((name) => trace.pattern.test(name))) found.add(trace.id) } catch { /* folder absent */ } }
  return [...found]
}

/** Spec Kit version that wrote each integration's files (`.specify/integrations/<name>.manifest.json`); older repos fall back to `integration.json`. */
export function specKitFileVersions(repo: string, integrations: string[]): Record<string, string> {
  const read = (file: string): Record<string, unknown> | null => { try { return JSON.parse(readFileSync(join(repo, '.specify', ...file.split('/')), 'utf8')) as Record<string, unknown> } catch { return null } }
  const general = read('integration.json')?.version
  const out: Record<string, string> = {}
  for (const name of integrations) {
    const version = read(`integrations/${name}.manifest.json`)?.version ?? general
    if (typeof version === 'string' && version) out[name] = version
  }
  return out
}

export type SpecKitStage = 'specify' | 'clarify' | 'plan' | 'checklist' | 'tasks' | 'analyze' | 'implement'

/** `speckit-implement` request in the planning chat: run control refuses and the screen offers to move the card. */
export class SpecKitImplementBlocked extends Error {
  constructor() { super(tm().speckit.implementBlocked) }
}

/** Blocks the explicit invocation of the implementation skill in planning.
 * This does not restrict other tools or prevent other file edits. */
export function isSpecKitImplementRequest(prompt: string, skill?: { name: string; path: string } | null): boolean {
  return /(?:^|[\s/\\$])speckit[-.]implement(?:\b|$)/i.test(prompt) ||
    Boolean(skill && /(?:^|[\s/\\$])speckit[-.]implement(?:\b|$)/i.test(`${skill.name} ${skill.path}`))
}

/** Checks the concrete skill, not just the traces or the integration manifest. Does not install or change files. */
export function specKitSkill(repo: string, provider: 'codex' | 'claude' | 'gemini', stage: SpecKitStage): string | null {
  if (!existsSync(join(repo, '.specify'))) return null
  const folder = provider === 'codex' ? join('.agents', 'skills') : join('.claude', 'skills')
  const skill = join(repo, folder, `speckit-${stage}`, 'SKILL.md')
  try { return readFileSync(skill, 'utf8').trim() ? skill : null } catch { return null }
}

/**
 * Only detects Spec Kit and OpenSpec (what is installed and which repositories were initialized). Whoever installs and updates is the app's terminal,
 * with fixed commands; nothing is ever installed here. Each command has a short maximum time and a missing command becomes `null`, not an error.
 */
export class SpecToolsService {
  constructor(private readonly database: AppDatabase, private readonly commands: CommandRunner = nativeCommands) {}

  private async version(command: string, args: string[]): Promise<string | null> { return this.commands.run(command, args, process.cwd(), 15_000).then(versionOf, () => null) }

  /**
   * A folder the user picked to run Spec Kit in, even when it is not one of the project's repositories: is it a Git repository (its own root), is it inside
   * another one, and is Spec Kit already there. Only reads; the app terminal does the `git init` and the `specify init`.
   */
  async inspectFolder(path: string): Promise<ToolsFolderInfo> {
    if (!existsSync(path)) throw new Error(tm().speckit.folderMissing)
    const real = (value: string): string => { try { return realpathSync.native(value).toLowerCase() } catch { return resolve(value).toLowerCase() } }
    const top = await this.commands.run('git', ['rev-parse', '--show-toplevel'], path, 10_000).then((output) => output.trim(), () => '')
    const isRepo = top !== '' && real(top) === real(path)
    return { isRepo, parentRepo: top !== '' && !isRepo ? top : null, hasSpecKit: existsSync(join(path, '.specify')), ...((integrations) => ({ integrations, integrationVersions: specKitFileVersions(path, integrations) }))(specKitIntegrations(path)) }
  }

  /**
   * What to run in the dialog's terminal for a Spec Kit step. Fixed commands: the only things that come from outside are a version (digits), an
   * integration name (letters, digits, "-" and "_") and a folder that must exist, and none of them is pasted into a shell line except those two validated words.
   * On Windows it goes through PowerShell, elsewhere through `sh`, so the user's PATH decides which `uv` and `specify` run.
   */
  terminalPlan(input: SpecKitRunInput): { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; title: string } {
    const env = { ...process.env }, windows = process.platform === 'win32'
    const folder = (): string => {
      const path = input.path ?? ''
      let isDir = false
      try { isDir = statSync(path).isDirectory() } catch { /* not there */ }
      if (!isDir) throw new Error(tm().speckit.folderMissing)
      return path
    }
    const version = (): string => { if (!input.version) throw new Error(tm().speckit.runNeedsVersion); return input.version }
    const install = (flags: string): string => `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v${version()}${flags}`
    let line: string, cwd = homedir()
    switch (input.kind) {
      case 'install-uv': line = windows ? 'winget install --id=astral-sh.uv -e' : 'curl -LsSf https://astral.sh/uv/install.sh | sh'; break
      case 'install-cli': line = install(''); break
      case 'update-cli': line = install(' --force'); break
      case 'init': cwd = folder(); line = 'specify init --here'; break
      case 'init-with-git': cwd = folder(); line = windows ? 'git init; if ($?) { specify init --here }' : 'git init && specify init --here'; break
      case 'upgrade-integration': {
        if (!input.integration) throw new Error(tm().speckit.runNeedsIntegration)
        cwd = folder(); line = `specify integration upgrade ${input.integration}`; break
      }
    }
    return windows ? { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', line], env, cwd, title: 'Spec Kit' } : { file: 'sh', args: ['-c', line], env, cwd, title: 'Spec Kit' }
  }

  async status(projectId: string): Promise<ToolsStatus> {
    const [node, uv, python, specify, openspec] = await Promise.all([
      this.version('node', ['--version']), this.version('uv', ['--version']),
      this.version('python', ['--version']).then((found) => found ?? this.version('python3', ['--version'])),
      this.version('specify', ['version']).then((found) => found ?? this.version('specify', ['--version'])), this.version('openspec', ['--version'])
    ])
    const repos = (this.database.db.prepare('SELECT id, name, local_path AS path FROM project_sources WHERE project_id = ? ORDER BY sort_order').all(projectId) as Array<{ id: string; name: string; path: string }>)
      .map((source) => { const integrations = specKitIntegrations(source.path); return { sourceId: source.id, name: source.name, path: source.path, specKit: existsSync(join(source.path, '.specify')), specKitIntegrations: integrations, specKitVersions: specKitFileVersions(source.path, integrations), openSpec: existsSync(join(source.path, 'openspec')) } })
    return { node, uv, python, specify: { installed: specify !== null, version: specify }, openspec: { installed: openspec !== null, version: openspec }, repos, log: '', error: null }
  }
}
