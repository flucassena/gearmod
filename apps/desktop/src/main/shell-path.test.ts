import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadShellPath, loginShell, mergePath, pathFromShellOutput, userBinFolders } from './shell-path'

describe('shell PATH on Linux and macOS', () => {
  it('reads PATH between the markers and ignores what the shell prints around them', () => {
    const output = 'Welcome!\n__GEARMOD_PATH__\nHOME=/home/ana\nPATH=/home/ana/.nvm/versions/node/v22/bin:/usr/bin\nSHELL=/bin/bash\n__GEARMOD_PATH__\nbye'
    expect(pathFromShellOutput(output)).toBe('/home/ana/.nvm/versions/node/v22/bin:/usr/bin')
    expect(pathFromShellOutput('no markers')).toBeNull()
  })

  it('puts the shell folders first, keeps the ones only the app had and does not repeat', () => {
    expect(mergePath('/nvm/bin:/usr/bin', '/usr/bin:/app/bin', ['/home/ana/.local/bin', '/nvm/bin'])).toBe('/nvm/bin:/usr/bin:/app/bin:/home/ana/.local/bin')
    expect(mergePath(null, '/usr/bin')).toBe('/usr/bin')
  })

  it('adds only the user folders that exist', () => {
    expect(userBinFolders('/home/ana', (path) => path.endsWith(join('.local', 'bin')))).toEqual([join('/home/ana', '.local', 'bin')])
  })

  it('loads the login shell PATH on Linux and does nothing on Windows', () => {
    const calls: Array<{ shell: string; args: string[] }> = []
    const deps = { run: (shell: string, args: string[]) => { calls.push({ shell, args }); return '__GEARMOD_PATH__\nPATH=/nvm/bin\n__GEARMOD_PATH__\n' } }
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', SHELL: '/bin/zsh' }
    loadShellPath(env, 'linux', deps, '/nowhere')
    expect(env.PATH).toBe('/nvm/bin:/usr/bin')
    expect(calls[0]!.shell).toBe('/bin/zsh'); expect(calls[0]!.args[0]).toBe('-ilc')
    const windows: NodeJS.ProcessEnv = { PATH: 'C:\\Windows' }
    loadShellPath(windows, 'win32', deps, '/nowhere')
    expect(windows.PATH).toBe('C:\\Windows'); expect(calls).toHaveLength(1)
  })

  it('keeps the current PATH when the shell fails', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    loadShellPath(env, 'linux', { run: () => { throw new Error('timeout') } }, '/nowhere')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('also reads the shell on the Mac, with zsh by default, and adds Homebrew when it exists', () => {
    const calls: string[] = []
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
    loadShellPath(env, 'darwin', { run: (shell) => { calls.push(shell); return '__GEARMOD_PATH__\nPATH=/Users/ana/.nvm/bin:/usr/bin\n__GEARMOD_PATH__\n' } }, '/nowhere')
    expect(calls).toEqual(['/bin/zsh'])
    expect(env.PATH!.startsWith('/Users/ana/.nvm/bin:/usr/bin:/bin')).toBe(true)
    expect(userBinFolders('/Users/ana', (path) => path === '/opt/homebrew/bin', 'darwin')).toEqual(['/opt/homebrew/bin'])
    expect(userBinFolders('/home/ana', (path) => path === '/opt/homebrew/bin', 'linux')).toEqual([])
    expect(loginShell({}, 'linux')).toBe('/bin/sh')
    expect(loginShell({ SHELL: '/opt/homebrew/bin/fish' }, 'darwin')).toBe('/opt/homebrew/bin/fish')
  })
})
