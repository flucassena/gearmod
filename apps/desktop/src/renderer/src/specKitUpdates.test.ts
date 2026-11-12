import { describe, expect, it } from 'vitest'
import { specKitBaseline, specKitInstallCommand, specKitUpdateState } from './specKitUpdates'

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
