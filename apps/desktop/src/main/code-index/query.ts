import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Statement } from 'better-sqlite3'
import { isGenerated, isTest } from './languages'
import { words, type Db } from './store'
import { expandTerms } from './terms'
import { ablated } from './ablation'

/**
 * Queries over a folder's index. Answers are text for the agent (in English, like the other MCP
 * tools): short, with path:line, and with code read from disk on the spot, never an old copy.
 */
export interface SymbolRow { id: number; sha: string; idx: number; name: string; qname: string; kind: string; parent: number; line: number; end_line: number; signature: string; doc: string | null; exported: number; owner: string | null; path: string }
interface EdgeRow { src: number; dst: number; kind: string; line: number; n: number; conf: number; lines: string | null }
export interface SymbolHit { name: string; qname: string; kind: string; path: string; line: number; endLine: number; signature: string }

const CLASSY = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'module', 'type'])
const CALLISH = ['calls', 'instantiates', 'renders']
const KIND_ORDER = ['class', 'interface', 'struct', 'trait', 'function', 'method', 'enum', 'type', 'module', 'property', 'const']
const STOPWORDS = new Set('a o os as de do da dos das e em no na nos nas um uma para por com como que se ao aos onde quando qual quais porque pra sem sobre entre pelo pela isso esse essa este esta ele ela eles elas seu sua ser ter faz fazer fica ficar the of and to in on for with how what where when why which is are does do it this that from by an be as at or not into via flow work works code file files function functions class method'.split(' '))
const linesOf = (edge: { line: number; lines: string | null }): string => edge.lines || String(edge.line)
const by = <T>(score: (item: T) => number) => (a: T, b: T): number => score(a) - score(b)
const testFirst = (path: string): number => (isTest(path) ? 1 : 0)
/** Test code: a test file, or tests inside a source file (Rust `mod tests`, Python/Go `test_*` functions). */
const testSymbol = (symbol: SymbolRow): boolean => isTest(symbol.path) || symbol.kind === 'test' || /(^|\.)tests?\./.test(symbol.qname) || /^test_/.test(symbol.name)
const likely = (conf: number): string => (conf < 0.8 ? ' (likely)' : '')
const kindTag = (kind: string): string => (kind !== 'calls' ? ` [${kind}]` : '')

export class Queries {
  private readonly files = new Map<string, string[]>()
  private readonly symCache = new Map<number, SymbolRow | null>()
  private rootIds?: Set<number>
  private readonly st: Record<'sym' | 'byName' | 'byNameCi' | 'byQname' | 'inFile' | 'in' | 'out' | 'fileIn' | 'paths' | 'fts' | 'rootIds', Statement>

  constructor(private readonly db: Db, readonly root: string) {
    const symbol = 'select s.*, t.path from symbols s join trees t on t.sha = s.sha and t.root = ?'
    this.st = {
      sym: db.prepare(`${symbol} where s.id = ? limit 1`),
      byName: db.prepare(`${symbol} where s.name = ? and s.kind != 'file'`),
      byNameCi: db.prepare(`${symbol} where s.name = ? collate nocase and s.kind != 'file'`),
      byQname: db.prepare(`${symbol} where (s.qname = ? or s.qname like ?) and s.kind != 'file'`),
      inFile: db.prepare(`${symbol} where t.path = ? and s.kind != 'file' order by s.line`),
      in: db.prepare('select src, dst, kind, line, n, conf, lines from edges where root = ? and dst = ?'),
      out: db.prepare('select src, dst, kind, line, n, conf, lines from edges where root = ? and src = ?'),
      fileIn: db.prepare('select src from file_edges where root = ? and dst = ?').pluck(),
      paths: db.prepare('select path from trees where root = ? order by path').pluck(),
      fts: db.prepare('select rowid id, bm25(symbols_fts, 10.0, 2.0, 1.5) score from symbols_fts where symbols_fts match ? order by score limit ?'),
      rootIds: db.prepare('select s.id from symbols s join trees t on t.sha = s.sha and t.root = ?').pluck()
    }
  }

  // ---- basics ----------------------------------------------------------------------------------------------------

  private sym(id: number): SymbolRow | null {
    if (!this.symCache.has(id)) this.symCache.set(id, (this.st.sym.get(this.root, id) as SymbolRow | undefined) ?? null)
    return this.symCache.get(id) ?? null
  }
  private label(symbol: SymbolRow): string { return symbol.kind === 'file' ? symbol.path : symbol.qname }
  private where(symbol: SymbolRow): string { return `${symbol.path}:${symbol.line}` }
  private lines(path: string): string[] {
    let lines = this.files.get(path)
    if (!lines) { try { lines = readFileSync(join(this.root, path), 'utf8').split(/\r?\n/) } catch { lines = [] } this.files.set(path, lines) }
    return lines
  }
  private allPaths(): string[] { return this.st.paths.all(this.root) as string[] }
  /** Index path from a path, suffix or file name (with or without extension). */
  resolvePath(file: string | undefined): string | null {
    if (!file) return null
    const wanted = file.replace(/\\/g, '/').replace(/^\.\//, '')
    const all = this.allPaths()
    if (all.includes(wanted)) return wanted
    const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
    return all.filter((path) => path.endsWith(`/${wanted}`) || base(path) === wanted || base(path).replace(/\.\w+$/, '') === wanted).sort(by((path) => path.length))[0] ?? null
  }
  private rank(list: SymbolRow[]): SymbolRow[] { return list.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.exported - a.exported || testFirst(a.path) - testFirst(b.path) || a.path.length - b.path.length) }
  private fts(match: string, limit: number): Array<{ id: number; score: number }> {
    // the text search is global (blobs are shared across folders): filter by this folder's symbols
    this.rootIds ??= new Set(this.st.rootIds.all(this.root) as number[])
    const ids = this.rootIds
    try { return (this.st.fts.all(match, Math.max(limit * 8, 400)) as Array<{ id: number; score: number }>).filter((row) => ids.has(row.id)).slice(0, limit) } catch { return [] }
  }

  find(name: string, { file, line }: { file?: string; line?: number } = {}): SymbolRow[] {
    if (!name) return []
    const dotted = name.replace(/::/g, '.')
    let list = (dotted.includes('.') ? this.st.byQname.all(this.root, dotted, `%.${dotted}`) : this.st.byName.all(this.root, name)) as SymbolRow[]
    if (!list.length) list = this.st.byNameCi.all(this.root, name) as SymbolRow[]
    if (file) { const path = this.resolvePath(file); const inFile = list.filter((symbol) => symbol.path === path || symbol.path.endsWith(file)); if (inFile.length) list = inFile }
    if (line) { const at = list.filter((symbol) => symbol.line <= line && line <= symbol.end_line); list = at.length ? at : list.sort(by((symbol) => Math.abs(symbol.line - line))).slice(0, 1) }
    return this.rank(list)
  }
  private incoming(id: number, kinds?: string[]): EdgeRow[] { return (this.st.in.all(this.root, id) as EdgeRow[]).filter((edge) => !kinds || kinds.includes(edge.kind)) }
  private outgoing(id: number, kinds?: string[]): EdgeRow[] { return (this.st.out.all(this.root, id) as EdgeRow[]).filter((edge) => !kinds || kinds.includes(edge.kind)) }
  private members(symbol: SymbolRow): SymbolRow[] { return (this.st.inFile.all(this.root, symbol.path) as SymbolRow[]).filter((member) => member.sha === symbol.sha && member.parent === symbol.idx) }
  private withMembers(symbol: SymbolRow): number[] { return CLASSY.has(symbol.kind) ? [symbol.id, ...this.members(symbol).map((member) => member.id)] : [symbol.id] }

  /** One line per call path; the location shows once per symbol, and as `:line` when the file repeats. */
  private flowTree(paths: number[][]): string {
    const shown = new Set<number>()
    return paths.map((path) => {
      let lastFile = ''
      return path.map((id) => {
        const item = this.sym(id)
        if (!item) return '?'
        if (shown.has(id)) { lastFile = item.path; return item.qname }
        shown.add(id)
        const where = item.path === lastFile ? `:${item.line}` : this.where(item)
        lastFile = item.path
        return `${item.qname} (${where})`
      }).join(' → ')
    }).join('\n') + '\n'
  }

  /** Test cases (describe/it, test functions) that call these symbols, directly or through a helper in the test file. */
  private testCases(ids: number[]): Array<{ s: SymbolRow; used: string[] }> {
    const found = new Map<number, { s: SymbolRow; used: Set<string> }>()
    // a case: describe/it, a test-named function, or a function in a test file that nothing calls (an entry point of the runner)
    const isCase = (symbol: SymbolRow): boolean => symbol.kind === 'test' || (testSymbol(symbol) && (/^(test|Test|Should|should)|_test$/.test(symbol.name) || (symbol.kind !== 'class' && !this.incoming(symbol.id).length)))
    for (const id of ids) {
      const target = this.sym(id)
      if (!target) continue
      for (const edge of this.incoming(id)) {
        const caller = this.sym(edge.src)
        if (!caller || !testSymbol(caller)) continue
        const callers = isCase(caller) ? [caller] : this.incoming(caller.id).map((up) => this.sym(up.src)).filter((up): up is SymbolRow => !!up && isCase(up))
        for (const item of callers) { const entry = found.get(item.id) ?? { s: item, used: new Set<string>() }; entry.used.add(target.name); found.set(item.id, entry) }
      }
    }
    return [...found.values()].sort((a, b) => b.used.size - a.used.size || a.s.path.localeCompare(b.s.path) || a.s.line - b.s.line).map(({ s, used }) => ({ s, used: [...used] }))
  }

  private testsFor(ids: number[], hops = 3): { direct: string[]; via: string[] } {
    const direct = new Set<string>(), via = new Set<string>(), seen = new Set(ids)
    let frontier = [...ids]
    for (let hop = 1; hop <= hops && frontier.length; hop++) {
      const next: number[] = []
      for (const id of frontier) for (const edge of this.incoming(id)) {
        if (seen.has(edge.src)) continue
        seen.add(edge.src)
        const caller = this.sym(edge.src)
        if (!caller) continue
        if (testSymbol(caller)) (hop === 1 ? direct : via).add(caller.path)
        else next.push(edge.src)
      }
      frontier = next
    }
    return { direct: [...direct], via: [...via].filter((path) => !direct.has(path)) }
  }

  private dedupeCallers(edges: EdgeRow[]): Array<{ s: SymbolRow; e: EdgeRow }> {
    const merged = new Map<string, { s: SymbolRow; e: EdgeRow }>()
    for (const edge of edges) {
      const caller = this.sym(edge.src)
      if (!caller) continue
      const key = `${caller.id}:${edge.kind}`
      const previous = merged.get(key)
      if (!previous) { merged.set(key, { s: caller, e: { ...edge } }); continue }
      const all = [...new Set([...linesOf(previous.e).split(','), ...linesOf(edge).split(',')].map(Number))].sort((a, b) => a - b)
      previous.e.lines = all.join(',')
      previous.e.line = all[0] ?? previous.e.line
    }
    return [...merged.values()].sort((a, b) => testFirst(a.s.path) - testFirst(b.s.path) || a.s.path.localeCompare(b.s.path) || a.e.line - b.e.line)
  }

  private snippet(symbol: SymbolRow, maxLines: number): string {
    const lines = this.lines(symbol.path)
    let start = symbol.line
    // documentation comment right above
    while (start > 1 && /^\s*(\/\/|\/\*|\*|#|"""|@|\[)/.test(lines[start - 2] ?? '') && symbol.line - start < 12) start--
    const end = Math.min(symbol.end_line, start + maxLines - 1)
    let out = ''
    for (let i = start; i <= end; i++) out += `${i}\t${lines[i - 1] ?? ''}\n`
    if (end < symbol.end_line) out += `… (+${symbol.end_line - end} lines, until ${symbol.end_line})\n`
    return out
  }

  // ---- ferramentas ------------------------------------------------------------------------------------------------

  /** Symbols by name or word (also in Portuguese). Used by the tool and by the editor's "go to symbol". */
  searchSymbols(query: string, { kind, limit = 10 }: { kind?: string; limit?: number } = {}): SymbolHit[] {
    const seen = new Map<number, { s: SymbolRow; score: number }>()
    const add = (symbol: SymbolRow | null, score: number): void => {
      if (!symbol || symbol.kind === 'file' || (kind && symbol.kind !== kind)) return
      const previous = seen.get(symbol.id)
      if (!previous || previous.score < score) seen.set(symbol.id, { s: symbol, score })
    }
    for (const symbol of this.find(query)) add(symbol, 100)
    const tokens = expandTerms(words(query).split(' ').filter((word) => word.length > 1))
    if (tokens.length) for (const row of this.fts(tokens.map((token) => `"${token.replace(/"/g, '')}"*`).join(' OR '), limit * 6)) add(this.sym(row.id), 50 - row.score)
    return [...seen.values()].sort((a, b) => b.score - a.score || Number(isGenerated(a.s.path)) - Number(isGenerated(b.s.path))).slice(0, limit)
      .map(({ s }) => ({ name: s.name, qname: s.qname, kind: s.kind, path: s.path, line: s.line, endLine: s.end_line, signature: s.signature }))
  }

  search(query: string, options: { kind?: string; limit?: number } = {}): string {
    const hits = this.searchSymbols(query, options)
    if (!hits.length) return `Nothing found for "${query}".`
    return hits.map((hit) => `${hit.kind} ${hit.qname} — ${hit.path}:${hit.line}${hit.endLine > hit.line ? `-${hit.endLine}` : ''}\n    ${hit.signature}`).join('\n')
  }

  node({ symbol, file, includeCode = false, line, offset, limit, outline = false }: { symbol?: string; file?: string; includeCode?: boolean; line?: number; offset?: number; limit?: number; outline?: boolean } = {}): string {
    if (!symbol && file) {
      const path = this.resolvePath(file)
      if (!path) return `File is not in the index: ${file}`
      const dependents = this.st.fileIn.all(this.root, path) as string[]
      const dependentsLine = dependents.length ? `Files that depend on this one (${dependents.length}): ${dependents.slice(0, 8).join(', ')}${dependents.length > 8 ? ` +${dependents.length - 8}` : ''}` : 'No project file imports this one.'
      if (outline) {
        const symbols = this.st.inFile.all(this.root, path) as SymbolRow[]
        const depth = new Map<number, number>()
        const rows = symbols.map((item) => { const d = item.parent > 0 ? (depth.get(item.parent) ?? 0) + 1 : 0; depth.set(item.idx, d); return `${'  '.repeat(d)}${item.line}: ${item.kind} ${item.name}${item.kind === 'const' ? '' : ` — ${item.signature.slice(0, 110)}`}` })
        return `# ${path} (${symbols.length} symbols)\n${rows.join('\n')}\n\n${dependentsLine}`
      }
      const lines = this.lines(path)
      const start = Math.max(1, offset ?? 1), end = Math.min(lines.length, start + Math.min(limit ?? 2000, 2000) - 1)
      let out = ''
      for (let i = start; i <= end; i++) out += `${i}\t${lines[i - 1]}\n`
      return `${out}${end < lines.length ? `… (the file has ${lines.length} lines)\n` : ''}\n${dependentsLine}`
    }
    if (!symbol) return 'Give simbolo, arquivo, or both.'
    const defs = this.find(symbol, { file, line })
    if (!defs.length) return `Symbol "${symbol}" not found. Similar:\n${this.search(symbol, { limit: 5 })}`
    const parts: string[] = []
    for (const def of defs.slice(0, 5)) {
      let out = `## ${def.kind} ${def.qname} — ${def.path}:${def.line}-${def.end_line}\n`
      if (def.doc) out += `${def.doc}\n`
      if (!includeCode) out += `${def.signature}\n`
      else if (CLASSY.has(def.kind) && def.end_line - def.line > 120) out += this.snippet({ ...def, end_line: def.line + 3 }, 4) + this.members(def).map((member) => `    ${member.line}: ${member.kind} ${member.name} — ${member.signature.slice(0, 100)}`).join('\n') + '\n'
      else out += `\`\`\`\n${this.snippet(def, 200)}\`\`\`\n`
      const ids = this.withMembers(def)
      const callers = this.dedupeCallers(ids.flatMap((id) => this.incoming(id)))
      const callees = this.outgoing(def.id).filter((edge) => edge.kind !== 'references' || CLASSY.has(this.sym(edge.dst)?.kind ?? ''))
      out += `\nUsed by (${callers.length}):\n${callers.slice(0, 15).map((c) => `  ${this.label(c.s)} — ${c.s.path}:${linesOf(c.e)}${kindTag(c.e.kind)}${likely(c.e.conf)}`).join('\n') || '  (nothing in the project)'}`
      if (callers.length > 15) out += `\n  … +${callers.length - 15}`
      out += `\nUses (${callees.length}):\n${callees.slice(0, 15).map((edge) => { const target = this.sym(edge.dst); return target ? `  ${target.qname} — ${this.where(target)} [${edge.kind}]` : '' }).filter(Boolean).join('\n') || '  (nothing in the project)'}`
      const tests = this.testsFor(ids)
      out += `\nTests: ${tests.direct.length ? tests.direct.join(', ') : 'none directly'}${tests.via.length ? `; through callers: ${tests.via.slice(0, 4).join(', ')}` : ''}`
      parts.push(out)
    }
    if (defs.length > 5) parts.push(`… +${defs.length - 5} definitions with this name; pass arquivo/linha to pick one.`)
    return parts.join('\n\n')
  }

  /** Who calls (in) or what is called (out), up to N levels. */
  walk(symbol: string, { file, depth = 1, limit = 30, direction }: { file?: string; depth?: number; limit?: number; direction: 'in' | 'out' }): string {
    const defs = this.find(symbol, { file })
    if (!defs.length) return `Symbol "${symbol}" not found.\n${this.search(symbol, { limit: 5 })}`
    return defs.slice(0, 3).map((def) => {
      const ids = direction === 'in' ? this.withMembers(def) : [def.id]
      const seen = new Set(ids)
      let frontier = ids
      const rows: string[] = []
      for (let level = 1; level <= Math.min(depth, 4) && frontier.length; level++) {
        const next: number[] = []
        for (const id of frontier) for (const edge of direction === 'in' ? this.incoming(id, [...CALLISH, 'references']) : this.outgoing(id, CALLISH)) {
          const other = direction === 'in' ? edge.src : edge.dst
          if (seen.has(other)) continue
          seen.add(other)
          const found = this.sym(other)
          if (!found) continue
          rows.push(`${'  '.repeat(level)}${this.label(found)} — ${direction === 'in' ? `${found.path}:${linesOf(edge)}` : this.where(found)}${kindTag(edge.kind)}${likely(edge.conf)}`)
          next.push(other)
        }
        frontier = next
      }
      return `${def.kind} ${def.qname} — ${this.where(def)}\n${rows.slice(0, limit).join('\n') || '  (none)'}${rows.length > limit ? `\n  … +${rows.length - limit}` : ''}`
    }).join('\n\n')
  }

  impact(symbol: string, { file, depth = 2 }: { file?: string; depth?: number } = {}): string {
    const defs = this.find(symbol, { file })
    const def = defs[0]
    if (!def) return `Symbol "${symbol}" not found.`
    const start = this.withMembers(def)
    const seen = new Map<number, number>(start.map((id) => [id, 0]))
    const callLines = new Map<number, number[]>() // direct caller → lines where it calls
    let frontier = start
    for (let level = 1; level <= Math.min(depth, 5) && frontier.length; level++) {
      const next: number[] = []
      for (const id of frontier) for (const edge of this.incoming(id)) {
        if (level === 1 && edge.kind !== 'references') callLines.set(edge.src, [...(callLines.get(edge.src) ?? []), ...linesOf(edge).split(',').map(Number)])
        if (!seen.has(edge.src)) { seen.set(edge.src, level); next.push(edge.src) }
      }
      frontier = next
    }
    for (const id of start) seen.delete(id)
    const byFile = new Map<string, Array<{ o: SymbolRow; d: number }>>()
    for (const [id, level] of seen) { const found = this.sym(id); if (!found) continue; const list = byFile.get(found.path); if (list) list.push({ o: found, d: level }); else byFile.set(found.path, [{ o: found, d: level }]) }
    const files = [...byFile].sort((a, b) => Math.min(...a[1].map((x) => x.d)) - Math.min(...b[1].map((x) => x.d)) || testFirst(a[0]) - testFirst(b[0]))
    const tests = files.filter(([path]) => isTest(path)).map(([path]) => path)
    const calls = (found: SymbolRow): string => { const lines = ablated('lines') ? undefined : callLines.get(found.id); return lines ? ` — calls at lines ${[...new Set(lines)].sort((a, b) => a - b).join(', ')}` : '' }
    let out = `Impact of changing ${def.kind} ${def.qname} (${this.where(def)}): ${seen.size} symbols in ${byFile.size} files, up to ${depth} levels.${defs.length > 1 ? ` (${defs.length} definitions share this name; used the first — pass arquivo to pick)` : ''}\n`
    out += 'Level 1 (·) uses it directly; the line of each call comes after the dash. Level 2 (··) uses something from level 1.\n'
    for (const [path, list] of files.filter(([path]) => !isTest(path)).slice(0, 25)) out += `\n${path}\n${list.sort((a, b) => a.d - b.d || a.o.line - b.o.line).slice(0, 30).map(({ o, d }) => `  ${'·'.repeat(d)} ${o.kind === 'file' ? '(file level)' : o.qname}:${o.line}${calls(o)}`).join('\n')}${list.length > 30 ? `\n  … +${list.length - 30}` : ''}`
    // tests that call directly change together in a rename
    const direct = files.filter(([path]) => isTest(path)).flatMap(([, list]) => list.filter(({ o }) => callLines.has(o.id)).map(({ o }) => ablated('lines') ? `  ${o.path}` : `  ${o.path}:${[...new Set(callLines.get(o.id))].join(', ')}`))
    if (direct.length) out += `\n\nTests that use it directly (change with it):\n${direct.join('\n')}`
    // name mentioned outside the links: strings (mock.patch, routes, config), comments, imports
    const known = new Set([...callLines].flatMap(([id, lines]) => { const found = this.sym(id); return found ? lines.map((line) => `${found.path}:${line}`) : [] }))
    for (const item of defs) known.add(`${item.path}:${item.line}`)
    const mentions = ablated('mentions') ? [] : this.textMentions(def.name, known)
    if (mentions.length) out += `\n\nOther mentions of the name (text, comment, mock, import — check them in a rename) (${mentions.length}):\n${mentions.slice(0, 40).map((mention) => `  ${mention}`).join('\n')}${mentions.length > 40 ? `\n  … +${mentions.length - 40}` : ''}`
    for (const mention of mentions) { const path = mention.slice(0, mention.indexOf(':')); if (isTest(path) && !tests.includes(path)) tests.push(path) }
    return `${out}\n\nTests to run (${tests.length}): ${tests.join(', ') || 'none found'}`
  }

  /** Lines (file:line) that cite the name as a word, minus the already known ones. */
  private textMentions(name: string, known: Set<string>): string[] {
    if (name.length < 3) return []
    const pattern = new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`)
    const out: string[] = []
    for (const path of this.allPaths()) {
      let text: string
      try { text = readFileSync(join(this.root, path), 'utf8') } catch { continue }
      if (!text.includes(name)) continue
      text.split(/\r?\n/).forEach((line, i) => { if (pattern.test(line) && !known.has(`${path}:${i + 1}`)) out.push(`${path}:${i + 1}  ${line.trim().slice(0, 110)}`) })
    }
    return out
  }

  /** Files the current branch changed since the point where it left a main branch (origin/HEAD, main, master, dev or develop). */
  private committedSinceBase(): string[] {
    const git = (...args: string[]): string => execFileSync('git', ['-C', this.root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    let head = ''
    try { head = git('rev-parse', 'HEAD') } catch { return [] }
    for (const candidate of ['origin/HEAD', 'main', 'master', 'dev', 'develop', 'origin/main', 'origin/master', 'origin/dev', 'origin/develop']) {
      try {
        const base = git('merge-base', 'HEAD', candidate)
        if (!base || base === head) continue
        return git('diff', '--name-only', '--no-renames', `${base}..HEAD`).split(/\r?\n/).filter(Boolean)
      } catch { /* candidata inexistente */ }
    }
    return []
  }

  /** Tests that depend on the changed files (default: what changed in Git since HEAD). */
  affected({ files }: { files?: string[] } = {}): string {
    let changed = files ?? []
    if (!changed.length) {
      // Uncommitted changes (status) and those already committed on the branch since it left the main one: after a commit the status is empty, but the tests still apply.
      try { changed = execFileSync('git', ['-C', this.root, 'status', '--porcelain', '-uall'], { encoding: 'utf8', windowsHide: true }).split('\n').filter(Boolean).map((line) => line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '')) } catch { changed = [] }
      changed = [...new Set([...changed, ...this.committedSinceBase()])]
    }
    if (!changed.length) return 'Nothing changed.'
    changed = changed.map((file) => this.resolvePath(file) ?? file)
    const seen = new Map<string, number>(changed.map((file) => [file, 0]))
    let frontier = [...changed]
    for (let level = 1; level <= 6 && frontier.length; level++) {
      const next: string[] = []
      for (const file of frontier) for (const src of this.st.fileIn.all(this.root, file) as string[]) if (!seen.has(src)) { seen.set(src, level); next.push(src) }
      frontier = next
    }
    const tests = [...seen].filter(([path]) => isTest(path)).sort((a, b) => a[1] - b[1])
    return `Changed files (${changed.length}): ${changed.slice(0, 15).join(', ')}${changed.length > 15 ? ' …' : ''}\nAffected tests (${tests.length}):\n${tests.map(([path, level]) => `  ${path}${level === 0 ? ' (changed)' : level > 1 ? ` (${level} levels away)` : ''}`).join('\n') || '  none'}`
  }

  /** Overview: central files (PageRank on the file graph) and their main symbols, up to `tokens`. */
  map({ tokens = 1500, path: prefix = '' }: { tokens?: number; path?: string } = {}): string {
    const keep = (path: string): boolean => path.startsWith(prefix) && !isGenerated(path) && !isTest(path)
    const edges = (this.db.prepare('select src, dst, weight from file_edges where root = ?').all(this.root) as Array<{ src: string; dst: string; weight: number }>).filter((edge) => keep(edge.src) && keep(edge.dst))
    const nodes = new Set(edges.flatMap((edge) => [edge.src, edge.dst]))
    if (!nodes.size) for (const path of this.allPaths()) if (keep(path)) nodes.add(path)
    const out = new Map<string, typeof edges>()
    for (const edge of edges) { const list = out.get(edge.src); if (list) list.push(edge); else out.set(edge.src, [edge]) }
    let rank = new Map([...nodes].map((node) => [node, 1 / nodes.size]))
    for (let i = 0; i < 30; i++) {
      const next = new Map([...nodes].map((node) => [node, 0.15 / nodes.size]))
      for (const [src, list] of out) {
        const total = list.reduce((sum, edge) => sum + Math.log2(1 + edge.weight), 0)
        for (const edge of list) next.set(edge.dst, (next.get(edge.dst) ?? 0) + 0.85 * (rank.get(src) ?? 0) * (Math.log2(1 + edge.weight) / total))
      }
      rank = next
    }
    let text = ''
    for (const [path] of [...rank].sort((a, b) => b[1] - a[1])) {
      const symbols = this.st.inFile.all(this.root, path) as SymbolRow[]
      const top = symbols.filter((item) => item.parent === 0 && ((item.exported && item.kind !== 'const') || CLASSY.has(item.kind)))
      const rows = top.slice(0, 12).map((item) => {
        const methods = CLASSY.has(item.kind) ? symbols.filter((member) => member.sha === item.sha && member.parent === item.idx && member.kind === 'method' && member.name !== 'constructor').map((member) => member.name) : []
        return `  ${item.line}: ${item.signature.slice(0, 110)}${methods.length ? `\n      ${methods.slice(0, 14).join(', ')}${methods.length > 14 ? ` +${methods.length - 14}` : ''}` : ''}`
      })
      const chunk = `${path}\n${rows.join('\n')}${top.length > 12 ? `\n  … +${top.length - 12}` : ''}\n`
      if ((text.length + chunk.length) / 4 > tokens) break
      text += chunk
    }
    return text || 'No data for the map yet.'
  }

  /** Structure of a file for the editor: symbols with nesting level. */
  outline(file: string): Array<SymbolHit & { depth: number }> {
    const path = this.resolvePath(file)
    if (!path) return []
    const depth = new Map<number, number>()
    return (this.st.inFile.all(this.root, path) as SymbolRow[]).map((item) => {
      const level = item.parent > 0 ? (depth.get(item.parent) ?? 0) + 1 : 0
      depth.set(item.idx, level)
      return { name: item.name, qname: item.qname, kind: item.kind, path: item.path, line: item.line, endLine: item.end_line, signature: item.signature, depth: level }
    })
  }

  /** For the editor: definitions of a name (ties broken by the file being asked from) and where it is used. */
  definitions(name: string, fromFile?: string): SymbolHit[] {
    const list = this.find(name, {})
    const from = fromFile ? this.resolvePath(fromFile) : null
    return list.sort((a, b) => Number(b.path === from) - Number(a.path === from)).slice(0, 20).map((s) => ({ name: s.name, qname: s.qname, kind: s.kind, path: s.path, line: s.line, endLine: s.end_line, signature: s.signature }))
  }
  references(name: string, fromFile?: string): Array<{ path: string; line: number; caller: string }> {
    const defs = this.definitions(name, fromFile)
    const out: Array<{ path: string; line: number; caller: string }> = []
    for (const def of this.find(name, {}).filter((symbol) => defs.some((item) => item.path === symbol.path && item.line === symbol.line)).slice(0, 5)) {
      for (const { s, e } of this.dedupeCallers(this.incoming(def.id))) for (const line of linesOf(e).split(',').map(Number)) out.push({ path: s.path, line, caller: this.label(s) })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  }

  // ---- explorar ---------------------------------------------------------------------------------------------------

  /**
   * Main tool: finds the question's symbols (mentioned names, files, text search with Portuguese terms),
   * raises the score of those that link to each other and returns the call flow, who depends on it and the current code. Summary mode
   * swaps the code for the exact locations; it measured more expensive (the agent read the files afterwards), so it is not the default.
   */
  explore(query: string, { maxFiles = 12, budget = 26000, detail = 'full' }: { maxFiles?: number; budget?: number; detail?: 'full' | 'summary' } = {}): string {
    const wantsTests = /\b(test|teste|spec)/i.test(query)
    const raw = query.split(/[^\p{L}\p{N}_$./-]+/u).filter(Boolean)
    const score = new Map<number, number>()
    const add = (symbol: SymbolRow | null, value: number): void => {
      if (!symbol || symbol.kind === 'file') return
      let weight = value
      if (isGenerated(symbol.path)) weight *= 0.3
      if (isTest(symbol.path) && !wantsTests) weight *= 0.25
      // test cases are listed in their own section; here they would crowd out the code under test
      if (symbol.kind === 'test') weight *= wantsTests ? 0.3 : 0.1
      score.set(symbol.id, (score.get(symbol.id) ?? 0) + weight)
      this.symCache.set(symbol.id, symbol)
    }
    const exact = new Set<number>()
    for (const token of raw) {
      const term = token.replace(/[./-]+$/, '')
      if (term.length < 3 || STOPWORDS.has(term.toLowerCase())) continue
      if (/[./]/.test(term) && /\.\w{1,4}$|\//.test(term)) {
        const path = this.resolvePath(term)
        if (path) for (const item of (this.st.inFile.all(this.root, path) as SymbolRow[]).filter((symbol) => symbol.parent === 0).slice(0, 12)) add(item, item.exported ? 5 : 3)
        continue
      }
      // code identifier (camelCase, snake_case, PascalCase) weighs a lot; a common word weighs little
      const identifier = /[A-Z_]|\d/.test(term.slice(1)) || /^[A-Z]/.test(term) || term.includes('.')
      const hits = identifier ? this.find(term) : this.st.byName.all(this.root, term) as SymbolRow[]
      // an identifier may also name a file (blockLexer → comments/blockLexer.ts, sort_utils → sort_utils.rs, next to `mod sort_utils;`)
      const named = identifier && !ablated('mentions') ? this.resolvePath(term) : null
      const file = named && named.slice(named.lastIndexOf('/') + 1).replace(/\.\w+$/, '') === term ? named : null
      if (file) for (const item of (this.st.inFile.all(this.root, file) as SymbolRow[]).filter((symbol) => symbol.parent === 0 && symbol.kind !== 'test').slice(0, 8)) { add(item, item.exported ? 5 : 3); exact.add(item.id) }
      if (!hits.length) continue
      const each = identifier ? Math.max(4, 16 / Math.sqrt(hits.length)) : 2.5 / Math.sqrt(hits.length)
      for (const item of this.rank(hits).slice(0, 8)) { add(item, each); if (identifier) exact.add(item.id) }
    }
    const textTerms = expandTerms(words(raw.join(' ')).split(' ').filter((word) => word.length > 2 && !STOPWORDS.has(word.toLowerCase())))
    if (textTerms.length) this.fts(textTerms.map((term) => `"${term.replace(/"/g, '')}"*`).join(' OR '), 60).forEach((row, i) => add(this.sym(row.id), (exact.size ? 4 : 7) * (1 - i / 60)))
    if (!score.size) return `Nothing found for "${query}". Try names of functions, classes or files.`

    // links between the candidates raise the score
    const top40 = [...score].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([id]) => id)
    const candidates = new Set(top40)
    for (const id of top40) {
      const links = [...this.incoming(id), ...this.outgoing(id)].filter((edge) => candidates.has(edge.src === id ? edge.dst : edge.src)).length
      if (links) score.set(id, (score.get(id) ?? 0) + Math.min(9, links * 3))
    }
    const ranked = [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id)

    // flow: call paths between the mentioned symbols (with no mention, between the strongest)
    const seed = ranked.filter((id) => this.sym(id)?.kind !== 'test')
    const strong = exact.size >= 2 ? seed.filter((id) => exact.has(id)).slice(0, 10) : seed.slice(0, 8)
    const strongSet = new Set(strong)
    const flows: number[][] = []
    for (const from of strong) {
      const previous = new Map<number, number | null>([[from, null]])
      let frontier = [from]
      for (let level = 0; level < 4 && frontier.length; level++) {
        const next: number[] = []
        for (const id of frontier) for (const edge of this.outgoing(id, CALLISH)) {
          if (previous.has(edge.dst)) continue
          previous.set(edge.dst, id)
          if (strongSet.has(edge.dst) && edge.dst !== from) {
            const path = [edge.dst]
            for (let step = previous.get(edge.dst); step !== null && step !== undefined; step = previous.get(step)) path.unshift(step)
            flows.push(path)
          }
          next.push(edge.dst)
        }
        frontier = next
      }
    }
    const named = (flow: number[]): number => flow.filter((id) => strongSet.has(id)).length
    const kept: number[][] = []
    for (const flow of flows.sort((a, b) => named(b) - named(a) || a.length - b.length)) if (!kept.some((other) => flow.every((id) => other.includes(id)))) kept.push(flow)
    // join chained paths (a→b and b→c become a→b→c)
    for (let changed = true; changed;) {
      changed = false
      outer: for (const a of kept) for (const b of kept) {
        if (a !== b && a.at(-1) === b[0] && !b.slice(1).some((id) => a.includes(id))) { a.push(...b.slice(1)); kept.splice(kept.indexOf(b), 1); changed = true; break outer }
      }
    }
    const inFlow = new Set(kept.flat())
    for (const id of inFlow) if (!score.has(id)) score.set(id, 4)

    // selection by file; cut what ended up far below the best
    const best = score.get(ranked[0]!) ?? 0
    const floor = Math.max(2.5, best * (exact.size ? 0.22 : 0.35))
    const picked: SymbolRow[] = []
    const perFile = new Map<string, number>()
    for (const id of new Set([...kept.flat(), ...ranked])) {
      const item = this.sym(id)
      if (!item || (!inFlow.has(id) && (score.get(id) ?? 0) < floor)) continue
      const count = perFile.get(item.path) ?? 0
      if (count >= 6) continue
      perFile.set(item.path, count + 1)
      picked.push(item)
      if (picked.length >= 30) break
    }
    const pickedIds = new Set(picked.map((item) => item.id))
    const fileScore = (path: string): number => picked.filter((item) => item.path === path).reduce((sum, item) => sum + (score.get(item.id) ?? 0), 0)
    const fileOrder = [...new Set(picked.map((item) => item.path))].sort((a, b) => fileScore(b) - fileScore(a))

    let out = ''
    if (kept.length) out += `**Flow (call path between the symbols found; → calls)**\n\n${this.flowTree(kept.slice(0, 6))}\n`
    out += `**Explore: ${query}**\n\n${picked.length} symbols in ${fileOrder.length} files.\n\n`

    // test cases (describe/it) that call the symbols found: what a question about tests needs first
    if (wantsTests) {
      const cases = this.testCases(picked.filter((item) => !isTest(item.path)).slice(0, 10).flatMap((item) => this.withMembers(item)))
      if (cases.length) {
        // grouped by file and suite (first describe): a suite with 30 cases is one line, with a few examples
        const groups = new Map<string, typeof cases>()
        // suite: the first describe, or the module/class holding the test functions (Rust `mod tests`, a C# test class)
        const suiteOf = (item: SymbolRow): string => item.kind === 'test' ? item.qname.split(' > ')[0]! : item.qname.includes('.') ? item.qname.slice(0, item.qname.lastIndexOf('.')) : item.qname
        for (const item of cases) { const key = `${item.s.path}\0${suiteOf(item.s)}`; groups.set(key, [...(groups.get(key) ?? []), item]) }
        const lines = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10).map(([key, list]) => {
          const [path, suite] = key.split('\0') as [string, string]
          const used = [...new Set(list.flatMap((item) => item.used))].slice(0, 4).join(', ')
          if (list.length === 1) return `- ${path}:${list[0]!.s.line} — ${list[0]!.s.qname} (uses ${used})`
          const sample = list.slice(0, 3).map((item) => `"${(item.s.kind === 'test' && item.s.qname.split(' > ').slice(1).join(' > ')) || item.s.name}" :${item.s.line}`).join('; ')
          return `- ${path} — ${suite}: ${list.length} cases using ${used} (lines ${Math.min(...list.map((item) => item.s.line))}-${Math.max(...list.map((item) => item.s.line))}); e.g. ${sample}`
        })
        out += `**Test cases that exercise these**\n\n${lines.join('\n')}${groups.size > 10 ? `\n- … +${groups.size - 10} suites` : ''}\n\n`
      }
    }

    // who depends on it (check before editing)
    const callable = ['function', 'method', 'class', 'interface', 'struct', 'trait']
    const blast = [...picked.filter((item) => callable.includes(item.kind) && exact.has(item.id)), ...picked.filter((item) => ['function', 'method', 'class'].includes(item.kind) && !exact.has(item.id))].slice(0, 6)
    if (blast.length) {
      out += '**What depends on these (check before editing)**\n\n'
      for (const item of blast) {
        const ids = this.withMembers(item)
        const callers = this.dedupeCallers(ids.flatMap((id) => this.incoming(id)))
        const files = [...new Set(callers.map((caller) => caller.s.path))].filter((path) => !isTest(path))
        const tests = this.testsFor(ids)
        const testText = tests.direct.length ? tests.direct.slice(0, 3).map((path) => `\`${path}\``).join(', ') : tests.via.length ? `through callers ${tests.via.slice(0, 2).map((path) => `\`${path}\``).join(', ')}` : 'none found'
        out += `- \`${item.qname}\` (${this.where(item)}) — ${callers.length} uses${files.length ? ` in ${files.slice(0, 3).map((path) => `\`${path}\``).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}` : ''}; tests: ${testText}\n`
      }
      out += '\n'
    }

    // relations among what was chosen
    const relations: Record<string, string[]> = {}
    for (const item of picked) for (const edge of this.outgoing(item.id)) {
      const target = this.sym(edge.dst)
      if (!target || (!pickedIds.has(target.id) && edge.kind === 'references')) continue
      // one- or two-line helpers outside the selection (take, peek, done) only add noise
      if (!pickedIds.has(target.id) && target.end_line - target.line < 2 && !CLASSY.has(target.kind)) continue
      ;(relations[edge.kind] ??= []).push(`${item.name} → ${target.name}${pickedIds.has(target.id) ? '' : ` (${this.where(target)})`}`)
    }
    if (Object.keys(relations).length) out += `**Relations**\n\n${Object.entries(relations).map(([kind, list]) => { const unique = [...new Set(list)]; return `${kind}: ${unique.slice(0, 12).join(' · ')}${unique.length > 12 ? ` · … +${unique.length - 12}` : ''}` }).join('\n')}\n\n`

    if (detail === 'summary') return out + this.exploreOutline(picked, fileOrder, score, wantsTests, inFlow)

    // current code from disk, grouped by file
    out += '**Code** (current content on disk, with line numbers — treat it as already read; no need to open these excerpts again)\n\n'
    let used = out.length, shown = 0, testFiles = 0
    const skipped: string[] = []
    for (const path of fileOrder) {
      if (shown >= maxFiles || used > budget || (isTest(path) && !wantsTests && ++testFiles > 1)) { skipped.push(path); continue }
      const lines = this.lines(path)
      const symbols = picked.filter((item) => item.path === path).sort((a, b) => a.line - b.line)
      const ranges: Array<[number, number]> = []
      for (const item of symbols) {
        let a = item.line, b = item.end_line
        while (a > 1 && /^\s*(\/\/|\/\*|\*|#|@|\[)/.test(lines[a - 2] ?? '') && item.line - a < 10) a--
        const hasPickedMembers = symbols.some((member) => member.sha === item.sha && member.parent === item.idx)
        if (CLASSY.has(item.kind) && (hasPickedMembers || b - a > 60)) b = Math.min(b, item.line + 4)
        else if (b - a > 90) b = a + 70
        ranges.push([a, b])
      }
      ranges.sort((x, y) => x[0] - y[0])
      const merged: Array<[number, number]> = []
      for (const range of ranges) { const lastRange = merged.at(-1); if (lastRange && range[0] <= lastRange[1] + 3) lastRange[1] = Math.max(lastRange[1], range[1]); else merged.push([...range]) }
      let block = `**\`${path}\`** — ${symbols.map((item) => item.name).join(', ')}\n\n\`\`\`${path.slice(path.lastIndexOf('.') + 1)}\n`
      merged.forEach(([a, b], i) => {
        if (i > 0) block += '\n… (excerpt omitted) …\n\n'
        for (let k = a; k <= b; k++) block += `${k}\t${lines[k - 1] ?? ''}\n`
      })
      block += '```\n\n'
      if (used + block.length > budget * 1.15 && shown > 0) { skipped.push(path); continue }
      out += block
      used += block.length
      shown++
    }
    if (skipped.length) out += `Also relevant (no code here, use gearmod_code_node): ${skipped.slice(0, 10).join(', ')}\n`
    return out
  }

  private exploreOutline(picked: SymbolRow[], fileOrder: string[], score: Map<number, number>, wantsTests: boolean, inFlow: Set<number>): string {
    let out = '**Where things are** (exact lines; open only what you need with Read offset/limit or gearmod_code_node codigo=true)\n\n'
    for (const path of fileOrder.slice(0, 15)) {
      if (isTest(path) && !wantsTests) continue
      out += `\`${path}\`\n${picked.filter((item) => item.path === path).sort((a, b) => a.line - b.line).map((item) => `  ${item.line}-${item.end_line} ${item.kind} ${item.qname}${item.kind === 'const' ? '' : ` — ${item.signature.slice(0, 120)}`}${item.doc ? `\n      ${item.doc.slice(0, 110)}` : ''}`).join('\n')}\n`
    }
    // whole snippets: those of the flow and the highest scored, short ones and not whole classes;
    // inner helpers (a function inside a function) come after the top-level ones
    const nested = (item: SymbolRow): boolean => item.kind === 'function' && item.qname.includes('.')
    const snippets = picked.filter((item) => !CLASSY.has(item.kind) && item.end_line - item.line < 45 && (!isTest(item.path) || wantsTests))
      .sort((a, b) => Number(inFlow.has(b.id)) - Number(inFlow.has(a.id)) || Number(nested(a)) - Number(nested(b)) || (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0)).slice(0, 4)
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    let used = 0
    const blocks: string[] = []
    for (const item of snippets) {
      const lines = this.lines(item.path)
      let block = `\`${item.path}\` ${item.qname}\n\`\`\`${item.path.slice(item.path.lastIndexOf('.') + 1)}\n`
      for (let k = item.line; k <= item.end_line; k++) block += `${k}\t${lines[k - 1] ?? ''}\n`
      block += '```\n'
      if (used + block.length > 8000) break
      used += block.length
      blocks.push(block)
    }
    return blocks.length ? `${out}\n**Main excerpts** (current content on disk)\n\n${blocks.join('\n')}` : out
  }
}
