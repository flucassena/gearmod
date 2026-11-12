import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentConfigRepository } from './agent-config'
import { AppDatabase } from './database'
import { BoardRepository, ProfileRepository, ProjectRepository } from './projects'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const git = { validate: async () => undefined, branches: async () => ['dev'], inspect: async (localPath: string) => ({ localPath, name: 'p', repositories: [] }) }

async function setup(lister?: (profileId: string) => Promise<never[]>, claudeLister?: (profileId: string) => Promise<never[]>) {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-cfg-')); roots.push(root)
  const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
  const profiles = new ProfileRepository(database, root)
  const claude = profiles.create({ provider: 'claude', label: 'Claude', scope: 'x' })
  const codex = profiles.create({ provider: 'codex', label: 'Codex', scope: 'x' })
  const projects = new ProjectRepository(database, git), board = new BoardRepository(database, projects)
  const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev' })
  const card = board.create({ projectId: project.id, columnId: board.get(project.id).columns[1]!.id, title: 'C', description: '', type: 'task', priority: 'low', acceptanceCriteria: [] })
  return { database, profiles, claude, codex, card, configs: new AgentConfigRepository(database, board, profiles, lister, undefined, claudeLister) }
}

describe('AgentConfigRepository', () => {
  it('stores a config per card and purpose and falls back to recommended defaults', async () => {
    const { database, claude, card, configs } = await setup()
    expect(configs.get(card.id)).toEqual({ planning: null, execution: null, test: null })
    expect(configs.resolve(card.id, claude.id, 'planning')).toEqual({ profileId: claude.id, model: 'opus', effort: 'high', mode: 'plan' })
    expect(configs.resolve(card.id, claude.id, 'execution')).toEqual({ profileId: claude.id, model: 'sonnet', effort: 'medium', mode: 'accept_edits' })
    configs.set(card.id, 'test', { profileId: claude.id, model: 'sonnet', effort: 'low', mode: 'accept_edits' })
    expect(configs.get(card.id).test?.model).toBe('sonnet')
    configs.set(card.id, 'execution', { profileId: claude.id, model: 'haiku', effort: 'low', mode: 'auto' })
    expect(configs.get(card.id).execution).toEqual({ profileId: claude.id, model: 'haiku', effort: 'low', mode: 'auto' })
    expect(configs.resolve(card.id, claude.id, 'execution').model).toBe('haiku')
    database.close()
  })

  it('rejects invalid modes and accepts modes with chat approval', async () => {
    const { database, claude, codex, card, configs } = await setup()
    expect(() => configs.set(card.id, 'execution', { profileId: claude.id, model: null, effort: null, mode: 'plan' })).toThrow('não existe para executar')
    expect(() => configs.set(card.id, 'planning', { profileId: claude.id, model: null, effort: null, mode: 'auto' })).toThrow('não existe para planejar')
    expect(() => configs.set(card.id, 'execution', { profileId: claude.id, model: null, effort: null, mode: 'manual' })).not.toThrow()
    expect(() => configs.set(card.id, 'execution', { profileId: codex.id, model: null, effort: null, mode: 'on_request' })).not.toThrow()
    expect(() => configs.set(card.id, 'execution', { profileId: codex.id, model: null, effort: null, mode: 'accept_edits' })).toThrow('não existe')
    database.close()
  })

  it('tracks the most used model and effort per agent and purpose', async () => {
    const { database, claude, card, configs } = await setup()
    configs.recordUse({ profileId: claude.id, model: 'haiku', effort: 'low', mode: 'auto' }, 'execution')
    configs.recordUse({ profileId: claude.id, model: 'opus', effort: 'max', mode: 'auto' }, 'execution')
    configs.recordUse({ profileId: claude.id, model: 'opus', effort: 'max', mode: 'auto' }, 'execution')
    expect(configs.mostUsed(claude.id, 'execution')).toEqual({ model: 'opus', effort: 'max' })
    expect(configs.mostUsed(claude.id, 'planning')).toBeNull()
    expect(configs.resolve(card.id, claude.id, 'execution')).toMatchObject({ model: 'opus', effort: 'max' })
    expect((await configs.options(claude.id)).mostUsed.execution).toEqual({ model: 'opus', effort: 'max' })
    database.close()
  })

  it('lists Claude models statically and Codex models through the lister, caching them and surviving failures', async () => {
    let calls = 0
    const { database, claude, codex, configs } = await setup(async () => { calls += 1; throw new Error('sem codex') })
    expect((await configs.options(claude.id)).models.map((model) => model.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect((await configs.options(codex.id)).models).toEqual([]); expect(calls).toBe(1)
    database.close()
    const second = await setup(async () => [{ id: 'gpt-x', label: 'GPT X', description: '', efforts: ['low', 'high'], recommendedFor: ['planning'], defaultEffort: 'high' }] as never)
    expect((await second.configs.options(second.codex.id)).models[0]?.id).toBe('gpt-x'); await second.configs.options(second.codex.id)
    second.database.close()
  })

  it('Claude: the signed-in account models replace the fixed list (cached); a failure keeps the fixed list and retries', async () => {
    let calls = 0, fail = true
    const account = [{ id: 'opus', label: 'Opus 5.5', description: '', efforts: ['high'], recommendedFor: ['planning'], defaultEffort: 'high' }, { id: 'fable', label: 'Fable 5.2', description: '', efforts: ['high'], recommendedFor: [], defaultEffort: 'high' }]
    const { database, claude, configs } = await setup(undefined, async () => { calls += 1; if (fail) throw new Error('sem login'); return account as never })
    expect((await configs.options(claude.id)).models.map((model) => model.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    fail = false
    expect((await configs.options(claude.id)).models.map((model) => model.label)).toEqual(['Opus 5.5', 'Fable 5.2'])
    await configs.options(claude.id)
    expect(calls).toBe(2)
    database.close()
  })
})
