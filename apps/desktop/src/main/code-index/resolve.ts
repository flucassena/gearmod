import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { LANGUAGES, familyOf, type Family } from './languages'
import type { Db } from './store'
import { ablated, ablationTag } from './ablation'

/**
 * Links references to definitions (edges) in a folder. It depends on the whole tree (imports, types), so it is per folder,
 * unlike extraction. It can redo only the files affected by a change.
 */
// bump the number when the rule changes: folders are relinked even with no changed file (the ablation tag is empty in the app)
export const LINKER_VERSION = `7${ablationTag() ? `-${ablationTag()}` : ''}`

const CLASSY = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'type', 'module'])
const SELF = new Set(['this', 'self', 'cls', 'Self', '$this'])
const EDGE_KIND: Record<string, string> = { call: 'calls', new: 'instantiates', render: 'renders', type: 'references', ref: 'references' }
// too generic to link by name alone when the receiver's type is unknown (JS, Python, C#, Java, Unity)
const STOP = new Set(('get set has add delete push pop shift unshift map filter forEach reduce find findIndex some every join split slice splice replace replaceAll trim then catch finally toString valueOf keys values entries includes indexOf lastIndexOf run all exec prepare close open on off once emit send write read start stop parse stringify log error warn info debug test match assign from of call apply bind resolve reject next length size clear sort concat flat flatMap at fill startsWith endsWith padStart padEnd toLowerCase toUpperCase dispose update create list remove invoke handle listen format load save init render setState append insert pipe subscribe unsubscribe dispatch query execute fetch post put patch request response json text status sync reset destroy kill spawn exit wait sleep print println printf len cap make new copy String Error ' +
  'Add AddRange Remove RemoveAt RemoveAll Contains ContainsKey TryGetValue Find FindAll FindIndex Exists Where Select SelectMany Any All First FirstOrDefault Last LastOrDefault Single ToList ToArray ToDictionary Count Sum Min Max Average OrderBy OrderByDescending ThenBy GroupBy Distinct Skip Take Reverse Insert IndexOf Sort Clear Equals GetHashCode ToString Dispose Invoke GetComponent GetComponents GetComponentInChildren AddComponent Destroy Instantiate SetActive Log LogWarning LogError Format Substring Trim Split Replace StartsWith EndsWith Parse TryParse Lerp Clamp Abs Range Play Pause Stop Start Update Awake Enable Disable Show Hide Move Rotate Translate Load Save Init Initialize Reset Close Open Read Write Send Get Set Put Peek Push Pop Enqueue Dequeue CopyTo stream collect equals hashCode size isEmpty contains').split(' '))
// environment globals: calls on them are never the project's
const GLOBALS = new Set('window document console Math JSON process navigator localStorage sessionStorage Object Array Promise Date Number String Boolean Symbol Reflect Proxy globalThis require module exports Buffer URL URLSearchParams Intl RegExp Error Map Set WeakMap WeakSet crypto performance fetch setTimeout setInterval clearTimeout clearInterval queueMicrotask structuredClone describe it test expect beforeEach afterEach beforeAll afterAll vi jest os sys print len str int dict list fmt'.split(' '))
// languages with declared types: when the type chain fails, it is a library/collection, not worth guessing by name
const TYPED = new Set<Family>(['csharp', 'java', 'go', 'rust'])

export interface Sym { id: number; sha: string; idx: number; name: string; qname: string; kind: string; parent: number; line: number; end_line: number; signature: string; exported: number; owner: string | null; path: string; family: Family | null }
interface ImportRow { sha: string; spec: string; local: string | null; imported: string | null; reexport: number; line: number }
interface BindRow { sha: string; scope: number; name: string; type: string; kind: string }
interface HeritageRow { sha: string; owner: number; owner_name: string | null; kind: string; target: string }
interface RefRow { src: number; name: string; receiver: string | null; kind: string; line: number }
interface FileCtx { path: string; sha: string; family: Family | null; scope: Map<string, { paths: string[]; imported: string | null }>; wild: string[]; bound: Set<string>; namespaces: string[]; targets: string[]; syms: Sym[] }
type TypeRef = { type: Sym; static?: boolean } | { ns: string[] } | { obj: Map<string, string>; fc: FileCtx }
interface Hit { s: Sym; conf: number }

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const group = <T extends { sha: string }>(rows: T[]): Map<string, T[]> => { const out = new Map<string, T[]>(); for (const row of rows) { const list = out.get(row.sha); if (list) list.push(row); else out.set(row.sha, [row]) } return out }
const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]) }

function splitTopLevel(text: string, sep = ','): string[] {
  const out: string[] = []
  let depth = 0, current = '', previous = ''
  for (const ch of text) {
    if ('<[({'.includes(ch)) depth++
    else if ('>])}'.includes(ch) && !(ch === '>' && previous === '=')) depth--
    previous = ch
    if (ch === sep && depth === 0) { out.push(current); current = '' } else current += ch
  }
  out.push(current)
  return out.map((part) => part.trim()).filter(Boolean)
}

/** "Useful" type of an annotation: `Promise<Foo | null>` → Foo, `Pick<Bar, 'x'>` → Bar, `*Baz` → Baz. */
export function normType(input: string | null | undefined): string | null {
  if (!input) return null
  let text = input.trim()
  for (let i = 0; i < 6; i++) {
    const before = text
    text = text.replace(/^(readonly|const|mut|dyn|impl|ref|out|in|params|final|static|struct|class|typeof)\s+/, '').replace(/^[&*?]+\s*/, '').replace(/^\[\]\s*/, '').replace(/(\[\]|\?)+$/, '').trim()
    const union = splitTopLevel(text, '|').filter((part) => !/^(null|undefined|void|None|nil)$/.test(part))
    if (union[0]) text = union[0]
    const wrapper = text.match(/^(Promise|PromiseLike|Array|ReadonlyArray|Readonly|Partial|Required|Pick|Omit|NonNullable|Awaited|Ref|MutableRefObject|Option|Optional|List|IList|IEnumerable|ICollection|Set|HashSet|Vec|Box|Rc|Arc|RefCell|Cell|Mutex|RwLock|Task|ValueTask|Observable|Lazy|Result)\s*[<[]\s*(.*)\s*[>\]]$/s)
    if (wrapper) text = splitTopLevel(wrapper[2] ?? '')[0] ?? ''
    if (text === before) break
  }
  const base = text.replace(/[<[].*$/s, '').trim()
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(base) ? base : null
}

/** `{ a: Foo; b?: Bar<X> }` → Map(a → 'Foo', b → 'Bar<X>'): object types written in the annotation itself. */
function objectMembers(text: string): Map<string, string> {
  const inner = text.trim().replace(/^\{/, '').replace(/\}$/, '')
  const out = new Map<string, string>()
  for (const part of splitTopLevel(inner.replace(/;/g, ','))) {
    const match = part.match(/^(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*([\s\S]+)$/)
    if (match?.[1] && match[2]) out.set(match[1], match[2].trim())
  }
  return out
}

/** `function setup(): Promise<{ db: Db; manager: GitManager }>` → Map(db → 'Db', manager → 'GitManager'). Tolerates a cut signature. */
function returnObject(fn: Sym): Map<string, string> | null {
  if (fn.family !== 'js') return null
  const match = (fn.signature ?? '').match(/\)\s*:\s*(?:Promise\s*<\s*)?\{([\s\S]*)$/)
  return match ? objectMembers(`{${match[1]!.replace(/\}\s*>?\s*(=>|\{)?\s*$/, '')}}`) : null
}

function returnType(fn: Sym): string | null {
  const signature = fn.signature ?? ''
  let found: string | undefined
  if (fn.family === 'js') { const i = signature.lastIndexOf('):'); if (i >= 0) found = signature.slice(i + 2).replace(/=>.*$/s, '').replace(/\{\s*$/, '') }
  else if (fn.family === 'python' || fn.family === 'rust') found = signature.match(/->\s*(.+?)\s*(:|where\b|\{|$)/)?.[1]
  else if (fn.family === 'go') {
    const rest = signature.replace(/^func\s*(\([^)]*\))?\s*[\w]+\s*(\[[^\]]*\])?\s*/, '')
    let depth = 0, i = 0
    for (; i < rest.length; i++) { if (rest[i] === '(') depth++; else if (rest[i] === ')') { depth--; if (depth === 0) break } }
    found = rest.slice(i + 1).replace(/^\s*\(/, '').split(',')[0]
  } else found = signature.match(new RegExp(`([\\w.<>\\[\\]?]+)\\s+${fn.name.replace(/\W/g, '')}\\s*[(<]`))?.[1]
  return normType(found ?? '')
}

// ---- module resolution ------------------------------------------------------------------------------------------

type ModuleResolver = (family: Family | null, from: string, spec: string) => string[]

function moduleResolver(root: string, paths: Set<string>, manifests: string[]): ModuleResolver {
  const byBase = new Map<string, string[]>()
  for (const path of paths) push(byBase, path.slice(path.lastIndexOf('/') + 1), path)
  const readJson = (path: string): Record<string, unknown> | null => {
    try { return JSON.parse(readFileSync(join(root, path), 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown> } catch { return null }
  }
  const packages: Array<{ name: string; dir: string; entries: string[] }> = []
  const aliases: Array<{ dir: string; prefix: string; wild: boolean; targets: string[] }> = []
  const goModules: Array<{ dir: string; mod: string }> = []
  const cargo: string[] = []
  for (const manifest of manifests) {
    const base = manifest.slice(manifest.lastIndexOf('/') + 1), dir = dirOf(manifest)
    if (base === 'package.json') {
      const json = readJson(manifest)
      if (json && typeof json.name === 'string') {
        const exports = json.exports as Record<string, unknown> | string | undefined
        const dot = typeof exports === 'object' ? exports?.['.'] as Record<string, unknown> | string | undefined : undefined
        const entry = typeof exports === 'string' ? exports : typeof dot === 'string' ? dot : dot?.import ?? dot?.default ?? dot?.types
        packages.push({ name: json.name, dir, entries: [json.types, json.source, entry, json.module, json.main, 'src/index', 'index'].filter((item): item is string => typeof item === 'string') })
      }
    } else if (/^[jt]sconfig.*\.json$/.test(base)) {
      const options = readJson(manifest)?.compilerOptions as { paths?: Record<string, string[]>; baseUrl?: string } | undefined
      if (options?.paths) {
        const baseUrl = posix.normalize(posix.join(dir, options.baseUrl ?? '.'))
        for (const [key, targets] of Object.entries(options.paths)) aliases.push({ dir, prefix: key.replace(/\*$/, ''), wild: key.endsWith('*'), targets: targets.map((target) => posix.join(baseUrl, target.replace(/\*$/, ''))) })
      } else if (options?.baseUrl) aliases.push({ dir, prefix: '', wild: true, targets: [posix.normalize(posix.join(dir, options.baseUrl))] })
    } else if (base === 'go.mod') {
      try { const mod = readFileSync(join(root, manifest), 'utf8').match(/^module\s+(\S+)/m)?.[1]; if (mod) goModules.push({ dir, mod }) } catch { /* unreadable go.mod */ }
    } else if (base === 'Cargo.toml') cargo.push(dir)
  }
  packages.sort((a, b) => b.name.length - a.name.length)
  aliases.sort((a, b) => b.prefix.length - a.prefix.length)

  const JS_EXT = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs', '/index.jsx']
  const tryJs = (input: string): string[] => {
    const base = posix.normalize(input).replace(/^\.\//, '')
    for (const ext of JS_EXT) if (paths.has(base + ext)) return [base + ext]
    const noJs = base.replace(/\.(m|c)?jsx?$/, '')
    if (noJs !== base) for (const ext of JS_EXT) if (paths.has(noJs + ext)) return [noJs + ext]
    return []
  }
  const bySuffix = (relativePath: string, exts: string[]): string[] => {
    const out: string[] = []
    for (const ext of exts) {
      const full = relativePath + ext
      for (const path of byBase.get(full.slice(full.lastIndexOf('/') + 1)) ?? []) if (path === full || path.endsWith(`/${full}`)) out.push(path)
    }
    return out.sort((a, b) => a.length - b.length)
  }
  const cache = new Map<string, string[]>()
  return (family, from, spec) => {
    const key = `${family}\0${dirOf(from)}\0${spec}`
    const cached = cache.get(key)
    if (cached) return cached
    let out: string[] = []
    if (family === 'js') {
      if (spec.startsWith('.')) out = tryJs(posix.join(dirOf(from), spec))
      else {
        const pkg = packages.find((item) => spec === item.name || spec.startsWith(`${item.name}/`))
        if (pkg) {
          const rest = spec.slice(pkg.name.length + 1)
          if (rest) { out = tryJs(posix.join(pkg.dir, rest)); if (!out.length) out = tryJs(posix.join(pkg.dir, 'src', rest)) }
          else for (const entry of pkg.entries) { out = tryJs(posix.join(pkg.dir, entry)); if (out.length) break }
        }
        if (!out.length) for (const alias of aliases) {
          if (alias.dir && !from.startsWith(`${alias.dir}/`)) continue
          if (alias.wild ? !spec.startsWith(alias.prefix) : spec !== alias.prefix) continue
          for (const target of alias.targets) { out = tryJs(alias.wild ? target + spec.slice(alias.prefix.length) : target); if (out.length) break }
          if (out.length) break
        }
      }
    } else if (family === 'python') {
      const dots = spec.match(/^\.*/)?.[0].length ?? 0
      const rest = spec.slice(dots).replace(/\./g, '/')
      if (dots) {
        let dir = dirOf(from)
        for (let i = 1; i < dots; i++) dir = dirOf(dir)
        const base = posix.join(dir, rest)
        out = rest ? [`${base}.py`, `${base}/__init__.py`, `${base}.pyi`].filter((path) => paths.has(path)) : [posix.join(dir, '__init__.py')].filter((path) => paths.has(path))
      } else out = bySuffix(rest, ['.py', '/__init__.py', '.pyi']).slice(0, 1)
    } else if (family === 'go') {
      const module = goModules.find((item) => spec === item.mod || spec.startsWith(`${item.mod}/`))
      if (module) { const dir = posix.join(module.dir, spec.slice(module.mod.length + 1)); out = [...paths].filter((path) => dirOf(path) === dir && path.endsWith('.go') && !path.endsWith('_test.go')) }
    } else if (family === 'java') {
      const rel = spec.replace(/\./g, '/')
      out = bySuffix(rel, ['.java'])
      if (!out.length) out = [...paths].filter((path) => path.endsWith('.java') && (dirOf(path) === rel || dirOf(path).endsWith(`/${rel}`)))
      if (!out.length && rel.includes('/')) out = bySuffix(dirOf(rel), ['.java'])
    } else if (family === 'rust') {
      const segments = spec.split('::')
      const crateRoot = cargo.filter((dir) => !dir || from.startsWith(`${dir}/`)).sort((a, b) => b.length - a.length)[0]
      let dir: string | null = segments[0] === 'crate' ? posix.join(crateRoot ?? '', 'src') : segments[0] === 'super' ? dirOf(dirOf(from)) : segments[0] === 'self' ? dirOf(from) : null
      if (dir !== null) {
        let found: string[] = []
        for (const segment of segments.slice(1)) {
          const files = [posix.join(dir, `${segment}.rs`), posix.join(dir, segment, 'mod.rs')].filter((path) => paths.has(path))
          if (!files.length) break
          found = files
          dir = posix.join(dir, segment)
        }
        out = found.length ? found : [posix.join(dir, 'lib.rs'), posix.join(dir, 'main.rs'), posix.join(dir, 'mod.rs')].filter((path) => paths.has(path))
      }
    } else if (family === 'php') {
      const segments = spec.split('\\')
      for (let i = 0; i < segments.length && !out.length; i++) out = bySuffix(segments.slice(i).join('/'), ['.php']).slice(0, 1)
    } else if (family === 'ruby') {
      out = spec.startsWith('./') ? [`${posix.join(dirOf(from), spec.slice(2))}.rb`].filter((path) => paths.has(path)) : bySuffix(spec, ['.rb']).slice(0, 1)
    } else if (family === 'c') {
      out = spec.startsWith('./') ? [posix.normalize(posix.join(dirOf(from), spec.slice(2)))].filter((path) => paths.has(path)) : []
      if (!out.length) out = bySuffix(spec.replace(/^\.\//, ''), ['']).slice(0, 1)
    }
    cache.set(key, out)
    return out
  }
}

// ---- folder context ---------------------------------------------------------------------------------------------

interface RootContext {
  paths: Set<string>; shaOf: Map<string, string>; pathOf: Map<string, string>; langOfSha: Map<string, string>
  syms: Map<string, Sym[]>; byName: Map<string, Sym[]>; members: Map<string, Map<string, Sym[]>>; nsMembers: Map<string, Map<string, Sym[]>>
  imports: Map<string, ImportRow[]>; binds: Map<string, BindRow[]>; heritage: Map<string, HeritageRow[]>; defaults: Map<string, string>
  resolveModule: ModuleResolver
}

function loadContext(db: Db, root: string): RootContext {
  const trees = db.prepare('select path, sha, lang from trees where root = ?').all(root) as Array<{ path: string; sha: string; lang: string }>
  const paths = new Set(trees.map((row) => row.path))
  const shaOf = new Map(trees.map((row) => [row.path, row.sha]))
  const langOfSha = new Map(trees.map((row) => [row.sha, row.lang]))
  const pathOf = new Map<string, string>()
  for (const row of trees) if (!pathOf.has(row.sha)) pathOf.set(row.sha, row.path)
  const inRoot = 'sha in (select sha from trees where root = ?)'
  const rows = db.prepare(`select id, sha, idx, name, qname, kind, parent, line, end_line, signature, exported, owner from symbols where ${inRoot} order by sha, idx`).all(root) as Sym[]
  const syms = new Map<string, Sym[]>()
  for (const symbol of rows) {
    symbol.path = pathOf.get(symbol.sha) ?? ''
    symbol.family = familyOf(langOfSha.get(symbol.sha))
    let list = syms.get(symbol.sha)
    if (!list) { list = []; syms.set(symbol.sha, list) }
    list[symbol.idx] = symbol
  }
  const byName = new Map<string, Sym[]>()
  const members = new Map<string, Map<string, Sym[]>>()
  const nsMembers = new Map<string, Map<string, Sym[]>>()
  const addMember = (map: Map<string, Map<string, Sym[]>>, owner: string, symbol: Sym): void => { let inner = map.get(owner); if (!inner) { inner = new Map(); map.set(owner, inner) } push(inner, symbol.name, symbol) }
  for (const symbol of rows) {
    // test cases (describe/it) are sources of edges, never targets
    if (symbol.kind === 'file' || symbol.kind === 'test') continue
    push(byName, symbol.name, symbol)
    const parent = syms.get(symbol.sha)?.[symbol.parent]
    const owner = symbol.owner ?? (parent && (CLASSY.has(parent.kind) || parent.kind === 'const') ? parent.name : null)
    if (owner) addMember(members, owner, symbol)
    // C#: namespace → name → symbols (`using` points to namespaces, not files)
    if (symbol.family === 'csharp' && parent?.kind === 'module') addMember(nsMembers, parent.qname, symbol)
  }
  const manifests = db.prepare('select manifests from roots where root = ?').pluck().get(root) as string | undefined
  return {
    paths, shaOf, pathOf, langOfSha, syms, byName, members, nsMembers,
    imports: group(db.prepare(`select * from imports where ${inRoot}`).all(root) as ImportRow[]),
    binds: group(db.prepare(`select * from binds where ${inRoot}`).all(root) as BindRow[]),
    heritage: group(db.prepare(`select * from heritage where ${inRoot}`).all(root) as HeritageRow[]),
    defaults: new Map((db.prepare(`select sha, default_export from blobs where ${inRoot} and default_export is not null`).all(root) as Array<{ sha: string; default_export: string }>).map((row) => [row.sha, row.default_export])),
    resolveModule: moduleResolver(root, paths, manifests ? JSON.parse(manifests) as string[] : [])
  }
}

// ---- linking -------------------------------------------------------------------------------------------------------

function linker(ctx: RootContext, refsOf: (sha: string) => RefRow[]): { linkFile(path: string): { edges: Array<{ src: number; dst: number; kind: string; line: number; n: number; conf: number; lines: number[] }>; fileEdges: Array<[string, number]> } } {
  const fileCache = new Map<string, FileCtx>()
  const fileCtx = (path: string): FileCtx => {
    const cached = fileCache.get(path)
    if (cached) return cached
    const sha = ctx.shaOf.get(path) ?? ''
    const family = familyOf(ctx.langOfSha.get(sha))
    const scope: FileCtx['scope'] = new Map()
    const wild: string[] = [], targets: string[] = []
    const imports = ctx.imports.get(sha) ?? []
    for (const imp of imports) {
      const found = ctx.resolveModule(family, path, imp.spec)
      if (!found.length) continue
      targets.push(...found)
      if (imp.local === '*') { wild.push(...found); continue }
      if (!imp.local) continue
      // Python: `from package import module` brings the module, not a symbol
      if (family === 'python' && imp.imported && imp.imported !== '*' && imp.imported !== 'pkg') {
        const sub = ctx.resolveModule(family, path, imp.spec.endsWith('.') ? imp.spec + imp.imported : `${imp.spec}.${imp.imported}`)
        if (sub.length) { scope.set(imp.local, { paths: sub, imported: '*' }); targets.push(...sub); continue }
      }
      scope.set(imp.local, { paths: found, imported: imp.imported })
    }
    const syms = ctx.syms.get(sha) ?? []
    // C#: visible namespaces = the file's (A.B also sees A) + the `using`s
    const namespaces: string[] = []
    if (family === 'csharp') {
      for (const symbol of syms) if (symbol?.kind === 'module') { const parts = symbol.qname.split('.'); for (let i = parts.length; i > 0; i--) namespaces.push(parts.slice(0, i).join('.')) }
      for (const imp of imports) namespaces.push(imp.spec.replace(/^static\s+|^global::/g, ''))
    }
    // imported names, including from external packages: never fall into the "unique project name"
    const bound = new Set(imports.map((imp) => imp.local).filter((local): local is string => !!local))
    const created: FileCtx = { path, sha, family, scope, wild, bound, namespaces: [...new Set(namespaces)], targets: [...new Set(targets)], syms }
    fileCache.set(path, created)
    return created
  }

  // symbol exported as `name` by a set of files, following re-exports
  const exportCache = new Map<string, Sym[]>()
  function resolveExport(paths: string[] | undefined, name: string | null, depth = 0): Sym[] {
    if (!paths?.length || !name || depth > 6) return []
    const key = `${paths.join('|')}\0${name}`
    const cached = exportCache.get(key)
    if (cached) return cached
    exportCache.set(key, [])
    const out: Sym[] = []
    for (const path of paths) {
      const fc = fileCtx(path)
      const want = name === 'default' ? ctx.defaults.get(fc.sha) : name
      if (want) {
        const hit = fc.syms.filter((symbol) => symbol && symbol.idx > 0 && symbol.name === want && (symbol.parent === 0 || fc.syms[symbol.parent]?.kind === 'module') && symbol.kind !== 'method')
        if (hit.length) { out.push(...hit); continue }
      }
      for (const imp of ctx.imports.get(fc.sha) ?? []) {
        if (imp.local === name || (name === 'default' && imp.local === want)) { if (imp.imported !== '*') out.push(...resolveExport(ctx.resolveModule(fc.family, path, imp.spec), imp.imported, depth + 1)) }
        else if (imp.local === '*' && imp.reexport) out.push(...resolveExport(ctx.resolveModule(fc.family, path, imp.spec), name, depth + 1))
      }
    }
    const unique = [...new Set(out)]
    exportCache.set(key, unique)
    return unique
  }
  const nsLookup = (fc: FileCtx, name: string): Sym[] => { for (const ns of fc.namespaces) { const hit = ctx.nsMembers.get(ns)?.get(name); if (hit?.length) return hit } return [] }
  const exportNamespace = (paths: string[], name: string | null): string[] | null => {
    for (const path of paths) { const fc = fileCtx(path); for (const imp of ctx.imports.get(fc.sha) ?? []) if (imp.local === name && imp.imported === '*') return ctx.resolveModule(fc.family, path, imp.spec) }
    return null
  }
  const chainOf = (fc: FileCtx, idx: number): Sym[] => { const out: Sym[] = []; for (let i = idx; i >= 0; ) { const symbol = fc.syms[i]; if (!symbol) break; out.push(symbol); if (i === 0) break; i = symbol.parent } return out }
  const classOf = (fc: FileCtx, idx: number): Sym | null => chainOf(fc, idx).find((symbol) => CLASSY.has(symbol.kind) && symbol.kind !== 'module') ?? null

  // type (class/interface/struct) by name, in the context of a file
  function resolveTypeName(fc: FileCtx, name: string | null, depth = 0): Sym | null {
    if (!name || depth > 4) return null
    if (name.includes('.')) {
      const [head, ...rest] = name.split('.')
      let current = headType(fc, head ?? '', null, depth + 1)
      for (const part of rest) { if (!current) break; current = stepType(current, part, depth + 1) }
      return current && 'type' in current ? current.type : null
    }
    const local = fc.syms.find((symbol) => symbol && symbol.name === name && CLASSY.has(symbol.kind))
    if (local) return local
    const binding = fc.scope.get(name)
    if (binding) { const hit = resolveExport(binding.paths, binding.imported === '*' ? name : binding.imported).find((symbol) => CLASSY.has(symbol.kind)); if (hit) return hit }
    const ns = nsLookup(fc, name).find((symbol) => CLASSY.has(symbol.kind))
    if (ns) return ns
    const wild = resolveExport(fc.wild, name).find((symbol) => CLASSY.has(symbol.kind))
    if (wild) return wild
    const all = (ctx.byName.get(name) ?? []).filter((symbol) => CLASSY.has(symbol.kind) && symbol.family === fc.family)
    const sameDir = all.filter((symbol) => dirOf(symbol.path) === dirOf(fc.path))
    if (sameDir.length === 1) return sameDir[0]!
    return all.length === 1 ? all[0]! : null
  }

  const parentCache = new Map<number, Sym[]>()
  function parentsOf(type: Sym): Sym[] {
    const cached = parentCache.get(type.id)
    if (cached) return cached
    parentCache.set(type.id, [])
    const out: Sym[] = []
    const fc = fileCtx(type.path)
    for (const row of ctx.heritage.get(type.sha) ?? []) if (row.owner === type.idx || row.owner_name === type.name) { const parent = resolveTypeName(fc, row.target); if (parent && parent.id !== type.id) out.push(parent) }
    // impl Trait for T / methods with an owner in other files (Go, Rust)
    for (const [sha, list] of ctx.heritage) if (sha !== type.sha) for (const row of list) if (row.owner_name === type.name) { const parent = resolveTypeName(fileCtx(ctx.pathOf.get(sha) ?? ''), row.target); if (parent && parent.id !== type.id) out.push(parent) }
    parentCache.set(type.id, out)
    return out
  }
  // the same class in several files (C# partial, reopened Ruby class)
  const partsCache = new Map<number, Sym[]>()
  function partsOf(type: Sym): Sym[] {
    const cached = partsCache.get(type.id)
    if (cached) return cached
    const out = (ctx.byName.get(type.name) ?? []).filter((symbol) => symbol.id === type.id || (symbol.qname === type.qname && symbol.kind === type.kind && symbol.family === type.family && (symbol.family === 'csharp' || symbol.family === 'ruby')))
    if (!out.some((symbol) => symbol.id === type.id)) out.unshift(type)
    partsCache.set(type.id, out)
    return out
  }
  function memberLookup(type: Sym | null, name: string, depth = 0): Sym[] {
    if (!type || depth > 5) return []
    const ids = new Set(partsOf(type).map((symbol) => symbol.id))
    const own = (ctx.members.get(type.name)?.get(name) ?? []).filter((symbol) => ids.has(ctx.syms.get(symbol.sha)?.[symbol.parent]?.id ?? -1) || (symbol.owner === type.name && symbol.family === type.family))
    if (own.length) return own
    for (const part of partsOf(type)) for (const parent of parentsOf(part)) { const found = memberLookup(parent, name, depth + 1); if (found.length) return found }
    return []
  }
  function fieldType(type: Sym, name: string, depth = 0): TypeRef | null {
    if (depth > 5) return null
    for (const part of partsOf(type)) {
      const bind = (ctx.binds.get(part.sha) ?? []).find((row) => row.scope === part.idx && row.name === name && row.kind === 'field')
      if (bind) return typeFromBind(fileCtx(part.path), bind, part.idx, depth + 1)
    }
    for (const parent of parentsOf(type)) { const found = fieldType(parent, name, depth + 1); if (found) return found }
    // getter/property with a return type
    const member = memberLookup(type, name).find((symbol) => symbol.kind === 'method' || symbol.kind === 'property')
    const result = member ? returnType(member) : null
    const resolved = member && result ? resolveTypeName(fileCtx(member.path), result, depth + 1) : null
    return resolved ? { type: resolved } : null
  }
  function typeFromBind(fc: FileCtx, bind: BindRow, srcIdx: number | null, depth = 0): TypeRef | null {
    if (depth > 5) return null
    if (bind.kind === 'expr') return chainType(fc, bind.type.split('.'), srcIdx, depth + 1)
    if (bind.type.trim().startsWith('{')) return { obj: objectMembers(bind.type), fc }
    // const { board } = await setup(): the `board` variable inside setup (returned as `{ board }`), or the field of its return type
    if (bind.kind === 'destrcall') {
      const fn = resolveCallee(fc, bind.type, srcIdx, depth + 1)
      if (!fn || CLASSY.has(fn.kind)) return null
      const inner = (ctx.binds.get(fn.sha) ?? []).find((row) => row.scope === fn.idx && row.name === bind.name && row.kind !== 'field')
      if (inner) return typeFromBind(fileCtx(fn.path), inner, fn.idx, depth + 1)
      const member = returnObject(fn)?.get(bind.name)
      if (member) {
        if (member.trim().startsWith('{')) return { obj: objectMembers(member), fc: fileCtx(fn.path) }
        const type = resolveTypeName(fileCtx(fn.path), normType(member), depth + 1)
        return type ? { type } : null
      }
      const result = returnType(fn)
      const type = result ? resolveTypeName(fileCtx(fn.path), result, depth + 1) : null
      return type ? fieldType(type, bind.name, depth + 1) : null
    }
    if (bind.kind === 'call') {
      const fn = resolveCallee(fc, bind.type, srcIdx, depth + 1)
      if (!fn) return null
      if (CLASSY.has(fn.kind)) return { type: fn }
      if (['new', 'create', 'getInstance'].includes(fn.name) && fn.owner) { const owner = resolveTypeName(fileCtx(fn.path), fn.owner); if (owner) return { type: owner } }
      const result = returnType(fn)
      if (!result) { const parent = ctx.syms.get(fn.sha)?.[fn.parent]; return fn.name === 'new' && parent && CLASSY.has(parent.kind) ? { type: parent } : null }
      const resolved = resolveTypeName(fileCtx(fn.path), result, depth + 1)
      return resolved ? { type: resolved } : null
    }
    const resolved = resolveTypeName(fc, normType(bind.type), depth + 1)
    return resolved ? { type: resolved } : null
  }
  // `foo` or `a.b.foo` used as a call that initializes a variable
  function resolveCallee(fc: FileCtx, text: string, srcIdx: number | null, depth: number): Sym | null {
    const parts = text.replace(/\?\./g, '.').replace(/::/g, '.').replace(/->/g, '.').split('.')
    const name = parts.pop() ?? ''
    if (!parts.length) return bareLookup(fc, name, srcIdx, 'call')[0]?.s ?? null
    const current = chainType(fc, parts, srcIdx, depth)
    if (current && 'ns' in current) return resolveExport(current.ns, name)[0] ?? null
    if (current && 'type' in current) return memberLookup(current.type, name)[0] ?? null
    return null
  }
  function headType(fc: FileCtx, head: string, srcIdx: number | null, depth = 0): TypeRef | null {
    if (depth > 6) return null
    if (SELF.has(head)) { const cls = srcIdx !== null ? classOf(fc, srcIdx) : null; return cls ? { type: cls } : null }
    if (head.startsWith('new ')) { const type = resolveTypeName(fc, head.slice(4), depth + 1); return type ? { type } : null }
    if (head === 'super') { const cls = srcIdx !== null ? classOf(fc, srcIdx) : null; const parent = cls ? parentsOf(cls)[0] : undefined; return parent ? { type: parent } : null }
    if (srcIdx !== null) {
      const binds = ctx.binds.get(fc.sha) ?? []
      for (const symbol of chainOf(fc, srcIdx)) {
        const bind = binds.find((row) => row.scope === symbol.idx && row.name === head && row.kind !== 'field')
        if (bind) return typeFromBind(fc, bind, srcIdx, depth + 1)
      }
    }
    const binding = fc.scope.get(head)
    if (binding) {
      if (binding.imported === '*' || binding.imported === 'pkg') return { ns: binding.paths }
      const hit = resolveExport(binding.paths, binding.imported)
      const cls = hit.find((symbol) => CLASSY.has(symbol.kind))
      if (cls) return { type: cls, static: true }
      const ns = exportNamespace(binding.paths, binding.imported)
      if (ns) return { ns }
      const value = hit[0]
      if (value) {
        if (value.kind === 'const' && ctx.members.get(value.name)?.size) return { type: value }
        const bind = (ctx.binds.get(value.sha) ?? []).find((row) => row.scope === 0 && row.name === value.name)
        if (bind) return typeFromBind(fileCtx(value.path), bind, 0, depth + 1)
      }
      return null
    }
    const local = fc.syms.find((symbol) => symbol && symbol.idx > 0 && symbol.name === head && symbol.parent === 0)
    if (local && CLASSY.has(local.kind)) return { type: local, static: true }
    if (local && local.kind === 'const' && ctx.members.get(local.name)?.size) return { type: local }
    if (/^[A-Z]/.test(head)) { const type = resolveTypeName(fc, head, depth + 1); if (type) return { type, static: true } }
    // untyped parameter typed by context (`steps: Record<string, Step>` with `type Step = (ctx: UndoCtx) => …`):
    // when every typed declaration with this name in the file agrees on one type, use it
    if (srcIdx !== null && !ablated('types')) {
      const typed = (ctx.binds.get(fc.sha) ?? []).filter((row) => row.name === head && row.kind === 'var').map((row) => normType(row.type))
      const types = new Set(typed)
      const only = types.size === 1 ? [...types][0] : null
      if (only) { const type = resolveTypeName(fc, only, depth + 1); if (type) return { type } }
    }
    return null
  }
  function stepType(current: TypeRef, part: string, depth = 0): TypeRef | null {
    if ('obj' in current) {
      const text = current.obj.get(part)
      if (!text) return null
      if (text.trim().startsWith('{')) return { obj: objectMembers(text), fc: current.fc }
      const resolved = resolveTypeName(current.fc, normType(text), depth + 1)
      return resolved ? { type: resolved } : null
    }
    if ('ns' in current) {
      const hit = resolveExport(current.ns, part)
      const cls = hit.find((symbol) => CLASSY.has(symbol.kind))
      if (cls) return { type: cls, static: true }
      const ns = exportNamespace(current.ns, part)
      return ns ? { ns } : null
    }
    return fieldType(current.type, part, depth + 1)
  }
  function chainType(fc: FileCtx, parts: string[], srcIdx: number | null, depth = 0): TypeRef | null {
    let current = headType(fc, parts[0] ?? '', srcIdx, depth)
    for (const part of parts.slice(1)) { if (!current) return null; current = stepType(current, part, depth) }
    return current
  }

  // name without a receiver: same file → import → inner hook function → implicit member → same package → namespace → import * → unique name
  function bareLookup(fc: FileCtx, name: string, srcIdx: number | null, kind: string): Hit[] {
    const wantType = kind === 'type'
    // `new X()` can only be a class (in JS, also a constructor function)
    const ok = (symbol: Sym | undefined): symbol is Sym => !!symbol && symbol.idx > 0 && symbol.kind !== 'test' && (wantType ? CLASSY.has(symbol.kind) : kind === 'new' ? CLASSY.has(symbol.kind) || (fc.family === 'js' && symbol.kind === 'function') : true)
    const chain = srcIdx !== null ? chainOf(fc, srcIdx) : fc.syms[0] ? [fc.syms[0]] : []
    const chainIdx = new Set(chain.map((symbol) => symbol.idx))
    const implicitMembers = fc.family === 'java' || fc.family === 'csharp' || fc.family === 'php' || fc.family === 'ruby' || fc.family === 'c'
    const local = fc.syms.filter((symbol) => ok(symbol) && symbol.name === name && chainIdx.has(symbol.parent) && (symbol.kind !== 'method' || implicitMembers || !fc.syms[symbol.parent] || fc.syms[symbol.parent]?.kind === 'file'))
    if (local.length) {
      const rank = (symbol: Sym): number => chain.findIndex((item) => item.idx === symbol.parent)
      return [{ s: local.sort((a, b) => rank(a) - rank(b))[0]!, conf: 1 }]
    }
    const binding = fc.scope.get(name)
    if (binding && binding.imported !== '*') { const hit = resolveExport(binding.paths, binding.imported).filter(ok); if (hit.length) return hit.map((s) => ({ s, conf: 1 })) }
    if (!wantType) {
      // const { open } = useFileDocuments(): the `open` function inside the hook (or a member of the return type)
      const binds = ctx.binds.get(fc.sha) ?? []
      const destructured = chain.map((symbol) => binds.find((row) => row.scope === symbol.idx && row.name === name && row.kind === 'destrcall')).find(Boolean)
      const fn = destructured ? resolveCallee(fc, destructured.type, srcIdx, 1) : null
      if (fn) {
        const inner = (ctx.syms.get(fn.sha) ?? []).filter((symbol) => symbol && symbol.parent === fn.idx && symbol.name === name)
        if (inner.length) return inner.map((s) => ({ s, conf: 0.9 }))
        const result = returnType(fn)
        const members = memberLookup(result ? resolveTypeName(fileCtx(fn.path), result) : null, name)
        if (members.length) return members.map((s) => ({ s, conf: 0.9 }))
      }
    }
    if (implicitMembers) { const cls = srcIdx !== null ? classOf(fc, srcIdx) : null; const found = memberLookup(cls, name).filter(ok); if (found.length) return found.map((s) => ({ s, conf: 0.9 })) }
    if (Object.values(LANGUAGES).some((config) => config.family === fc.family && config.samePackageDir)) {
      const same = (ctx.byName.get(name) ?? []).filter((symbol) => ok(symbol) && symbol.family === fc.family && dirOf(symbol.path) === dirOf(fc.path) && symbol.parent === 0)
      if (same.length) return same.slice(0, 3).map((s) => ({ s, conf: 0.9 }))
    }
    const inNamespace = nsLookup(fc, name).filter(ok)
    if (inNamespace.length) return inNamespace.slice(0, 3).map((s) => ({ s, conf: 0.9 }))
    const wild = resolveExport(fc.wild, name).filter(ok)
    if (wild.length) return wild.slice(0, 3).map((s) => ({ s, conf: 0.8 }))
    if (kind === 'ref' || fc.bound.has(name) || GLOBALS.has(name)) return []
    // in JS/TS, Python and Rust a bare name without an import cannot come from another file
    if (fc.family === 'js' || fc.family === 'python' || fc.family === 'rust') return []
    const all = (ctx.byName.get(name) ?? []).filter((symbol) => ok(symbol) && symbol.family === fc.family && symbol.sha !== fc.sha && (symbol.parent === 0 || CLASSY.has(symbol.kind)) && !['method', 'const', 'property'].includes(symbol.kind))
    if (all.length === 1) return [{ s: all[0]!, conf: 0.5 }]
    const top = (path: string): string => path.split('/').slice(0, 2).join('/')
    const near = all.filter((symbol) => top(symbol.path) === top(fc.path))
    return near.length === 1 ? [{ s: near[0]!, conf: 0.4 }] : []
  }

  function resolveRef(fc: FileCtx, ref: RefRow): Hit[] {
    if (!ref.receiver) return bareLookup(fc, ref.name, ref.src, ref.kind)
    if (ablated('types')) return byNameOnly(fc, ref)
    if (ref.receiver !== '(expr)') {
      const parts = ref.receiver.split('.')
      const current = chainType(fc, parts, ref.src)
      if (current && 'ns' in current) { const hit = resolveExport(current.ns, ref.name); if (hit.length) return hit.map((s) => ({ s, conf: 1 })) }
      if (current && 'type' in current) { const hit = memberLookup(current.type, ref.name); if (hit.length) return hit.map((s) => ({ s, conf: 1 })) }
      // the start of the receiver is known, but the rest is not (e.g. Data.actors.Find): it is a collection/library
      if (fc.family && TYPED.has(fc.family) && (current || (parts.length > 1 && headType(fc, parts[0] ?? '', ref.src)))) return []
    }
    const head = ref.receiver.split('.')[0] ?? ''
    if (STOP.has(ref.name) || ref.kind === 'type' || GLOBALS.has(head) || fc.bound.has(head)) return []
    // unknown receiver: only link if the method has a single owner, in an imported file or in the same folder
    const near = new Set(fc.targets)
    const candidates = (ctx.byName.get(ref.name) ?? []).filter((symbol) => (symbol.kind === 'method' || symbol.kind === 'property') && symbol.family === fc.family && (near.has(symbol.path) || dirOf(symbol.path) === dirOf(fc.path)))
    const owners = new Set(candidates.map((symbol) => symbol.owner ?? ctx.syms.get(symbol.sha)?.[symbol.parent]?.id))
    return candidates.length && owners.size === 1 && candidates.length <= 2 ? candidates.map((s) => ({ s, conf: 0.6 })) : []
  }

  // ablation 'types' (bench only): a call on a receiver links to every method or property with that name in the
  // same language, up to 3, without looking at the receiver's type
  function byNameOnly(fc: FileCtx, ref: RefRow): Hit[] {
    const head = ref.receiver?.split('.')[0] ?? ''
    if (ref.kind === 'type' || GLOBALS.has(head)) return []
    return (ctx.byName.get(ref.name) ?? []).filter((symbol) => (symbol.kind === 'method' || symbol.kind === 'property') && symbol.family === fc.family).slice(0, 3).map((s) => ({ s, conf: 0.5 }))
  }

  return {
    linkFile(path) {
      const fc = fileCtx(path)
      const edges = new Map<string, { src: number; dst: number; kind: string; line: number; n: number; conf: number; lines: number[] }>()
      const weights = new Map<string, number>(fc.targets.map((target) => [target, 1]))
      const add = (src: Sym | undefined | null, dst: Sym, kind: string, line: number, conf: number): void => {
        if (!src || src.id === dst.id) return
        const key = `${src.id}:${dst.id}:${kind}`
        const edge = edges.get(key)
        if (edge) { edge.n++; edge.line = Math.min(edge.line, line); edge.conf = Math.max(edge.conf, conf); if (edge.lines.length < 60 && !edge.lines.includes(line)) edge.lines.push(line) }
        else edges.set(key, { src: src.id, dst: dst.id, kind, line, n: 1, conf, lines: [line] })
        if (dst.path !== path) weights.set(dst.path, (weights.get(dst.path) ?? 0) + 1)
      }
      for (const ref of refsOf(fc.sha)) {
        const src = fc.syms[ref.src] ?? fc.syms[0]
        for (const { s, conf } of resolveRef(fc, ref)) add(src, s, EDGE_KIND[ref.kind] ?? 'references', ref.line, conf)
      }
      for (const row of ctx.heritage.get(fc.sha) ?? []) {
        const owner = row.owner > 0 ? fc.syms[row.owner] : resolveTypeName(fc, row.owner_name)
        const target = resolveTypeName(fc, row.target)
        if (owner && target) add(owner, target, row.kind, owner.line, 1)
      }
      return { edges: [...edges.values()], fileEdges: [...weights].filter(([target]) => target !== path) }
    }
  }
}

/** Links the whole folder, or only what a change affects (`changed` + names that existed before in those files). */
export function link(db: Db, root: string, { changed = null, oldNames = [] }: { changed?: string[] | null; oldNames?: string[] } = {}): { files: number; edges: number; ms: number } {
  const started = Date.now()
  const ctx = loadContext(db, root)
  const refs = db.prepare('select src, name, receiver, kind, line from refs where sha = ?')
  const L = linker(ctx, (sha) => refs.all(sha) as RefRow[])
  let targets: string[]
  if (!changed) {
    db.prepare('delete from edges where root = ?').run(root)
    db.prepare('delete from file_edges where root = ?').run(root)
    targets = [...ctx.paths]
  } else {
    // affected: the changed ones, whoever imports them and whoever cites names they define (before or after)
    const set = new Set(changed.filter((path) => ctx.paths.has(path)))
    const names = new Set(oldNames)
    for (const path of set) for (const symbol of ctx.syms.get(ctx.shaOf.get(path) ?? '') ?? []) if (symbol && symbol.idx > 0) names.add(symbol.name)
    const importers = db.prepare('select src from file_edges where root = ? and dst = ?').pluck()
    for (const path of changed) for (const src of importers.all(root, path) as string[]) if (ctx.paths.has(src)) set.add(src)
    const list = [...names]
    for (let i = 0; i < list.length; i += 400) {
      const chunk = list.slice(i, i + 400)
      for (const path of db.prepare(`select distinct t.path from trees t join refs r on r.sha = t.sha where t.root = ? and r.name in (${chunk.map(() => '?').join(',')})`).pluck().all(root, ...chunk) as string[]) set.add(path)
    }
    targets = [...set]
    const ids = db.prepare('select id from symbols where sha = ?').pluck()
    const deleteFrom = db.prepare('delete from edges where root = ? and src = ?')
    const deleteFile = db.prepare('delete from file_edges where root = ? and src = ?')
    db.transaction(() => {
      for (const path of [...targets, ...changed]) { deleteFile.run(root, path); const sha = ctx.shaOf.get(path); if (sha) for (const id of ids.all(sha) as number[]) deleteFrom.run(root, id) }
      // edges to symbols of blobs that left the folder
      db.prepare('delete from edges where root = ? and (src not in (select s.id from trees t join symbols s on s.sha = t.sha where t.root = ?) or dst not in (select s.id from trees t join symbols s on s.sha = t.sha where t.root = ?))').run(root, root, root)
    })()
  }
  const insertEdge = db.prepare('insert into edges(root, src, dst, kind, line, n, conf, lines) values (?,?,?,?,?,?,?,?)')
  const insertFile = db.prepare('insert into file_edges(root, src, dst, weight) values (?,?,?,?)')
  let count = 0
  db.transaction(() => {
    for (const path of targets) {
      const { edges, fileEdges } = L.linkFile(path)
      for (const edge of edges) { insertEdge.run(root, edge.src, edge.dst, edge.kind, edge.line, edge.n, edge.conf, edge.lines.sort((a, b) => a - b).join(',')); count++ }
      for (const [dst, weight] of fileEdges) insertFile.run(root, path, dst, weight)
    }
  })()
  return { files: targets.length, edges: count, ms: Date.now() - started }
}
