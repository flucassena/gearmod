import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { providerLabels, type AgentProfile, type SkillEntry, type SkillProviderState, type SkillScope } from '@gearmod/contracts'
import type { AgentAdapter } from './adapters'
import type { ProfileRepository, ProjectRepository } from './projects'
import { tm } from './i18n'

type Provider = 'claude' | 'codex' | 'gemini'
const providers: Provider[] = ['claude', 'codex', 'gemini']
// Antigravity (Gemini profiles) reads skills from `~/.gemini/config/skills` and, in the project, from `.agents/skills` (the same folder as Codex).
const globalFolder: Record<Provider, string> = { claude: '.claude', codex: '.codex', gemini: join('.gemini', 'config') }
const projectFolder: Record<Provider, string> = { claude: '.claude', codex: '.agents', gemini: '.agents' }
const nameRule = /^[a-z0-9][a-z0-9-]{0,63}$/

/** `name` and `description` header of a SKILL.md (a YAML subset enough for skills). */
export function parseSkillMd(text: string): { name: string | null; description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { name: null, description: '', body: text }
  const fields: Record<string, string> = {}
  const lines = match[1]!.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!)
    if (!line) continue
    let value = line[2]!.trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) { i += 1; parts.push(lines[i]!.trim()) }
      value = parts.join(' ')
    }
    fields[line[1]!] = value.replace(/^(["'])(.*)\1$/, '$2')
  }
  return { name: fields.name ?? null, description: fields.description ?? '', body: match[2]! }
}

/** Conversion rules between agents: header with only name/description and the other agent's references swapped. */
export function convertSkillMd(text: string, from: Provider, to: Provider): string {
  const parsed = parseSkillMd(text), name = parsed.name ?? 'skill'
  const description = parsed.description.replace(/"/g, '\\"')
  const target = { claude: { memory: 'CLAUDE.md', skills: '.claude/skills', name: 'Claude Code' }, codex: { memory: 'AGENTS.md', skills: '.agents/skills', name: 'Codex' }, gemini: { memory: 'GEMINI.md', skills: '.agents/skills', name: 'Antigravity' } }[to]
  const swaps: Array<[RegExp, string]> = [[/CLAUDE\.md|AGENTS\.md|GEMINI\.md/g, target.memory], [/\.claude\/skills|\.agents\/skills|\.gemini\/skills/g, target.skills], [/Claude Code|Gemini CLI|Antigravity|Codex/g, target.name]]
  const body = swaps.reduce((current, [pattern, value]) => current.replace(pattern, value), parsed.body)
  return `---\nname: ${name}\ndescription: "${description}"\n---\n${body.startsWith('\n') ? body : `\n${body}`}`
}

interface Found { provider: Provider; dir: string; name: string; description: string }

async function scanSkills(base: string, provider: Provider): Promise<Found[]> {
  if (!existsSync(base)) return []
  const found: Found[] = []
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(base, entry.name), file = join(dir, 'SKILL.md')
    if (!existsSync(file)) continue
    const parsed = parseSkillMd(await readFile(file, 'utf8'))
    found.push({ provider, dir, name: parsed.name ?? entry.name, description: parsed.description })
  }
  return found
}

const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.cache', 'coverage'])

/** Looks for folders with SKILL.md anywhere in a root (up to 5 levels, ignoring node_modules, .git and builds). The agent is inferred from the path: .claude → Claude; .agents/.codex → Codex; anything else assumes Claude. */
export async function discoverSkills(root: string, maxDepth = 5, budget = { left: 6000 }): Promise<Found[]> {
  const found: Found[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (budget.left-- <= 0) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      const parsed = parseSkillMd(await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => ''))
      const parts = dir.split(sep).map((part) => part.toLowerCase())
      found.push({ provider: parts.includes('.agents') || parts.includes('.codex') ? 'codex' : 'claude', dir, name: parsed.name ?? basename(dir), description: parsed.description })
      return
    }
    if (depth >= maxDepth) return
    for (const entry of entries) if ((entry.isDirectory() || entry.isSymbolicLink()) && !skipDirs.has(entry.name)) await walk(join(dir, entry.name), depth + 1)
  }
  if (existsSync(root)) await walk(root, 0)
  return found
}

export type SkillReviewer = { adapters: Record<Provider, AgentAdapter>; profile(profileId: string): AgentProfile }

/** Global skills (agent folders) and project skills (`.claude/skills`, `.agents/skills`): detection, import and conversion with per-agent review. */
export class SkillService {
  private readonly converting = new Map<string, 'convert' | 'review'>()  // key: scope|project|name|destination
  constructor(private readonly profiles: ProfileRepository, private readonly projects: ProjectRepository, private readonly reviewer?: SkillReviewer, private readonly home: string = homedir(), private readonly emit: (type: string, payload: Record<string, unknown>) => void = () => undefined, private readonly ledger?: { recordAuxiliary(profile: AgentProfile, source: 'skill-review', usage?: { input: number; cached: number; output: number; costUsd?: number }): void }) {}

  /**
   * "Global" skills live in a fixed app folder (not a secret, just instruction Markdown), shared by all
   * the provider's profiles — even after S07/S16 isolate each profile's config folder (credentials). That is why
   * the first item is always the fixed folder: whoever writes (`import`/`convert`) uses `globalBases(provider)[0]`.
   */
  private globalBases(provider: Provider): string[] {
    const dirs = [join(this.home, globalFolder[provider], 'skills')]
    // Antigravity has no per-profile folder (one account per OS user), so only Claude/Codex profiles add their own.
    if (provider !== 'gemini') dirs.push(...this.profiles.list().filter((profile) => profile.provider === provider).map((profile) => join(profile.configDir, 'skills')))
    return [...new Set(dirs)]
  }

  private projectBase(projectId: string, provider: Provider): string {
    const source = this.projects.get(projectId).sources[0]
    if (!source) throw new Error(tm().skills.projectHasNoFolder)
    return join(source.localPath, projectFolder[provider], 'skills')
  }

  private bases(scope: SkillScope, provider: Provider, projectId?: string): string[] {
    if (scope === 'global') return this.globalBases(provider)
    if (!projectId) throw new Error(tm().skills.enterProject)
    const roots = this.projects.get(projectId).sources.map((source) => join(source.localPath, projectFolder[provider], 'skills'))
    return [...new Set(roots)]
  }

  /** All the skills in the scope (with all the folders of each agent). Project: searches anywhere in the project folder and in the repositories. */
  private async collect(scope: SkillScope, projectId?: string): Promise<Array<Found & { origin: string }>> {
    const result: Array<Found & { origin: string }> = []
    if (scope === 'global') {
      for (const provider of providers) for (const base of this.globalBases(provider)) for (const skill of await scanSkills(base, provider)) result.push({ ...skill, origin: `${relative(this.home, skill.dir).split(sep).join('/')}`.replace(/^(?!\.\.)/, '~/') })
      return result
    }
    if (!projectId) throw new Error(tm().skills.enterProject)
    const project = this.projects.get(projectId), roots = [...new Set([project.localPath, ...project.sources.map((source) => source.localPath)])]
    const seen = new Set<string>(), budget = { left: 6000 }
    for (const root of roots) for (const skill of await discoverSkills(root, 5, budget)) {
      if (seen.has(skill.dir)) continue
      seen.add(skill.dir)
      const base = roots.filter((item) => skill.dir.startsWith(item)).sort((a, b) => b.length - a.length)[0] ?? root
      result.push({ ...skill, origin: relative(base, skill.dir).split(sep).join('/') })
    }
    return result
  }

  async list(scope: SkillScope, projectId?: string): Promise<SkillEntry[]> {
    const merged = new Map<string, SkillEntry>()
    for (const skill of await this.collect(scope, projectId)) {
      const entry = merged.get(skill.name) ?? { id: `${scope}:${skill.name}`, name: skill.name, description: skill.description, scope, detected: scope === 'project', providers: { claude: 'none', codex: 'none', gemini: 'none' }, paths: { claude: null, codex: null, gemini: null }, origin: skill.origin }
      entry.providers[skill.provider] = 'ready'; entry.paths[skill.provider] = skill.dir
      if (!entry.description) entry.description = skill.description
      merged.set(skill.name, entry)
    }
    for (const key of this.converting.keys()) {
      const [jobScope, jobProject, name, target] = key.split('|') as [SkillScope, string, string, Provider]
      const entry = merged.get(name)
      if (entry && jobScope === scope && (scope === 'global' || jobProject === projectId)) entry.providers[target] = 'converting' satisfies SkillProviderState
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Deletes the skill (of one agent or of all). Only deletes folders that detection itself found, never an arbitrary path. */
  async delete(input: { scope: SkillScope; projectId?: string; name: string; provider?: Provider }): Promise<SkillEntry[]> {
    const targets = (await this.collect(input.scope, input.projectId)).filter((skill) => skill.name === input.name && (!input.provider || skill.provider === input.provider))
    if (!targets.length) throw new Error(tm().skills.skillNotFound)
    for (const skill of targets) await rm(skill.dir, { recursive: true, force: true })
    return this.list(input.scope, input.projectId)
  }

  /** Imports at once all the skills (folders with SKILL.md) from a chosen folder; the ones that already exist are left out. */
  async importFolder(input: { scope: SkillScope; projectId?: string; folderPath: string; provider: Provider }): Promise<{ imported: string[]; skipped: string[]; skills: SkillEntry[] }> {
    const found = await discoverSkills(resolve(input.folderPath))
    if (!found.length) throw new Error(tm().skills.noSkillInFolder)
    const imported: string[] = [], skipped: string[] = []
    for (const skill of found) {
      const name = skill.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
      if (!nameRule.test(name)) { skipped.push(skill.name); continue }
      try { await this.import({ scope: input.scope, projectId: input.projectId, sourcePath: skill.dir, name, provider: input.provider }); imported.push(name) } catch { skipped.push(name) }
    }
    return { imported, skipped, skills: await this.list(input.scope, input.projectId) }
  }

  async import(input: { scope: SkillScope; projectId?: string; sourcePath: string; name: string; provider: Provider }): Promise<SkillEntry[]> {
    if (!nameRule.test(input.name)) throw new Error(tm().skills.invalidSkillName)
    const source = resolve(input.sourcePath), info = await stat(source).catch(() => null)
    if (!info) throw new Error(tm().skills.fileOrFolderNotFound)
    const base = input.scope === 'global' ? this.globalBases(input.provider)[0]! : this.projectBase(input.projectId ?? '', input.provider)
    const target = join(base, input.name)
    if (existsSync(target)) throw new Error(tm().skills.alreadyExists(input.name, providerLabels[input.provider]))
    await mkdir(target, { recursive: true })
    if (info.isDirectory()) {
      if (!existsSync(join(source, 'SKILL.md'))) throw new Error(tm().skills.folderHasNoSkillMd)
      await cp(source, target, { recursive: true })
    } else {
      if (basename(source).toLowerCase() !== 'skill.md') throw new Error(tm().skills.chooseSkillFolderOrFile)
      await cp(source, join(target, 'SKILL.md'))
      const extras = dirname(source)
      for (const entry of await readdir(extras, { withFileTypes: true })) if (entry.isDirectory() && ['templates', 'references', 'scripts', 'assets'].includes(entry.name)) await cp(join(extras, entry.name), join(target, entry.name), { recursive: true })
    }
    const file = join(target, 'SKILL.md'), parsed = parseSkillMd(await readFile(file, 'utf8'))
    if (parsed.name !== input.name) await writeFile(file, `---\nname: ${input.name}\ndescription: "${parsed.description.replace(/"/g, '\\"')}"\n---\n${parsed.body.startsWith('\n') ? parsed.body : `\n${parsed.body}`}`)
    return this.list(input.scope, input.projectId)
  }

  /** Converts by rule and returns right away; the review by the chosen agent runs in the background. */
  async convert(input: { scope: SkillScope; projectId?: string; name: string; from: Provider; to: Provider; reviewProfileId?: string; model?: string | null }): Promise<{ converted: true; reviewing: boolean }> {
    if (input.from === input.to) throw new Error(tm().skills.chooseOtherAgent)
    const entry = (await this.list(input.scope, input.projectId)).find((item) => item.name === input.name)
    const sourceDir = entry?.paths[input.from]
    if (!entry || !sourceDir) throw new Error(tm().skills.notFoundFor(input.name, providerLabels[input.from]))
    if (entry.providers[input.to] !== 'none') throw new Error(tm().skills.skillAlreadyExistsForOther)
    const base = input.scope === 'global' ? this.globalBases(input.to)[0]! : this.projectBase(input.projectId ?? '', input.to)
    const targetDir = join(base, input.name), key = `${input.scope}|${input.projectId ?? ''}|${input.name}|${input.to}`
    this.converting.set(key, 'convert')
    try {
      await mkdir(targetDir, { recursive: true })
      await cp(sourceDir, targetDir, { recursive: true })
      const file = join(targetDir, 'SKILL.md')
      await writeFile(file, convertSkillMd(await readFile(file, 'utf8'), input.from, input.to))
    } catch (error) { this.converting.delete(key); throw error }
    const reviewing = Boolean(input.reviewProfileId && this.reviewer)
    if (reviewing) void this.review(key, targetDir, input)
    else this.converting.delete(key)
    return { converted: true, reviewing }
  }

  private async review(key: string, targetDir: string, input: { name: string; from: Provider; to: Provider; reviewProfileId?: string; model?: string | null }): Promise<void> {
    this.converting.set(key, 'review')
    this.emit('skills/review-started', { name: input.name })
    try {
      const profile = this.reviewer!.profile(input.reviewProfileId!)
      const names = { claude: 'Claude Code', codex: 'Codex', gemini: 'Antigravity' }
      const prompt = `Esta skill "${input.name}" foi convertida automaticamente de ${names[input.from]} para ${names[input.to]}. Revise só os arquivos desta pasta: confirme que o SKILL.md tem "name" e "description" válidos para ${names[input.to]}, troque referências a ferramentas, caminhos e convenções de ${names[input.from]} pelas de ${names[input.to]} e corrija o que ficou faltando. Não crie nem altere nada fora desta pasta. Responda com um resumo curto do que mudou.`
      const result = await this.reviewer!.adapters[profile.provider].run({ cwd: targetDir, prompt, sessionId: null, planning: false, profile, model: input.model ?? null, mode: profile.provider === 'claude' ? 'accept_edits' : 'auto', onEvent: () => undefined })
      try { this.ledger?.recordAuxiliary(profile, 'skill-review', result.usage) } catch { /* metrics never block the review */ }
      this.emit('skills/review-finished', { name: input.name })
    } catch (error) {
      this.emit('skills/review-failed', { name: input.name, error: error instanceof Error ? error.message : String(error) })
    } finally { this.converting.delete(key) }
  }

  /** Only accepts skills that detection itself knows (global or project), never an arbitrary path. */
  async assertKnown(skill: { name: string; path: string }, projectId: string): Promise<void> {
    const known = [...await this.list('global'), ...await this.list('project', projectId)].some((entry) => entry.name === skill.name && Object.values(entry.paths).includes(skill.path))
    if (!known) throw new Error(tm().skills.unknownSkill)
  }

  /** Content of a skill for the provider (used to inject the chosen skill into the Codex chat). */
  async read(path: string): Promise<string> { return parseSkillMd(await readFile(join(path, 'SKILL.md'), 'utf8')).body.trim() }
}
