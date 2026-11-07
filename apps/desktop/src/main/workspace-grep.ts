import { spawn } from 'node:child_process'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { tm } from './i18n'

export interface GrepOptions { query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean; include?: string | undefined }
export interface GrepMatch { path: string; root: string; line: number; column: number; preview: string; matchStart: number; matchEnd: number }
const maxMatches = 2000, maxFiles = 300, maxMillis = 10_000, maxFileBytes = 1_000_000, previewWidth = 200
const ignored = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage'])

/**
 * `git grep -E` uses the system's POSIX regex: the macOS one does not know `\w`, `\d` and `\s` (glibc and Git for Windows do), so a search for
 * `const \w+` found nothing on the Mac. They become POSIX classes, which every system knows. The JS expression still checks each line.
 */
export function posixRegex(source: string): string {
  const outside: Record<string, string> = { w: '[[:alnum:]_]', W: '[^[:alnum:]_]', d: '[0-9]', D: '[^0-9]', s: '[[:space:]]', S: '[^[:space:]]' }
  const inside: Record<string, string> = { w: '[:alnum:]_', d: '0-9', s: '[:space:]' }
  let out = '', inClass = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (char === '\\' && i + 1 < source.length) {
      const next = source[++i]!, swap = inClass ? inside[next] : outside[next]
      out += swap ?? `\\${next}`
      continue
    }
    if (!inClass && char === '[') { inClass = true; out += char; if (source[i + 1] === '^') out += source[++i]; if (source[i + 1] === ']') out += source[++i]; continue }
    if (inClass && char === '[' && source[i + 1] === ':') { const end = source.indexOf(':]', i + 2); if (end > 0) { out += source.slice(i, end + 2); i = end + 1; continue } }
    if (inClass && char === ']') inClass = false
    out += char
  }
  return out
}

/** JS expression equivalent to the search, used to find the exact snippet in the line and in the non-Git search. */
function matcher(options: GrepOptions): RegExp {
  const source = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try { return new RegExp(options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source, options.caseSensitive ? 'u' : 'iu') } catch { throw new Error(tm().search.invalidRegex) }
}

/** Cuts the line around the match (200 characters) and returns where it ended up in the snippet. */
function preview(text: string, found: { start: number; end: number }): { preview: string; matchStart: number; matchEnd: number } {
  const line = text.replace(/\r$/, '')
  if (line.length <= previewWidth) return { preview: line, matchStart: found.start, matchEnd: found.end }
  const from = Math.max(0, Math.min(found.start - 40, line.length - previewWidth)), cut = line.slice(from, from + previewWidth)
  return { preview: cut, matchStart: Math.max(0, found.start - from), matchEnd: Math.min(cut.length, found.end - from) }
}

const globToRegExp = (glob: string): RegExp => new RegExp(`(^|/)${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\uE000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\uE000/g, '(?:.*/)?')}$`, 'i')

/** `git grep` (respects .gitignore and is fast). Stops on reaching the limits or the time; `null` if the folder is not a repository. */
function gitGrep(root: string, options: GrepOptions, regex: RegExp, take: (match: GrepMatch) => boolean): Promise<'done' | 'limited' | 'none'> {
  return new Promise((resolveRun, reject) => {
    const args = ['-C', root, 'grep', '-n', '--column', '-I', '--untracked', '-z', ...(options.caseSensitive ? [] : ['-i']), ...(options.wholeWord ? ['-w'] : []), options.regex ? '-E' : '-F', '-e', options.regex ? posixRegex(options.query) : options.query]
    const include = (options.include ?? '').split(/[\s,]+/).filter(Boolean)
    if (include.length) args.push('--', ...include)
    const child = spawn('git', args, { windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    let buffered = '', errors = '', limited = false
    const timer = setTimeout(() => { limited = true; child.kill() }, maxMillis)
    const consume = (final: boolean): void => {
      const lines = buffered.split('\n'); buffered = final ? '' : lines.pop() ?? ''
      for (const row of lines) {
        const [path, line, column, ...rest] = row.split('\0')
        if (!path || !line || !column) continue
        const text = rest.join('\0'), found = regex.exec(text)
        const at = found ? { start: found.index, end: found.index + found[0].length } : { start: Math.max(0, Number(column) - 1), end: Math.max(0, Number(column) - 1) + options.query.length }
        if (!take({ path: join(root, path), root, line: Number(line), column: at.start + 1, ...preview(text, at) })) { limited = true; child.kill(); return }
      }
    }
    child.stdout.on('data', (chunk: Buffer) => { buffered += chunk.toString('utf8'); consume(false) })
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); resolveRun('none') })
    child.on('close', (code) => {
      clearTimeout(timer); consume(true)
      if (limited) resolveRun('limited')
      else if (code === 0 || code === 1) resolveRun('done')
      else if (/not a git repository/i.test(errors)) resolveRun('none')
      else reject(new Error(options.regex ? tm().search.invalidRegex : errors.trim().split('\n')[0] || tm().search.searchFailed))
    })
  })
}

/** Root without Git: walks the folders (except dependency and build ones) and reads only text up to 1 MB. */
async function walkGrep(root: string, options: GrepOptions, regex: RegExp, take: (match: GrepMatch) => boolean, deadline: number): Promise<'done' | 'limited'> {
  const filters = (options.include ?? '').split(/[\s,]+/).filter(Boolean).map(globToRegExp), pending = [root]
  while (pending.length) {
    if (Date.now() > deadline) return 'limited'
    const folder = pending.shift()!, entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(folder, entry.name)
      if (entry.isDirectory()) { if (!ignored.has(entry.name)) pending.push(full); continue }
      if (!entry.isFile() || (filters.length && !filters.some((filter) => filter.test(relative(root, full).split(sep).join('/'))))) continue
      const info = await stat(full).catch(() => null)
      if (!info || info.size > maxFileBytes) continue
      const handle = await open(full, 'r').catch(() => null)
      if (!handle) continue
      let bytes: Buffer
      try { bytes = await handle.readFile() } finally { await handle.close() }
      if (bytes.includes(0)) continue
      const lines = bytes.toString('utf8').split('\n')
      for (const [index, text] of lines.entries()) {
        const found = regex.exec(text)
        if (found && !take({ path: full, root, line: index + 1, column: found.index + 1, ...preview(text, { start: found.index, end: found.index + found[0].length }) })) return 'limited'
      }
    }
  }
  return 'done'
}

/** Searches the content of the project's roots. The same file found through nested roots appears once. */
export async function grepProject(roots: string[], options: GrepOptions): Promise<{ results: GrepMatch[]; limited: boolean }> {
  if (!options.query) return { results: [], limited: false }
  const regex = matcher(options), results: GrepMatch[] = [], seen = new Set<string>(), files = new Set<string>(), deadline = Date.now() + maxMillis
  let limited = false
  const take = (match: GrepMatch): boolean => {
    const key = `${match.path}:${match.line}`
    if (seen.has(key)) return true
    if (results.length >= maxMatches || (!files.has(match.path) && files.size >= maxFiles)) { limited = true; return false }
    seen.add(key); files.add(match.path); results.push(match); return true
  }
  const real = [...new Set(await Promise.all(roots.map((root) => realpath(root).catch(() => root))))]
  for (const root of real) {
    if (limited || Date.now() > deadline) { limited = true; break }
    const outcome = await gitGrep(root, options, regex, take)
    if (outcome === 'limited') { limited = true; break }
    // A parent folder of other roots and without Git (the card's worktree one) is not walked: its repositories are already roots.
    if (outcome === 'none' && !real.some((other) => other !== root && other.startsWith(root + sep))) { if (await walkGrep(root, options, regex, take, deadline) === 'limited') limited = true }
  }
  return { results, limited }
}
