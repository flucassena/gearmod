import { describe, expect, it } from 'vitest'
import { specKitBaseline, specKitInstallCommand, specKitUpdateState, specKitVerdict } from './specKitUpdates'

describe('Spec Kit updates', () => {
  it('installs the requested tag', () => {
    expect(specKitInstallCommand(specKitBaseline)).toContain(`@v${specKitBaseline}`)
  })
  it('offers any newer published version, which the compatibility probe then validates', () => {
    expect(specKitUpdateState('1.0.0', '1.4.0')).toEqual({ canUpdate: true })
    expect(specKitUpdateState('1.3.2', '1.4.0')).toEqual({ canUpdate: true })
  })
  it('offers neither downgrade nor update when the versions are unknown', () => {
    expect(specKitUpdateState('1.4.0', '1.3.2').canUpdate).toBe(false)
    expect(specKitUpdateState(null, '1.3.0').canUpdate).toBe(false)
    expect(specKitUpdateState('1.0.0', null).canUpdate).toBe(false)
    expect(specKitUpdateState('1.0.0', '1.3.0-beta').canUpdate).toBe(false)
  })
})

describe('Spec Kit verdicts', () => {
  const compat = { checkedAt: '2026-11-12T00:00:00Z', versions: { '1.4.0': { ok: true, issues: [] }, '1.5.0': { ok: false, issues: [{ severity: 'error' as const, detail: '[claude] skill speckit-plan is missing' }] } } }
  it('uses the CI verdict for the version', () => {
    expect(specKitVerdict('1.4.0', compat)).toEqual({ state: 'verified', issues: [] })
    expect(specKitVerdict('1.5.0', compat)).toMatchObject({ state: 'incompatible', issues: [{ detail: expect.stringContaining('speckit-plan') }] })
  })
  it('has no verdict for a version the job has not seen, or without the file', () => {
    expect(specKitVerdict('1.6.0', compat).state).toBe('unknown')
    expect(specKitVerdict('1.4.0', undefined).state).toBe('unknown')
    expect(specKitVerdict(null, compat).state).toBe('unknown')
  })
})
