import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Node, Language as TsLanguage, Parser as TsParser, Query as TsQuery } from '@vscode/tree-sitter-wasm'
import { LANGUAGES, kids, queriesOf, type ImportRecord, type LanguageConfig } from './languages'

/** Bump when the extraction changes: the analysis stored in the database is discarded and redone. */
export const EXTRACTOR_VERSION = 14

export interface ExtractedSymbol { name: string; qname: string; kind: string; parent: number; line: number; end: number; signature: string; doc: string | null; exported: boolean; owner: string | null }
export interface ExtractedRef { src: number; name: string; receiver: string | null; kind: 'call' | 'new' | 'render' | 'type' | 'ref'; line: number }
export interface ExtractedBind { scope: number; name: string; type: string; kind: 'var' | 'field' | 'call' | 'expr' | 'destrcall' }
export interface ExtractedHeritage { owner: number; ownerName: string | null; kind: 'extends' | 'implements'; target: string }
export interface Extraction { lines: number; symbols: ExtractedSymbol[]; imports: Array<ImportRecord & { line: number }>; refs: ExtractedRef[]; binds: ExtractedBind[]; heritage: ExtractedHeritage[]; defaultExport: string | null }

type TreeSitter = { Parser: typeof TsParser; Language: typeof TsLanguage; Query: typeof TsQuery }
interface Compiled { parser: TsParser; query: TsQuery; config: LanguageConfig }

const KIND_PRIORITY = ['function', 'method', 'class', 'interface', 'struct', 'trait', 'enum', 'module', 'type', 'property', 'const', 'test']
const BIND_PRIORITY = ['var', 'field', 'call', 'expr', 'destrcall']
const CLASSY = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'module'])
const SCOPE_KINDS = new Set(['test', 'function', 'method', 'class', 'interface', 'struct', 'trait', 'enum', 'module'])
const HOLDERS = new Set(['variable_declarator', 'lexical_declaration', 'variable_declaration', 'export_statement', 'decorated_definition'])
const JS_EXTRA = '\n(export_statement !source (export_clause (export_specifier name: (identifier) @export.local)))\n'

let ts: TreeSitter | undefined
let wasmDir: string | undefined
let initPromise: Promise<void> | undefined
const compiled = new Map<string, Promise<Compiled>>()
/** Patterns the grammar rejected (to debug the queries). */
export const rejectedPatterns: Record<string, string[]> = {}

/** Folder of the .wasm files; the default is the @vscode/tree-sitter-wasm package resolved from this module. */
export function setWasmDir(dir: string): void { wasmDir = dir }

function treeSitter(): TreeSitter {
  if (!ts) {
    const require = createRequire(import.meta.url)
    ts = require('@vscode/tree-sitter-wasm') as TreeSitter
    wasmDir ??= dirname(require.resolve('@vscode/tree-sitter-wasm'))
  }
  return ts
}

function language(lang: string): Promise<Compiled> {
  const existing = compiled.get(lang)
  if (existing) return existing
  const created = (async (): Promise<Compiled> => {
    const lib = treeSitter()
    const config = LANGUAGES[lang]
    if (!config) throw new Error(`Unsupported language: ${lang}`)
    initPromise ??= lib.Parser.init({ locateFile: (file: string) => join(wasmDir!, file) })
    await initPromise
    const grammar = await lib.Language.load(readFileSync(join(wasmDir!, `tree-sitter-${config.wasm}.wasm`)))
    const parser = new lib.Parser()
    parser.setLanguage(grammar)
    const patterns = (queriesOf(lang) + (config.family === 'js' ? JS_EXTRA : '')).split('\n').map((line) => line.trim()).filter(Boolean)
    const accepted: string[] = []
    // each pattern on its own: a node that does not exist in the grammar brings down only it, not the whole query
    for (const pattern of patterns) {
      try { new lib.Query(grammar, pattern).delete(); accepted.push(pattern) } catch { (rejectedPatterns[lang] ??= []).push(pattern) }
    }
    return { parser, query: new lib.Query(grammar, accepted.join('\n')), config }
  })()
  compiled.set(lang, created)
  return created
}

function findBody(node: Node, depth = 0): Node | null {
  const body = node.childForFieldName('body')
  if (body) return body
  if (depth >= 3) return null
  for (const child of kids(node)) {
    if (child.type === 'comment') continue
    const found = findBody(child, depth + 1)
    if (found) return found
  }
  return null
}

const squash = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max)

function docOf(holder: Node, def: Node, lang: string): string | null {
  // Python docstring or comments right above (//, /** */, #, ///)
  if (lang === 'python') {
    const first = kids(def.childForFieldName('body'))[0]
    if (first?.type === 'expression_statement' && kids(first)[0]?.type === 'string') return squash(first.text.replace(/^[rubf]*("""|'''|"|')|("""|'''|"|')$/g, ''), 240)
  }
  const comments: string[] = []
  let node = holder.previousNamedSibling
  let expectRow = holder.startPosition.row - 1
  while (node && node.type === 'comment' && node.endPosition.row === expectRow) {
    comments.unshift(node.text)
    expectRow = node.startPosition.row - 1
    node = node.previousNamedSibling
  }
  if (!comments.length) return null
  const clean = comments.map((text) => text.replace(/\*\/\s*$/, '').replace(/^\s*(\/\*\*?|\/\/\/?|#|\*)\s?/gm, '')).join(' ')
  return squash(clean.replace(/<\/?(summary|remarks|returns|para|c|code|example|value)>/gi, ' ').replace(/<(see|seealso|paramref|typeparamref)\s+\w+="([^"]*)"\s*\/>/gi, '$2').replace(/<param name="(\w+)">/gi, '$1: ').replace(/<\/param>/gi, ';').replace(/<[^>]+>/g, ' '), 240) || null
}

function cleanReceiver(node: Node | undefined): string | null {
  if (!node) return null
  // new X(...).run() / (await new X()).run(): the receiver is an instance of X
  let inner: Node | null = node
  while (inner && (inner.type === 'parenthesized_expression' || inner.type === 'await_expression')) inner = kids(inner)[0] ?? null
  if (inner && (inner.type === 'new_expression' || inner.type === 'object_creation_expression')) {
    const ctor = (inner.childForFieldName('constructor') ?? inner.childForFieldName('type'))?.text.replace(/<[\s\S]*$/, '').replace(/\s+/g, '')
    if (ctor && /^[A-Za-z_$][\w$]*$/.test(ctor)) return `new ${ctor}`
  }
  const text = node.text.replace(/\s+/g, '').replace(/\?\./g, '.').replace(/!\./g, '.').replace(/->/g, '.').replace(/::/g, '.')
  if (text.length > 80 || /[()[\]{}"'`]/.test(text)) return text.includes('(') ? '(expr)' : null
  return text
}

interface Def { node: Node; nameNode: Node; kind: string; owner: string | null; eb: number }
interface Sym extends ExtractedSymbol { sb: number; eb: number }
interface Positioned { pos: number }

export async function extract(lang: string, src: string): Promise<Extraction> {
  const { parser, query, config } = await language(lang)
  const tree = parser.parse(src)
  if (!tree) throw new Error('parse failed')
  try {
    const defsByNode = new Map<string, Def>()
    const containers: Array<{ node: Node; owner: string | null }> = []
    const imports: Node[] = []
    const refs: Array<Positioned & { name: string; receiver: string | null; kind: ExtractedRef['kind']; line: number }> = []
    const binds: Array<Positioned & { name: string; type: string; kind: ExtractedBind['kind'] }> = []
    const heritage: Array<Positioned & { kind: ExtractedHeritage['kind']; target: string; ownerName: string | null }> = []
    const exportNames: string[] = []
    let defaultExport: string | null = null
    const defNameStarts = new Set<number>()

    for (const match of query.matches(tree.rootNode)) {
      const caps: Record<string, Node> = {}
      for (const capture of match.captures) caps[capture.name] ??= capture.node
      const defKey = Object.keys(caps).find((key) => key.startsWith('def.'))
      const name = caps.name
      if (defKey && name) {
        const node = caps[defKey]!
        const kind = defKey.slice(4)
        const key = `${node.startIndex}:${node.endIndex}`
        const previous = defsByNode.get(key)
        if (!previous || KIND_PRIORITY.indexOf(kind) < KIND_PRIORITY.indexOf(previous.kind)) defsByNode.set(key, { node, nameNode: name, kind, owner: caps.owner?.text ?? null, eb: node.endIndex })
        defNameStarts.add(name.startIndex)
        continue
      }
      if (caps.container) { containers.push({ node: caps.container, owner: caps.owner?.text ?? null }); continue }
      if (caps.import) { imports.push(caps.import); continue }
      const site = caps.call ?? caps.new ?? caps.jsx
      if (site) {
        const callee = caps.callee
        // Rust macro arguments are raw tokens: keep `f(…)` only, not `x.f(…)`, `T::f(…)` or `vec![…]`
        if (callee && site.startIndex === callee.startIndex && callee.parent?.type === 'token_tree') {
          const before = src.slice(Math.max(0, callee.startIndex - 2), callee.startIndex).trimEnd()
          if (before.endsWith('.') || before.endsWith(':') || src[callee.endIndex] !== '(') continue
        }
        if (callee) refs.push({ pos: callee.startIndex, name: callee.text, receiver: cleanReceiver(caps.receiver), kind: caps.call ? 'call' : caps.new ? 'new' : 'render', line: site.startPosition.row + 1 })
        continue
      }
      const base = caps.extends ?? caps.implements
      if (base) { heritage.push({ pos: base.startIndex, kind: caps.extends ? 'extends' : 'implements', target: base.text.replace(/<.*$/s, '').split(/[.:\\]+/).at(-1) ?? base.text, ownerName: caps.owner?.text ?? null }); continue }
      const bind = (nameNode: Node | undefined, type: string | null | undefined, kind: ExtractedBind['kind']): boolean => {
        if (!nameNode) return false
        if (type && type !== '(expr)') binds.push({ pos: nameNode.startIndex, name: nameNode.text, type, kind })
        return true
      }
      if (bind(caps['bind.name'], caps['bind.type']?.text, 'var')) continue
      if (bind(caps['field.name'], caps['field.type']?.text, 'field')) continue
      if (bind(caps['bindcall.name'], caps['bindcall.callee']?.text.replace(/\s+/g, ''), 'call')) continue
      if (bind(caps['bindexpr.name'], cleanReceiver(caps['bindexpr.value']), 'expr')) continue
      const destructured = caps['binddestr.name']
      if (destructured) { const value = cleanReceiver(caps['binddestr.value']); bind(destructured, value && value !== '(expr)' ? `${value}.${destructured.text}` : null, 'expr'); continue }
      if (bind(caps['bdc.name'], caps['bdc.callee']?.text.replace(/\s+/g, ''), 'destrcall')) continue
      if (caps['export.default']) { defaultExport ??= caps['export.default'].text; exportNames.push(caps['export.default'].text); continue }
      if (caps['export.local']) { exportNames.push(caps['export.local'].text); continue }
      const typeRef = caps.type, valueRef = caps.ref
      if (typeRef) refs.push({ pos: typeRef.startIndex, name: typeRef.text, receiver: null, kind: 'type', line: typeRef.startPosition.row + 1 })
      else if (valueRef) refs.push({ pos: valueRef.startIndex, name: valueRef.text, receiver: null, kind: 'ref', line: valueRef.startPosition.row + 1 })
    }

    // ---- symbols in position order; index 0 is the file itself
    const lines = src.split('\n').length
    const symbols: Sym[] = [{ name: '', qname: '', kind: 'file', parent: -1, line: 1, end: lines, sb: 0, eb: src.length, signature: '', doc: null, exported: true, owner: null }]
    // `namespace X;` (C#) lasts until the end of the file
    for (const def of defsByNode.values()) if (def.node.type === 'file_scoped_namespace_declaration') def.eb = src.length
    const defs = [...defsByNode.values()].sort((a, b) => a.node.startIndex - b.node.startIndex || b.eb - a.eb)
    const stack: Array<{ eb: number; idx: number }> = []
    const containerOf = (pos: number): { owner: string | null } | null => {
      let best: { node: Node; owner: string | null } | null = null
      for (const item of containers) if (item.node.startIndex <= pos && pos < item.node.endIndex && (!best || item.node.startIndex >= best.node.startIndex)) best = item
      return best
    }
    for (const def of defs) {
      const sb = def.node.startIndex
      while (stack.length && stack.at(-1)!.eb <= sb) stack.pop()
      const parentIdx = stack.at(-1)?.idx ?? 0
      const parent = symbols[parentIdx]!
      let kind = def.kind
      // consts and properties only at the top of the file / of the class
      if (kind === 'const' && parent.kind !== 'file' && parent.kind !== 'module') continue
      if (kind === 'property' && !CLASSY.has(parent.kind)) continue
      if (kind === 'function' && CLASSY.has(parent.kind) && parent.kind !== 'module') kind = 'method'
      let owner = def.owner
      if (!owner && parent.kind === 'file') { const container = containerOf(sb); if (container) { owner = container.owner; if (kind === 'function') kind = 'method' } }
      // describe/it/test('name', …): the name is the string, nested cases read "suite > case"
      const name = kind === 'test' ? def.nameNode.text.replace(/^['"`]|['"`]$/g, '').replace(/\s+/g, ' ').slice(0, 160) : def.nameNode.text
      const qname = owner ? `${owner}.${name}` : parent.kind === 'file' ? name : kind === 'test' && parent.kind === 'test' ? `${parent.qname} > ${name}` : `${parent.qname}.${name}`
      // the documentation comment sits before the whole declaration (export const x = …), not the declarator
      let holder = def.node
      while (holder.parent && HOLDERS.has(holder.parent.type)) {
        const declarators = kids(holder.parent).filter((child) => child.type === 'variable_declarator')
        if (holder.type === 'variable_declarator' && declarators.length > 1 && declarators[0]!.startIndex !== holder.startIndex) break
        holder = holder.parent
      }
      const body = findBody(def.node)
      const sigEnd = body && body.startIndex > sb ? body.startIndex : Math.min(def.node.endIndex, sb + 240)
      let exported: boolean
      if (config.family === 'js') { let top = def.node; while (top.parent && HOLDERS.has(top.parent.type)) top = top.parent; exported = top.type === 'export_statement' }
      else if (config.exported) exported = config.exported(name)
      else if (config.family === 'rust') exported = kids(def.node).some((child) => child.type === 'visibility_modifier')
      else exported = !/\bprivate\b/.test(src.slice(sb, sigEnd))
      const idx = symbols.length
      symbols.push({ name, qname, kind, parent: parentIdx, line: def.node.startPosition.row + 1, end: def.eb === src.length ? lines : def.node.endPosition.row + 1, sb, eb: def.eb, signature: kind === 'test' ? squash(src.slice(sb, def.nameNode.endIndex) + ')', 240) : squash(src.slice(sb, sigEnd), 240), doc: docOf(holder, def.node, lang), exported, owner })
      if (SCOPE_KINDS.has(kind) || kind === 'const') stack.push({ eb: def.eb, idx })
    }
    for (const name of exportNames) for (const symbol of symbols) if (symbol.name === name && symbol.parent === 0) symbol.exported = true

    // ---- symbol that wraps each position (stack sweep)
    const scopes = symbols.map((symbol, idx) => ({ sb: symbol.sb, eb: symbol.eb, idx })).filter((symbol) => symbol.idx > 0).sort((a, b) => a.sb - b.sb || b.eb - a.eb)
    const enclosing = (items: Positioned[]): number[] => {
      const order = items.map((item, i) => [item.pos, i] as const).sort((a, b) => a[0] - b[0])
      const out = new Array<number>(items.length).fill(0)
      const open: typeof scopes = []
      let next = 0
      for (const [pos, i] of order) {
        while (next < scopes.length && scopes[next]!.sb <= pos) {
          while (open.length && open.at(-1)!.eb <= scopes[next]!.sb) open.pop()
          open.push(scopes[next]!)
          next++
        }
        while (open.length && open.at(-1)!.eb <= pos) open.pop()
        out[i] = open.at(-1)?.idx ?? 0
      }
      return out
    }
    const classOf = (idx: number): number => { for (let i = idx; i > 0; i = symbols[i]!.parent) if (CLASSY.has(symbols[i]!.kind)) return i; return 0 }

    const seen = new Set<string>()
    const refsKept = refs.filter((ref) => {
      if (ref.kind === 'type' && defNameStarts.has(ref.pos)) return false
      const key = `${ref.pos}${ref.kind}`
      if (seen.has(key)) return false
      seen.add(key)
      // type reference at the same point as a call/instantiation
      return !(ref.kind === 'type' && (seen.has(`${ref.pos}new`) || seen.has(`${ref.pos}call`)))
    })
    const refScopes = enclosing(refsKept)
    // the variable belongs to the scope where it is declared, not to the const it itself defines
    const bindScopes = enclosing(binds).map((idx) => (symbols[idx]?.kind === 'const' ? symbols[idx]!.parent : idx))
    const bindSeen = new Set<string>()
    const bindsKept = binds.map((item, i) => ({ scope: item.kind === 'field' ? classOf(bindScopes[i]!) || bindScopes[i]! : bindScopes[i]!, name: item.name, type: item.type.replace(/\s+/g, ' ').slice(0, 2000), kind: item.kind }))
      .sort((a, b) => BIND_PRIORITY.indexOf(a.kind) - BIND_PRIORITY.indexOf(b.kind))
      .filter((item) => { const key = `${item.scope}\0${item.name}`; if (bindSeen.has(key)) return false; bindSeen.add(key); return true })
    const heritageScopes = enclosing(heritage)
    const heritageKept = heritage.map((item, i) => ({ owner: item.ownerName ? -1 : classOf(heritageScopes[i]!), ownerName: item.ownerName, kind: item.kind, target: item.target })).filter((item) => item.owner !== 0 || item.ownerName)

    const importsKept: Extraction['imports'] = []
    for (const node of imports) {
      try { for (const item of config.imports(node)) if (item.spec) importsKept.push({ ...item, line: node.startPosition.row + 1 }) } catch { /* import malformado */ }
    }

    return {
      lines,
      symbols: symbols.map((symbol) => ({ name: symbol.name, qname: symbol.qname, kind: symbol.kind, parent: symbol.parent, line: symbol.line, end: symbol.end, signature: symbol.signature, doc: symbol.doc, exported: symbol.exported, owner: symbol.owner })),
      imports: importsKept,
      refs: refsKept.map((ref, i) => ({ src: refScopes[i]!, name: ref.name, receiver: ref.receiver, kind: ref.kind, line: ref.line })),
      binds: bindsKept,
      heritage: heritageKept,
      defaultExport
    }
  } finally {
    tree.delete()
  }
}
