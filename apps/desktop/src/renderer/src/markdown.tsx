import React, { useEffect, useRef, useState } from 'react'
import { terminal, useTerminal } from './terminalStore'
import { resolveRelative } from './editor/markdownPaths'
import { highlightCode, type Piece } from './editor/highlightCode'
import { toast } from './toasts'
import { plainError } from './NoticeDialog'
import { useT } from './i18n'
import { CheckMiniIcon, CopyIcon, PlayIcon } from './icons'

/** Minimal, safe Markdown renderer (no raw HTML). Returns only the blocks: the caller puts them inside a `.md`. Checklists in the prototype format (`ul.tasks > li.tk`). */
interface Item { indent: number; ordered: boolean; checked: boolean | null; text: string; line: number; children: Item[] }

const inlinePattern = /(!\[[^\]]*\]\([^)]*\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)]*\))/g

/** Whoever is above (the chat) receives the click on a cited file and opens the viewer; without it, the citation stays as text. */
export const FileOpenContext = React.createContext<((path: string) => void) | null>(null)
const codeExtensions = /\.(md|mdx|txt|json|jsonc|ya?ml|toml|ini|env|csv|html?|css|scss|less|svg|[cm]?[jt]sx?|vue|svelte|py|rb|go|rs|java|kt|cs|php|sh|bat|ps1|sql|xml|lock|log|c|h|cpp|hpp)$/i
const withoutLine = (target: string): string => target.replace(/[?#].*$/, '').replace(/:\d+(:\d+)?$/, '')
/** Markdown link points to a local file (not a URL, anchor or email). */
const shellLangs = /^(bash|sh|shell|zsh|powershell|pwsh|ps1|ps|cmd|bat|console|terminal)$/i

/** Chat code block; shell ones (or with no language) get ▶ to run in the app terminal, and all get copy. */
function CodeBlock({ code, lang, runnable: allowRun = true }: { code: string; lang: string; runnable?: boolean }): React.JSX.Element {
  const t = useT(), { context } = useTerminal(), [copied, setCopied] = useState(false), [pieces, setPieces] = useState<Piece[]>([]), [seen, setSeen] = useState(false), box = useRef<HTMLDivElement>(null)
  // Only colors what gets near the screen: a long conversation has dozens of blocks and scrolling must not stall.
  useEffect(() => { const element = box.current; if (!element || seen) return; if (typeof IntersectionObserver === 'undefined') { setSeen(true); return } const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setSeen(true); observer.disconnect() } }, { rootMargin: '300px' }); observer.observe(element); return () => observer.disconnect() }, [seen])
  useEffect(() => { if (!seen) return; let alive = true; void highlightCode(code, lang).then((result) => { if (alive) setPieces(result) }).catch(() => undefined); return () => { alive = false } }, [seen, code, lang])
  const runnable = allowRun && Boolean(context) && (!lang || shellLangs.test(lang)) && code.trim().length > 0 && code.length < 4000
  const command = code.split('\n').map((line) => line.replace(/^\s*(\$|PS [^>]*>|>)\s+/, '')).join('\n')
  const copy = (): void => { void navigator.clipboard.writeText(code).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400) }).catch((reason: unknown) => toast.error(t.shell.markdown.couldNotCopy, plainError(reason))) }
  return <div className="codeblock" ref={box}><pre><code>{pieces.length ? pieces.map((piece, index) => piece.cls ? <span key={index} className={piece.cls}>{piece.text}</span> : piece.text) : code}</code></pre>
    <div className="cb-tools">
      {runnable && <button type="button" className="cb-btn tip" data-tip={t.shell.markdown.runInTerminal} aria-label={t.shell.markdown.runInTerminal} onClick={() => void terminal.run(command)}><PlayIcon /></button>}
      <button type="button" className="cb-btn tip" data-tip={copied ? t.shell.markdown.copied : t.shell.markdown.copy} aria-label={t.shell.markdown.copy} onClick={copy}><CopyIcon /></button>
    </div></div>
}

/** Which file the Markdown came from: with this, relative-path images are loaded from the project (`workspace:image`). */
export interface MarkdownBaseInfo { projectId: string; cardId: string | null; path: string }
const MarkdownBase = React.createContext<MarkdownBaseInfo | null>(null)
const MarkdownFiles = React.createContext<{ paths: Map<string, { path: string; directory: boolean }>; open(target: string): void } | null>(null)
const imageCache = new Map<string, Promise<string>>()

function MdImage({ alt, src }: { alt: string; src: string }): React.JSX.Element {
  const base = React.useContext(MarkdownBase), [url, setUrl] = useState(/^https:\/\//i.test(src) ? src : ''), [failed, setFailed] = useState(false)
  useEffect(() => {
    if (/^https:\/\//i.test(src)) { setUrl(src); return }
    if (!base || /^[a-z][a-z0-9+.-]*:/i.test(src.replace(/^[A-Za-z]:[\\/]/, ''))) { setUrl(''); return }
    const path = resolveRelative(base.path, src), key = `${base.projectId}|${base.cardId}|${path}`
    let alive = true
    const request = imageCache.get(key) ?? window.gearmod.invoke('workspace:image', { projectId: base.projectId, cardId: base.cardId, path })
    imageCache.set(key, request)
    void request.then((data) => { if (alive) setUrl(data) }).catch(() => { imageCache.delete(key); if (alive) setFailed(true) })
    return () => { alive = false }
  }, [src, base?.path, base?.projectId, base?.cardId])
  if (url && !failed) return <img className="mdimg" src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} />
  return <span className="mdLink" data-tip={src}>{alt || src}</span>
}

function isFileLink(target: string): boolean {
  if (/\s/.test(target) || target.startsWith('#')) return false
  if (/^file:/i.test(target)) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return false
  return /\.[A-Za-z0-9]{1,8}$|[\\/]/.test(withoutLine(target))
}
/** Code snippet that looks like a known file path (e.g. `src/App.tsx`, `README.md:12`). */
const isFileCode = (text: string): boolean => /^[\w@.~/\\:-]+$/.test(text) && codeExtensions.test(withoutLine(text))

function FileRef({ target, children, code }: { target: string; children: React.ReactNode; code?: boolean }): React.JSX.Element {
  const t = useT(), open = React.useContext(FileOpenContext), files = React.useContext(MarkdownFiles), resolved = files?.paths.get(target)
  if (resolved && files) return <button type="button" className={`mdFile ${code ? 'code' : ''}`} data-tip={resolved.directory ? t.shell.markdown.showFolder(resolved.path) : t.shell.markdown.openFile(resolved.path)} onClick={(event) => { event.stopPropagation(); files.open(target) }} onDoubleClick={(event) => event.stopPropagation()}>{children}</button>
  const ok = !files && open && (code ? isFileCode(target) : isFileLink(target))
  if (!ok && !code && /^(https?:\/\/|mailto:)/i.test(target)) return <a className="mdLink ext" href={target} data-tip={target} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void window.gearmod.invoke('app:open-link', { url: target }).catch((reason: unknown) => toast.error(t.shell.markdown.couldNotOpenLink, plainError(reason))) }}>{children}</a>
  if (!ok) return code ? <code>{children}</code> : <span className="mdLink" data-tip={target}>{children}</span>
  return <button type="button" className={`mdFile ${code ? 'code' : ''}`} data-tip={t.shell.markdown.open(target)} onClick={() => open(target.replace(/^file:\/\/\/?/i, '').replace(/^\/([A-Za-z]:)/, '$1'))}>{children}</button>
}

function inline(text: string, key: string): React.ReactNode[] {
  return text.split(inlinePattern).filter((part) => part !== '').map((part, index) => {
    const k = `${key}-${index}`
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <FileRef key={k} target={part.slice(1, -1)} code>{part.slice(1, -1)}</FileRef>
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) return <strong key={k}>{inline(part.slice(2, -2), k)}</strong>
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) return part.length > 2 ? <em key={k}>{inline(part.slice(1, -1), k)}</em> : part
    const image = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(part)
    if (image) return <MdImage key={k} alt={image[1]!} src={image[2]!.trim().replace(/\s+"[^"]*"$/, '')} />
    const link = /^\[([^\]]+)\]\(([^)]*)\)$/.exec(part)
    if (link) return <FileRef key={k} target={link[2]!}>{inline(link[1]!, k)}</FileRef>
    return part
  })
}

/** A single Markdown line with no blocks (code, bold, italic, links), for short titles like a task's. */
export function InlineMarkdown({ text }: { text: string }): React.JSX.Element { return <>{inline(text, 'il')}</> }

const listLine =/^(\s*)([-*+]|\d+\.)\s+(?:\[( |x|X)\]\s+)?(.*)$/
const isSpecial = (line: string): boolean => /^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+\.)\s|---+\s*$)/.test(line) || /^\|.*\|\s*$/.test(line)

function renderItems(items: Item[], onToggle: ((line: number, checked: boolean) => void) | undefined, key: string): React.JSX.Element {
  if (items.some((item) => item.checked !== null)) {
    const flat: Array<{ item: Item; depth: number }> = []
    const walk = (list: Item[], depth: number): void => list.forEach((item) => { flat.push({ item, depth }); walk(item.children, depth + 1) })
    walk(items, 0)
    return <ul key={key} className="tasks">{flat.map(({ item, depth }) => <li key={`${key}-${item.line}`} className={`tk ${depth ? 'sub' : ''} ${item.checked ? 'done' : ''}`} data-ln={onToggle ? item.line : undefined} onClick={onToggle ? () => onToggle(item.line, !item.checked) : undefined}><span className={`tkb ${item.checked ? 'on' : ''}`}>{item.checked && <CheckMiniIcon />}</span><span className="tkt">{inline(item.text, `${key}-${item.line}`)}</span></li>)}</ul>
  }
  const Tag = items[0]?.ordered ? 'ol' : 'ul'
  return <Tag key={key}>{items.map((item) => <li key={`${key}-${item.line}`}>{inline(item.text, `${key}-${item.line}`)}{item.children.length > 0 && renderItems(item.children, onToggle, `${key}-${item.line}c`)}</li>)}</Tag>
}

function buildTree(lines: Array<{ match: RegExpExecArray; line: number }>): Item[] {
  const root: Item[] = [], stack: Item[] = []
  for (const { match, line } of lines) {
    const item: Item = { indent: match[1]!.replace(/\t/g, '  ').length, ordered: /\d/.test(match[2]!), checked: match[3] === undefined ? null : match[3] !== ' ', text: match[4]!, line, children: [] }
    while (stack.length && stack[stack.length - 1]!.indent >= item.indent) stack.pop()
    ;(stack.length ? stack[stack.length - 1]!.children : root).push(item)
    stack.push(item)
  }
  return root
}

export function Markdown({ source, onToggle, base, runnable = true, onOpenReference }: { source: string; onToggle?(line: number, checked: boolean): void; base?: MarkdownBaseInfo; runnable?: boolean; onOpenReference?(): void }): React.JSX.Element {
  const t = useT(), inherited = React.useContext(MarkdownBase)
  const context = base ?? inherited, [paths, setPaths] = useState<Map<string, { path: string; directory: boolean }>>(new Map())
  useEffect(() => {
    if (!context) { setPaths(new Map()); return }
    const withoutFences = source.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, ''), candidates = new Set<string>()
    for (const match of withoutFences.matchAll(/`([^`\n]+)`|(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) { const value = (match[1] ?? match[2] ?? '').trim(); if (value.length <= 4096 && (match[2] ? isFileLink(value) : /^[\w@.~/\\:-]{2,}$/.test(value))) candidates.add(value) }
    let alive = true; setPaths(new Map())
    const timer = window.setTimeout(() => { if (candidates.size) void window.gearmod.invoke('workspace:resolve-references', { projectId: context.projectId, cardId: context.cardId, ...(context.path ? { markdownPath: context.path } : {}), targets: [...candidates].slice(0, 200) }).then((items) => { if (alive) setPaths(new Map(items.map((item) => [item.target, item]))) }).catch(() => undefined) }, 250)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [source, context?.projectId, context?.cardId, context?.path])
  // Accepts Windows line breaks (CRLF): the `\r` at the end of the line prevented recognizing headings and lists.
  const lines = source.split(/\r?\n/), blocks: React.ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) { i += 1; continue }
    // HTML comment (e.g. the version report that Spec Kit puts at the top of the constitution) is not shown.
    if (/^\s*<!--/.test(line)) { while (i < lines.length && !lines[i]!.includes('-->')) i += 1; i += 1; continue }
    const fence = /^(`{3,})\s*([\w-]*)/.exec(line)
    if (fence) {
      const start = i; const body: string[] = []; const size = fence[1]!.length; i += 1
      while (i < lines.length && !new RegExp(`^\`{${size},}\\s*$`).test(lines[i]!)) { body.push(lines[i]!); i += 1 }
      i += 1
      // Markdown file pasted into the chat: shows it rendered, not as code.
      if (/^(md|markdown)$/i.test(fence[2]!)) blocks.push(<div key={`b${start}`} className="mdfile"><Markdown source={body.join('\n')} runnable={runnable} /></div>)
      else blocks.push(<CodeBlock key={`b${start}`} code={body.join('\n')} lang={fence[2]!} runnable={runnable} />)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) { const Tag = `h${Math.min(3, heading[1]!.length)}` as 'h1'; blocks.push(<Tag key={`b${i}`} data-line={i}>{inline(heading[2]!, `b${i}`)}</Tag>); i += 1; continue }
    if (/^---+\s*$/.test(line)) { blocks.push(<hr key={`b${i}`} />); i += 1; continue }
    if (/^>\s?/.test(line)) {
      const start = i; const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i]!)) { body.push(lines[i]!.replace(/^>\s?/, '')); i += 1 }
      blocks.push(<blockquote key={`b${start}`}>{inline(body.join(' '), `b${start}`)}</blockquote>); continue
    }
    if (listLine.test(line)) {
      const start = i; const collected: Array<{ match: RegExpExecArray; line: number }> = []
      while (i < lines.length) {
        const match = listLine.exec(lines[i]!)
        // An indented line right after an item is the continuation of its text, not a new paragraph.
        if (!match && /^\s+\S/.test(lines[i]!) && collected.length) { const last = collected[collected.length - 1]!.match; last[4] = `${last[4]} ${lines[i]!.trim()}`; i += 1; continue }
        if (!match) break
        collected.push({ match, line: i }); i += 1
      }
      blocks.push(renderItems(buildTree(collected), onToggle, `b${start}`)); continue
    }
    if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const start = i; const cells = (row: string): string[] => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
      const head = cells(line); i += 2; const rows: string[][] = []
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!)) { rows.push(cells(lines[i]!)); i += 1 }
      blocks.push(<table key={`b${start}`}><thead><tr>{head.map((cell, c) => <th key={c}>{inline(cell, `h${start}${c}`)}</th>)}</tr></thead><tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{inline(cell, `t${start}${r}${c}`)}</td>)}</tr>)}</tbody></table>); continue
    }
    const start = i; const body: string[] = []
    while (i < lines.length && lines[i]!.trim() && (i === start || !isSpecial(lines[i]!))) { body.push(lines[i]!.trim()); i += 1 }
    blocks.push(<p key={`b${start}`}>{inline(body.join(' '), `b${start}`)}</p>)
  }
  const files = context ? { paths, open: (target: string): void => { const item = paths.get(target); if (!item) return; onOpenReference?.(); const suffix = /(?::\d+(?::\d+)?|#L?\d+(?:-L?\d+)?)$/.exec(target)?.[0] ?? ''; const line = suffix.startsWith('#') ? `:${suffix.match(/\d+/)?.[0]}` : suffix; window.dispatchEvent(new CustomEvent('gearmod:open-file', { detail: { projectId: context.projectId, cardId: context.cardId, path: item.path + (item.directory ? '' : line), directory: item.directory } })) } } : null
  return <MarkdownBase.Provider value={context}><MarkdownFiles.Provider value={files}>{blocks.length ? blocks : <p className="mdEmpty">{t.shell.markdown.nothingWritten}</p>}</MarkdownFiles.Provider></MarkdownBase.Provider>
}
