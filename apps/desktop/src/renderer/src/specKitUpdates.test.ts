import { describe, expect, it } from 'vitest'
import { specKitInstallCommand, specKitUpdateCeiling, specKitUpdateState } from './specKitUpdates'

describe('Spec Kit update limit', () => {
  it('pins the installation and reports when the published version exceeds the limit', () => {
    expect(specKitInstallCommand).toContain(`@v${specKitUpdateCeiling}`)
    expect(specKitUpdateState('1.0.0', '1.4.0')).toEqual({ newerAvailable: true, canUpdate: true })
  })
  it('offers neither downgrade nor update when the versions are unknown', () => {
    expect(specKitUpdateState('1.3.2', '1.4.0').canUpdate).toBe(false)
    expect(specKitUpdateState(null, '1.3.0').canUpdate).toBe(false)
    expect(specKitUpdateState('1.0.0', null).canUpdate).toBe(false)
    expect(specKitUpdateState('1.0.0', '1.3.0-beta').canUpdate).toBe(false)
  })
})
