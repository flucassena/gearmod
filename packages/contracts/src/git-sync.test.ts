import { describe, expect, it } from 'vitest'
import { ipcContracts } from './index'

describe('validação de branch em git:sync', () => {
  const branchSchema = ipcContracts['git:sync'].input.shape.branch
  const anterior = new RegExp('^[A-Za-z0-9_][A-Za-z0-9._\\/-]{0,254}$')

  it.each([
    'feature/x', 'a.b-c_d', 'main', '_branch', '0', 'a'.repeat(255)
  ])('continua aceitando %s', (branch) => {
    expect(anterior.test(branch)).toBe(true)
    expect(branchSchema.safeParse(branch).success).toBe(true)
  })

  it.each([
    '', '-branch', '.branch', '/branch', 'feature x', 'feature\\x', 'feature@x',
    'feature:x', 'feature~x', 'feature^x', 'feature?x', 'feature[x', 'ação',
    'feature\nx', 'a'.repeat(256)
  ])('continua recusando %s', (branch) => {
    expect(anterior.test(branch)).toBe(false)
    expect(branchSchema.safeParse(branch).success).toBe(false)
  })

  it('mantém branch opcional para sincronizar a branch atual', () => {
    expect(branchSchema.safeParse(undefined).success).toBe(true)
  })
})
