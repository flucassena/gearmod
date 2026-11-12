import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkSpecKitContract, specKitCriticalStages, specKitOptionalStages, type SpecKitContractProvider } from './spec-contract'
import { SpecToolsService } from './spec-tools'
import type { CommandRunner } from './playwright-cli'
import type { AppDatabase } from './database'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })) })

const put = (root: string, path: string, text: string): void => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text, 'utf8') }

/** Layout written by `specify init` in v1.3.2 (verified with a real run); `omit` removes one file to simulate a layout change. */
function writeSpecKitLayout(root: string, provider: SpecKitContractProvider, omit: string[] = []): void {
  const files: Record<string, string> = {
    '.specify/integration.json': JSON.stringify({ version: '1.3.2', integration: provider, installed_integrations: [provider] }),
    '.specify/scripts/powershell/common.ps1': '# Write feature.json\n$env:SPECIFY_FEATURE_DIRECTORY\n',
    '.specify/templates/spec-template.md': '# spec',
    '.specify/templates/plan-template.md': '# plan',
    '.specify/templates/tasks-template.md': '## Phase 1\n- [ ] T001 Create project structure\n'
  }
  const skills = provider === 'claude' ? '.claude/skills' : '.agents/skills'
  for (const stage of [...specKitCriticalStages, ...specKitOptionalStages]) files[`${skills}/speckit-${stage}/SKILL.md`] = `---\nname: speckit-${stage}\n---\nbody`
  for (const [path, text] of Object.entries(files)) if (!omit.includes(path)) put(root, path, text)
}
const folder = (): string => { const root = mkdtempSync(join(tmpdir(), 'gearmod-contract-')); roots.push(root); return root }

describe('checkSpecKitContract', () => {
  it.each(['claude', 'codex'] as const)('accepts the current %s layout', (provider) => {
    const root = folder(); writeSpecKitLayout(root, provider)
    expect(checkSpecKitContract(root, provider)).toEqual({ ok: true, issues: [] })
  })
  it('fails when a skill the app invokes disappears or moves', () => {
    const root = folder(); writeSpecKitLayout(root, 'claude', ['.claude/skills/speckit-plan/SKILL.md'])
    const result = checkSpecKitContract(root, 'claude')
    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([expect.objectContaining({ severity: 'error', code: 'skill-missing', detail: expect.stringContaining('speckit-plan') })])
  })
  it('only warns when an optional skill disappears', () => {
    const root = folder(); writeSpecKitLayout(root, 'codex', ['.agents/skills/speckit-analyze/SKILL.md'])
    expect(checkSpecKitContract(root, 'codex')).toMatchObject({ ok: true, issues: [{ severity: 'warning', code: 'skill-missing' }] })
  })
  it('fails when the feature binding or the version record changes', () => {
    const root = folder(); writeSpecKitLayout(root, 'claude', ['.specify/scripts/powershell/common.ps1', '.specify/integration.json'])
    put(root, '.specify/scripts/bash/common.sh', 'echo nothing')
    expect(checkSpecKitContract(root, 'claude').issues.map((issue) => issue.code).sort()).toEqual(['feature-env', 'feature-json', 'integration-json'])
  })
  it('fails when the task checkbox format changes', () => {
    const root = folder(); writeSpecKitLayout(root, 'claude'); put(root, '.specify/templates/tasks-template.md', '* T001 do it')
    expect(checkSpecKitContract(root, 'claude').issues).toEqual([expect.objectContaining({ code: 'tasks-format' })])
  })
  it('fails when init created nothing', () => {
    expect(checkSpecKitContract(folder(), 'claude')).toMatchObject({ ok: false, issues: [{ code: 'specify-folder' }] })
  })
})

describe('SpecToolsService.probe', () => {
  const service = (run: CommandRunner['run']): SpecToolsService => new SpecToolsService({} as AppDatabase, { run })
  it('initializes each agent in a throwaway folder with the candidate tag and reports compatible', async () => {
    const calls: string[] = []
    const result = await service(async (command, args, cwd) => {
      calls.push(`${command} ${args.join(' ')}`)
      writeSpecKitLayout(cwd, args.includes('codex') ? 'codex' : 'claude'); return ''
    }).probe('1.4.0')
    expect(result).toMatchObject({ version: '1.4.0', ok: true, issues: [] })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('git+https://github.com/github/spec-kit.git@v1.4.0')
    expect(calls[0]).toContain('--integration claude'); expect(calls[1]).toContain('--integration codex')
  })
  it('reports incompatible with the reason when the new layout dropped something', async () => {
    const result = await service(async (_command, args, cwd) => { writeSpecKitLayout(cwd, args.includes('codex') ? 'codex' : 'claude', ['.specify/integration.json']); return '' }).probe('2.0.0')
    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.detail)).toEqual(expect.arrayContaining([expect.stringContaining('[claude]'), expect.stringContaining('[codex]')]))
  })
  it('reports incompatible when the CLI fails and never leaves the folders behind', async () => {
    const dirs: string[] = []
    const result = await service(async (_command, _args, cwd) => { dirs.push(cwd); throw new Error('boom\nno such tag') }).probe('9.9.9')
    expect(result).toMatchObject({ ok: false, issues: [{ code: 'init-failed' }, { code: 'init-failed' }] })
    expect(dirs.some((dir) => existsSync(dir))).toBe(false)
  })
  it('rejects a version that is not x.y.z', async () => { await expect(service(async () => '').probe('1.4.0; rm -rf')).rejects.toThrow() })
})
