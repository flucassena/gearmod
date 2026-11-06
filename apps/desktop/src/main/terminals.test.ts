import { describe, expect, it } from 'vitest'
import { shellCommand } from './terminals'

describe('shellCommand', () => {
  it('opens interactive PowerShell (PowerShell 7 when installed) on Windows', () => {
    const shell = shellCommand('win32')
    expect(shell.file).toMatch(/(^|[\\/])(pwsh|powershell)\.exe$/i); expect(shell.args).toEqual(['-NoLogo'])
  })
  it('uses the user shell on other systems', () => {
    expect(shellCommand('linux', '/bin/zsh').file).toBe('/bin/zsh'); expect(shellCommand('darwin')).toEqual({ file: '/bin/zsh', args: ['-l'], prelude: '' })
  })
})
