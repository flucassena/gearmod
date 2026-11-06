import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareVersions, installerFor, parseChecksums, releaseNotes, UpdateService } from './updater'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))) })

const repo = 'owner/app'
const base = `https://github.com/${repo}/releases/download/v0.2.0`
const bytes = Buffer.from('installer-bytes')
const names = ['GearMod-Setup-0.2.0-x64.exe', 'GearMod-0.2.0-x86_64.AppImage', 'GearMod-0.2.0-amd64.deb']
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

function fakeFetch(options: { sums?: string | null; installer?: Buffer; tag?: string } = {}): typeof fetch {
  const tag = options.tag ?? 'v0.2.0'
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/releases/latest')) {
      const assets = names.map((name) => ({ name, browser_download_url: `${base}/${name}`, size: bytes.length }))
      if (options.sums !== null) assets.push({ name: 'SHA256SUMS.txt', browser_download_url: `${base}/SHA256SUMS.txt`, size: 100 })
      return Response.json({ tag_name: tag, body: '## News\n- better', published_at: '2026-11-01T00:00:00Z', html_url: `https://github.com/${repo}/releases/tag/${tag}`, assets })
    }
    if (names.some((name) => url.endsWith(name))) return new Response(new Uint8Array(options.installer ?? bytes), { headers: { 'content-length': String((options.installer ?? bytes).length) } })
    if (url.endsWith('SHA256SUMS.txt')) return new Response(options.sums ?? names.map((name) => `${sha(bytes)}  ${name}`).join('\n'))
    return new Response('', { status: 404 })
  }) as typeof fetch
}

async function service(fetchImpl: typeof fetch, current = '0.1.0', platform: NodeJS.Platform = 'win32', appImagePath?: string, launch?: (file: string) => void | Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'gearmod-update-')); roots.push(dir)
  const calls = { launched: [] as string[], quit: 0, states: [] as number[] }
  const updates = new UpdateService({ currentVersion: current, platform, repo, downloadDir: dir, fetchImpl, emit: (state) => { calls.states.push(state.progress ?? -1) }, appImagePath, launch: async (file) => { await launch?.(file); calls.launched.push(file) }, quit: () => { calls.quit += 1 } })
  return { updates, calls, dir }
}

describe('versions and checksums', () => {
  it('compares versions ignoring the v prefix and pre-release suffixes', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.1.0', '0.10.0')).toBeLessThan(0)
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(0)
  })

  it('reads sha256sum lines, with or without the binary marker', () => {
    const a = 'a'.repeat(64), b = 'B'.repeat(64)
    const sums = parseChecksums(`${a}  one.exe\n${b} *two.deb\nnot a line\n`)
    expect(sums.get('one.exe')).toBe(a)
    expect(sums.get('two.deb')).toBe('b'.repeat(64))
  })

  it('drops the install instructions from the Release body and keeps what changed', () => {
    const body = ["## Download", "", "### Windows", "", "Run it.", "", "## What's Changed", "* Fix a bug by @x in #1", ""].join('\n')
    expect(releaseNotes(body)).toBe(["## What's Changed", "* Fix a bug by @x in #1"].join('\n'))
    expect(releaseNotes('## Download\n\nonly this')).toBe('')
    expect(releaseNotes('- plain notes')).toBe('- plain notes')
  })

  it('picks the installer file of each platform', () => {
    const assets = [{ name: 'GearMod-Setup-0.2.0-x64.exe', url: 'u', size: 1 }, { name: 'GearMod-0.2.0-x64.AppImage', url: 'u', size: 1 }]
    expect(installerFor(assets, '0.2.0', 'win32')?.name).toBe('GearMod-Setup-0.2.0-x64.exe')
    expect(installerFor(assets, '0.2.0', 'linux')).toBeUndefined()
  })
})

describe('UpdateService', () => {
  it('finds a newer release and exposes its notes', async () => {
    const { updates } = await service(fakeFetch())
    const state = await updates.check()
    expect(state).toMatchObject({ latest: '0.2.0', available: true, canInstall: true, notes: '## News\n- better', error: null })
  })

  it('says there is nothing new when the version is the same, and a failed silent check shows no error', async () => {
    expect((await (await service(fakeFetch(), '0.2.0')).updates.check()).available).toBe(false)
    const failing = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect((await (await service(failing)).updates.check(true)).error).toBeNull()
    expect((await (await service(failing)).updates.check()).error).toBe('check-failed')
  })

  it('on Linux it picks the AppImage when running as one and the Debian package otherwise', async () => {
    const appImage = await (await service(fakeFetch(), '0.1.0', 'linux', '/home/u/GearMod.AppImage')).updates.check()
    expect(appImage).toMatchObject({ available: true, canInstall: true, manualCommand: null })
    const deb = await (await service(fakeFetch(), '0.1.0', 'linux')).updates.check()
    expect(deb).toMatchObject({ available: true, canInstall: true, manualCommand: 'sudo apt install ./GearMod-0.2.0-amd64.deb' })
  })

  it('installs the downloaded AppImage and the Debian package through launch', async () => {
    for (const [appImagePath, file] of [['/home/u/GearMod.AppImage', 'GearMod-0.2.0-x86_64.AppImage'], [undefined, 'GearMod-0.2.0-amd64.deb']] as const) {
      const { updates, calls, dir } = await service(fakeFetch(), '0.1.0', 'linux', appImagePath)
      await updates.check(); await updates.install()
      expect(calls.launched).toEqual([join(dir, file)]); expect(calls.quit).toBe(1)
    }
  })

  it('keeps the app open and reports the error when applying the update fails', async () => {
    const { updates, calls } = await service(fakeFetch(), '0.1.0', 'linux', undefined, () => { throw new Error('pkexec: not authorized') })
    await updates.check()
    expect((await updates.install()).error).toBe('launch-failed')
    expect(calls.quit).toBe(0)
    expect(updates.get().installing).toBe(false)
  })

  it('downloads, verifies the checksum, starts the installer and quits', async () => {
    const { updates, calls, dir } = await service(fakeFetch())
    await updates.check()
    await updates.install()
    expect(calls.launched).toEqual([join(dir, 'GearMod-Setup-0.2.0-x64.exe')])
    expect(calls.quit).toBe(1)
    expect(existsSync(calls.launched[0]!)).toBe(true)
  })

  it('refuses and deletes a download whose checksum does not match', async () => {
    const { updates, calls, dir } = await service(fakeFetch({ sums: `${'0'.repeat(64)}  GearMod-Setup-0.2.0-x64.exe\n` }))
    await updates.check()
    expect((await updates.install()).error).toBe('checksum-mismatch')
    expect(calls.launched).toEqual([]); expect(calls.quit).toBe(0)
    expect(existsSync(join(dir, 'GearMod-Setup-0.2.0-x64.exe'))).toBe(false)
  })

  it('refuses to run an installer that has no published checksum', async () => {
    const { updates, calls } = await service(fakeFetch({ sums: null }))
    await updates.check()
    expect((await updates.install()).error).toBe('checksum-missing')
    expect(calls.launched).toEqual([])
  })
})
