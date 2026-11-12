import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What GearMod relies on from Spec Kit (the "contract"). The probe initializes a candidate version in a throwaway folder and this
 * function checks the result, so a Spec Kit release does not need a GearMod release just to be trusted. Only structure is checked:
 * a change in the wording of the skills' prompts is not detected here.
 */
export type SpecKitContractProvider = 'claude' | 'codex'
export interface SpecKitContractIssue { severity: 'error' | 'warning'; code: string; detail: string }
export interface SpecKitContractResult { ok: boolean; issues: SpecKitContractIssue[] }

/** Stages the app triggers by name; the first four break the flow if missing, the rest only hide an optional step. */
export const specKitCriticalStages = ['specify', 'plan', 'tasks', 'implement'] as const
export const specKitOptionalStages = ['clarify', 'checklist', 'analyze'] as const
const skillsFolder: Record<SpecKitContractProvider, string[]> = { claude: ['.claude', 'skills'], codex: ['.agents', 'skills'] }

const read = (path: string): string | null => { try { return readFileSync(path, 'utf8') } catch { return null } }
const readJson = (path: string): Record<string, unknown> | null => { try { const value: unknown = JSON.parse(readFileSync(path, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null } catch { return null } }
const filesUnder = (dir: string): string[] => {
  try { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]) } catch { return [] }
}

export function checkSpecKitContract(repo: string, provider: SpecKitContractProvider): SpecKitContractResult {
  const issues: SpecKitContractIssue[] = []
  const add = (severity: SpecKitContractIssue['severity'], code: string, detail: string): void => { issues.push({ severity, code, detail }) }
  const specify = join(repo, '.specify')
  if (!existsSync(specify)) { add('error', 'specify-folder', '.specify/ was not created'); return { ok: false, issues } }

  // 1. The skills the app invokes (`/speckit-<stage>` in Claude, `$speckit-<stage>` in Codex).
  const folder = join(repo, ...skillsFolder[provider])
  for (const stage of [...specKitCriticalStages, ...specKitOptionalStages]) {
    const skill = read(join(folder, `speckit-${stage}`, 'SKILL.md'))
    const critical = (specKitCriticalStages as readonly string[]).includes(stage)
    if (skill === null || !skill.trim()) add(critical ? 'error' : 'warning', 'skill-missing', `${skillsFolder[provider].join('/')}/speckit-${stage}/SKILL.md is missing or empty`)
    else if (!/^---[\s\S]*?\bname:\s*\S+[\s\S]*?---/.test(skill)) add('warning', 'skill-frontmatter', `speckit-${stage} has no name in its front matter`)
  }

  // 2. Version/integration records the Tools tab reads.
  const integration = readJson(join(specify, 'integration.json'))
  if (!integration) add('error', 'integration-json', '.specify/integration.json is missing or invalid')
  else {
    if (typeof integration.version !== 'string' || !/^\d+\.\d+\.\d+/.test(integration.version)) add('error', 'integration-version', '.specify/integration.json has no readable "version"')
    const named = [integration.integration, ...(Array.isArray(integration.installed_integrations) ? integration.installed_integrations : [])]
    if (!named.includes(provider)) add('error', 'integration-name', `.specify/integration.json does not list "${provider}"`)
  }

  // 3. Binding of the card's feature: `.specify/feature.json` and `SPECIFY_FEATURE_DIRECTORY` must still be understood by the scripts.
  const scripts = filesUnder(join(specify, 'scripts')).filter((file) => /\.(sh|ps1)$/i.test(file))
  if (!scripts.length) add('error', 'scripts-missing', 'no scripts under .specify/scripts')
  else {
    const text = scripts.map((file) => read(file) ?? '').join('\n')
    if (!text.includes('feature.json')) add('error', 'feature-json', 'the scripts no longer mention .specify/feature.json')
    if (!text.includes('SPECIFY_FEATURE_DIRECTORY')) add('error', 'feature-env', 'the scripts no longer read SPECIFY_FEATURE_DIRECTORY')
  }

  // 4. Artifact names and the task checkbox format (`- [ ] T001 ...`) the Tasks tab edits.
  for (const template of ['spec-template.md', 'plan-template.md', 'tasks-template.md']) {
    if (!existsSync(join(specify, 'templates', template))) add('warning', 'template-missing', `.specify/templates/${template} is missing`)
  }
  const tasks = read(join(specify, 'templates', 'tasks-template.md'))
  if (tasks !== null && !/^\s*- \[ \] T\d+/m.test(tasks)) add('error', 'tasks-format', 'tasks-template.md no longer uses the "- [ ] T001" checkbox format')

  return { ok: !issues.some((issue) => issue.severity === 'error'), issues }
}
