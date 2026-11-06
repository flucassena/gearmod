import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AppAbout, AppUpdate } from '@gearmod/contracts'

interface ReleaseAsset { name: string; url: string; size: number }
interface Release { version: string; notes: string; publishedAt: string | null; url: string; assets: ReleaseAsset[] }

export interface UpdateDeps {
  currentVersion: string
  platform: NodeJS.Platform
  /** Path of the running AppImage (`$APPIMAGE`); without it, on Linux, the app is taken to be the Debian package. */
  appImagePath?: string
  /** `owner/name` of the GitHub repository that publishes the Releases. */
  repo: string
  /** Folder where the installer is downloaded. */
  downloadDir: string
  emit(state: AppUpdate): void
  /** Applies the downloaded file (starts the Windows installer, replaces the AppImage or installs the .deb) and, when needed, schedules the reopening. The app quits right after. */
  launch(file: string): void | Promise<void>
  quit(): void
  fetchImpl?: typeof fetch
}

/** Compares `1.2.3` style versions (a leading `v` and anything after `-` or `+` are ignored). Positive when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string): number[] => value.trim().replace(/^v/i, '').split(/[-+]/)[0]!.split('.').map((item) => Number.parseInt(item, 10) || 0)
  const left = parts(a), right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length, 3); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Reads `sha256sum` output (`<hash>  <file>` or `<hash> *<file>`) into a map from file name to lowercase hash. */
export function parseChecksums(text: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match) found.set(match[2]!, match[1]!.toLowerCase())
  }
  return found
}

/** The Release body starts with install instructions; the About tab shows only what changed (the generated notes that come after them). */
export function releaseNotes(body: string): string {
  return body.replace(/^## Download[\s\S]*?(?=^## (?!Download)|(?![\s\S]))/m, '').trim()
}

/** The file the app can apply by itself: the Windows setup, the AppImage (when running as one) or the Debian package. Only x64 is published. */
export function installerFor(assets: ReleaseAsset[], version: string, platform: NodeJS.Platform, appImage = false): ReleaseAsset | undefined {
  const name = platform === 'win32' ? `GearMod-Setup-${version}-x64.exe` : platform === 'linux' ? (appImage ? `GearMod-${version}-x86_64.AppImage` : `GearMod-${version}-amd64.deb`) : undefined
  return name ? assets.find((asset) => asset.name === name) : undefined
}

/** What to type in a terminal to install the Debian package by hand, after downloading it from the Release. */
export const manualCommandFor = (version: string, platform: NodeJS.Platform, appImage: boolean): string | null => platform === 'linux' && !appImage ? `sudo apt install ./GearMod-${version}-amd64.deb` : null

const initial = (currentVersion: string, url: string): AppUpdate => ({ current: currentVersion, latest: null, available: false, notes: '', publishedAt: null, url, canInstall: false, manualCommand: null, checkedAt: null, checking: false, progress: null, installing: false, error: null })

export class UpdateService {
  private state: AppUpdate
  private release: Release | undefined
  private timer: NodeJS.Timeout | undefined
  private readonly request: typeof fetch

  constructor(private readonly deps: UpdateDeps) {
    this.state = initial(deps.currentVersion, `https://github.com/${deps.repo}/releases`)
    this.request = deps.fetchImpl ?? fetch
  }

  get(): AppUpdate { return this.state }

  /** First check shortly after the app opens, then every few hours. Failures stay silent: nobody asked for the check. */
  start(firstAfterMs = 15_000, everyMs = 6 * 3_600_000): void {
    this.stop()
    const run = (): void => { void this.check(true) }
    const first = setTimeout(() => { run(); this.timer = setInterval(run, everyMs); this.timer.unref() }, firstAfterMs)
    first.unref(); this.timer = first
  }

  stop(): void { if (this.timer) { clearTimeout(this.timer); clearInterval(this.timer); this.timer = undefined } }

  async check(silent = false): Promise<AppUpdate> {
    if (this.state.installing || this.state.checking) return this.state
    this.set({ checking: true, error: null })
    try {
      const response = await this.request(`https://api.github.com/repos/${this.deps.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GearMod' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json() as { tag_name?: string; body?: string | null; published_at?: string | null; html_url?: string; assets?: Array<{ name?: string; browser_download_url?: string; size?: number }> }
      const version = String(data.tag_name ?? '').replace(/^v/i, '')
      if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('invalid tag')
      this.release = { version, notes: releaseNotes(data.body ?? ''), publishedAt: data.published_at ?? null, url: data.html_url ?? this.state.url, assets: (data.assets ?? []).flatMap((asset) => asset.name && asset.browser_download_url ? [{ name: asset.name, url: asset.browser_download_url, size: asset.size ?? 0 }] : []) }
      const available = compareVersions(version, this.deps.currentVersion) > 0
      this.set({ checking: false, latest: version, available, notes: this.release.notes, publishedAt: this.release.publishedAt, url: this.release.url, canInstall: available && installerFor(this.release.assets, version, this.deps.platform, Boolean(this.deps.appImagePath)) !== undefined, manualCommand: available ? manualCommandFor(version, this.deps.platform, Boolean(this.deps.appImagePath)) : null, checkedAt: new Date().toISOString() })
    } catch {
      this.set({ checking: false, error: silent ? null : 'check-failed' })
    }
    return this.state
  }

  /** Downloads the installer, checks it against `SHA256SUMS.txt` from the same Release, starts it and quits the app. */
  async install(): Promise<AppUpdate> {
    const release = this.release
    const installer = release && this.state.available ? installerFor(release.assets, release.version, this.deps.platform, Boolean(this.deps.appImagePath)) : undefined
    if (this.state.installing) return this.state
    if (!release || !installer) { this.set({ error: 'no-installer' }); return this.state }
    const sums = release.assets.find((asset) => asset.name === 'SHA256SUMS.txt')
    // Only files published in this repository's Releases are downloaded.
    const prefix = `https://github.com/${this.deps.repo}/releases/download/`
    if (!installer.url.startsWith(prefix) || (sums && !sums.url.startsWith(prefix))) { this.set({ error: 'download-failed' }); return this.state }
    this.set({ installing: true, progress: 0, error: null })
    const file = join(this.deps.downloadDir, installer.name)
    try {
      await mkdir(this.deps.downloadDir, { recursive: true })
      const response = await this.request(installer.url, { headers: { 'User-Agent': 'GearMod' } })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length')) || installer.size
      const hash = createHash('sha256')
      let received = 0, shown = 0
      const source = Readable.fromWeb(response.body as never)
      source.on('data', (chunk: Buffer) => {
        hash.update(chunk); received += chunk.length
        const progress = total ? Math.min(1, received / total) : 0
        if (progress - shown >= 0.01) { shown = progress; this.set({ progress }) }
      })
      await pipeline(source, createWriteStream(file))
      if (!sums) { await rm(file, { force: true }); this.set({ installing: false, progress: null, error: 'checksum-missing' }); return this.state }
      const listing = await this.request(sums.url, { headers: { 'User-Agent': 'GearMod' } })
      const expected = listing.ok ? parseChecksums(await listing.text()).get(installer.name) : undefined
      if (!expected) { await rm(file, { force: true }); this.set({ installing: false, progress: null, error: 'checksum-missing' }); return this.state }
      if (hash.digest('hex') !== expected) { await rm(file, { force: true }); this.set({ installing: false, progress: null, error: 'checksum-mismatch' }); return this.state }
    } catch {
      await rm(file, { force: true }).catch(() => undefined)
      this.set({ installing: false, progress: null, error: 'download-failed' })
      return this.state
    }
    try { await this.deps.launch(file) } catch { this.set({ installing: false, progress: null, error: 'launch-failed' }); return this.state }
    this.set({ progress: 1 })
    this.deps.quit()
    return this.state
  }

  private set(patch: Partial<AppUpdate>): void {
    this.state = { ...this.state, ...patch }
    this.deps.emit(this.state)
  }
}

/** What only the running process knows: runtime versions, system, build date (the packaged app's modification time) and data folder. */
export interface AboutEnv { versions: Record<string, string | undefined>; system: string; buildDate: string | null; dataDir: string }

/** Reads the author, license and homepage from the app's package.json and adds the runtime information (About tab). */
export async function readAbout(appPath: string, version: string, env: AboutEnv): Promise<AppAbout> {
  const runtime = { buildDate: env.buildDate, electron: env.versions.electron ?? '', chromium: env.versions.chrome ?? '', node: env.versions.node ?? '', v8: env.versions.v8 ?? '', system: env.system, dataDir: env.dataDir }
  const fallback = { name: 'GearMod', version, author: 'Francisco Lucas Lima Sena', authorEmail: null, license: 'PolyForm-Shield-1.0.0', homepage: 'https://github.com/flucassena/gearmod', ...runtime }
  try {
    const pkg = JSON.parse(await readFile(join(appPath, 'package.json'), 'utf8')) as { author?: string | { name?: string; email?: string }; license?: string; homepage?: string }
    const author = typeof pkg.author === 'string' ? { name: pkg.author, email: undefined } : pkg.author ?? {}
    return { ...fallback, author: author.name ?? fallback.author, authorEmail: author.email ?? null, license: pkg.license ?? fallback.license, homepage: pkg.homepage ?? fallback.homepage }
  } catch {
    return fallback
  }
}
