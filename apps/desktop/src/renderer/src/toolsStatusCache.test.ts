import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedStatus } from './toolsStatusCache'

const projectId = 'p1'
const stub = (value: string | null): void => { vi.stubGlobal('localStorage', { getItem: () => value, setItem: () => undefined }) }
afterEach(() => vi.unstubAllGlobals())

describe('cachedStatus', () => {
  it('fills the fields an older version of the app did not save', () => {
    // Saved before specKitVersions existed: reading it used to break the Tools tab (and the whole window).
    stub(JSON.stringify({
      node: '22', uv: '0.5', python: '3.12', specify: { installed: true, version: '0.4.0' }, openspec: { installed: false, version: null },
      repos: [{ sourceId: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f', name: 'repo', path: 'C:/repo', specKit: true, specKitIntegrations: ['claude'], openSpec: false }],
      log: '', error: null
    }))
    expect(cachedStatus(projectId)?.repos[0]?.specKitVersions).toEqual({})
  })

  it('drops a saved result that no longer fits', () => {
    stub(JSON.stringify({ repos: 'nope' }))
    expect(cachedStatus(projectId)).toBeUndefined()
  })
})
