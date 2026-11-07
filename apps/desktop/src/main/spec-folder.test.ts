import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppDatabase } from './database'
import { SpecToolsService } from './spec-tools'

const exec = promisify(execFile), roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))) })

describe('SpecToolsService.inspectFolder', () => {
  it('tells a repository, a plain folder and a folder inside a repository apart, and sees Spec Kit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-spec-folder-')); roots.push(root)
    const repo = join(root, 'repo'), plain = join(root, 'plain'), inside = join(repo, 'docs')
    await mkdir(plain); await mkdir(inside, { recursive: true })
    await exec('git', ['init', '-b', 'main', repo])
    const service = new SpecToolsService({} as AppDatabase)

    expect(await service.inspectFolder(repo)).toMatchObject({ isRepo: true, parentRepo: null, hasSpecKit: false })
    expect(await service.inspectFolder(plain)).toEqual({ isRepo: false, parentRepo: null, hasSpecKit: false, integrations: [] })
    const nested = await service.inspectFolder(inside)
    expect(nested.isRepo).toBe(false); expect(nested.parentRepo).not.toBeNull()

    await mkdir(join(plain, '.specify'))
    await writeFile(join(plain, '.specify', 'integration.json'), JSON.stringify({ integration: 'claude' }))
    expect(await service.inspectFolder(plain)).toMatchObject({ hasSpecKit: true, integrations: ['claude'] })
  })

  it('refuses a folder that does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-spec-folder-')); roots.push(root)
    await expect(new SpecToolsService({} as AppDatabase).inspectFolder(join(root, 'nowhere'))).rejects.toThrow()
  })
})

describe('SpecToolsService.terminalPlan', () => {
  const service = new SpecToolsService({} as AppDatabase)
  const line = (plan: { args: string[] }): string => plan.args[plan.args.length - 1]!

  it('builds fixed commands for the install and the update, pinned to the given version', () => {
    expect(line(service.terminalPlan({ kind: 'install-cli', version: '1.3.2' }))).toBe('uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.3.2')
    expect(line(service.terminalPlan({ kind: 'update-cli', version: '1.3.2' }))).toBe('uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.3.2 --force')
    expect(() => service.terminalPlan({ kind: 'install-cli' })).toThrow()
  })

  it('runs init in the folder, with git init first when asked, and refuses a folder that does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-spec-plan-')); roots.push(root)
    const init = service.terminalPlan({ kind: 'init', path: root })
    expect(line(init)).toBe('specify init --here'); expect(init.cwd).toBe(root)
    expect(line(service.terminalPlan({ kind: 'init-with-git', path: root }))).toContain('git init')
    expect(() => service.terminalPlan({ kind: 'init', path: join(root, 'nowhere') })).toThrow()
    expect(() => service.terminalPlan({ kind: 'init' })).toThrow()
  })

  it('upgrades an integration by name only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-spec-plan-')); roots.push(root)
    expect(line(service.terminalPlan({ kind: 'upgrade-integration', path: root, integration: 'claude' }))).toBe('specify integration upgrade claude')
    expect(() => service.terminalPlan({ kind: 'upgrade-integration', path: root })).toThrow()
  })

  it('the contract refuses anything that is not a plain version or integration name', async () => {
    const { ipcContracts } = await import('@gearmod/contracts')
    const input = ipcContracts['tools:run-terminal'].input
    expect(input.safeParse({ kind: 'install-cli', version: '1.3.2' }).success).toBe(true)
    expect(input.safeParse({ kind: 'install-cli', version: '1.3.2; rm -rf /' }).success).toBe(false)
    expect(input.safeParse({ kind: 'upgrade-integration', path: 'C:/x', integration: 'claude && calc' }).success).toBe(false)
    expect(input.safeParse({ kind: 'anything', version: '1.0.0' }).success).toBe(false)
    expect(input.safeParse({ kind: 'init', path: 'C:/x', command: 'calc' }).success).toBe(false)
  })
})
