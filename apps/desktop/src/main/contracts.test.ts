import { ipcContracts, appSettingsSchema } from '@gearmod/contracts'
import { describe, expect, it } from 'vitest'

const ids = { projectId: '60000000-0000-4000-8000-000000000001', columnId: '60000000-0000-4000-8000-000000000002', cardId: '60000000-0000-4000-8000-000000000003' }

describe('IPC contracts', () => {
  it('allows a card without title only on create (the agent names it later)', () => {
    const base = { type: 'task', priority: 'medium', description: '', acceptanceCriteria: [] }
    expect(ipcContracts['cards:create'].input.safeParse({ projectId: ids.projectId, columnId: ids.columnId, title: '', ...base }).success).toBe(true)
    expect(ipcContracts['cards:update'].input.safeParse({ cardId: ids.cardId, title: '', ...base }).success).toBe(false)
  })

  it('accepts a base branch and a worktree choice on create (never on update)', () => {
    const base = { projectId: ids.projectId, columnId: ids.columnId, title: '', type: 'task', priority: 'medium', description: '', acceptanceCriteria: [] }
    const create = ipcContracts['cards:create'].input
    expect(create.safeParse({ ...base, baseBranch: 'develop' }).success).toBe(true)
    expect(create.safeParse({ ...base, worktree: { kind: 'card', cardId: ids.cardId } }).success).toBe(true)
    expect(create.safeParse({ ...base, worktree: { kind: 'external', path: 'C:/work/by-hand' } }).success).toBe(true)
    expect(create.safeParse({ ...base, worktree: { kind: 'external' } }).success).toBe(false)
    expect(create.safeParse({ ...base, worktree: { kind: 'other', path: 'x' } }).success).toBe(false)
    expect(ipcContracts['cards:update'].input.safeParse({ cardId: ids.cardId, ...base, projectId: undefined, columnId: undefined, title: 'A', baseBranch: 'develop' }).success).toBe(false)
    expect(ipcContracts['worktrees:adopt'].input.safeParse({ cardId: ids.cardId, path: '' }).success).toBe(false)
  })

  it('validates document kinds, hex agent colors and app settings', () => {
    expect(ipcContracts['cards:write-document'].input.safeParse({ cardId: ids.cardId, kind: 'criterios', contentMd: '' }).success).toBe(false)
    expect(ipcContracts['profiles:create'].input.safeParse({ provider: 'codex', label: 'A', scope: 'x', color: 'vermelho' }).success).toBe(false)
    expect(appSettingsSchema.safeParse({ tema: 'purple', idioma: 'en', voz: 'large-v3-turbo', notificacoes: true, retomarSozinho: false, fotosGravatar: false, execucoesSimultaneas: null }).success).toBe(true)
    expect(ipcContracts['settings:update'].input.safeParse({ execucoesSimultaneas: 4 }).success).toBe(true)
    expect(ipcContracts['settings:update'].input.safeParse({ execucoesSimultaneas: 0 }).success).toBe(false)
    expect(ipcContracts['settings:update'].input.safeParse({ execucoesSimultaneas: 17 }).success).toBe(false)
    expect(appSettingsSchema.safeParse({ tema: 'rosa', idioma: 'pt-BR', voz: 'small' }).success).toBe(false)
  })
})
