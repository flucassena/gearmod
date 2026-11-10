import React, { useEffect, useRef, useState } from 'react'
import type { CardAttachment } from '@gearmod/contracts'
import { rankPaths } from './editor/quickOpen'
import { combineMentions, type MentionEntry } from './cardAttachmentsLogic'
import { useT } from './i18n'
import { FileIcon, FolderGlyph } from './icons'

interface Hit { path: string; relative: string; name: string; directory: boolean }
const maxHits = 8

/**
 * "@" in the message field: opens the list of project files (or the card's worktree), filtered by what comes after the "@".
 * Choosing one replaces the fragment with `@relative/path ` in the text, which the agent understands as a file reference.
 * In a card chat (`attach` given), the card's attachments come first: choosing one removes the fragment and adds the file to the next message.
 */
export function useAtMention({ projectId, cardId, input, setInput, attach }: { projectId: string; cardId: string | null; input: string; setInput(value: string): void; attach?(path: string): void }) {
  const t = useT()
  const area = useRef<HTMLTextAreaElement>(null), roots = useRef<string[]>([]), latest = useRef(0)
  const [caret, setCaret] = useState(0), [hits, setHits] = useState<Hit[]>([]), [cardFiles, setCardFiles] = useState<CardAttachment[]>([]), [index, setIndex] = useState(0), [closedAt, setClosedAt] = useState(-1)
  const found = /(^|\s)@([^\s@]*)$/.exec(input.slice(0, caret)), query = found ? found[2]! : null, start = found ? caret - found[2]!.length - 1 : -1
  const entries: MentionEntry[] = query === null ? [] : combineMentions(query, attach ? cardFiles : [], hits.map((hit) => ({ path: hit.path, relative: hit.relative, name: hit.name, directory: hit.directory })), maxHits)
  const open = query !== null && closedAt !== start && entries.length > 0

  useEffect(() => { roots.current = [] }, [projectId, cardId])
  useEffect(() => {
    if (query === null) { setHits([]); setCardFiles([]); if (closedAt !== -1) setClosedAt(-1); return }
    if (attach && cardId) void window.gearmod.invoke('cards:attachments', { cardId }).then(setCardFiles).catch(() => setCardFiles([]))
    const ticket = ++latest.current
    const timer = window.setTimeout(() => {
      void (async () => {
        if (!roots.current.length) roots.current = (await window.gearmod.invoke('workspace:roots', { projectId, cardId })).filter((item) => item.primary).map((item) => item.path)
        const roots_ = roots.current, relativeOf = (path: string): string => { const root = roots_.find((item) => path.toLowerCase().startsWith(item.toLowerCase())); return (root ? path.slice(root.length) : path).split(String.fromCharCode(92)).join('/').replace(/^\/+/, '') }
        let next: Hit[]
        if (!query) {
          const entries = roots_[0] ? await window.gearmod.invoke('workspace:list', { projectId, cardId, path: roots_[0] }) : []
          next = entries.slice(0, maxHits).map((entry) => ({ path: entry.path, relative: relativeOf(entry.path), name: entry.name, directory: entry.directory }))
        } else {
          const { paths } = await window.gearmod.invoke('workspace:search', { projectId, cardId, query: query.slice(0, 200), fuzzy: true })
          const byRelative = new Map(paths.map((path) => [relativeOf(path), path]))
          next = rankPaths(query, [...byRelative.keys()]).slice(0, maxHits).map((item) => ({ path: byRelative.get(item.path) ?? item.path, relative: item.path, name: item.name, directory: false }))
        }
        if (ticket === latest.current) { setHits(next); setIndex(0) }
      })().catch(() => { if (ticket === latest.current) setHits([]) })
    }, query ? 120 : 0)
    return () => window.clearTimeout(timer)
  }, [projectId, cardId, query, Boolean(attach)])

  const pick = (hit: Hit): void => {
    const text = `@${hit.relative}${hit.directory ? '/' : ' '}`, next = input.slice(0, start) + text + input.slice(caret), position = start + text.length
    setInput(next); setCaret(position)
    window.requestAnimationFrame(() => { const element = area.current; if (element) { element.focus(); element.setSelectionRange(position, position) } })
  }
  const pickCard = (attachment: CardAttachment): void => {
    // The "@..." fragment leaves the text (the file goes as an attachment of the next message, not as a path in the text).
    const before = input.slice(0, start), after = input.slice(caret), next = before.endsWith(' ') && after.startsWith(' ') ? before + after.slice(1) : before + after
    setInput(next); setCaret(start); attach?.(attachment.path)
    window.requestAnimationFrame(() => { const element = area.current; if (element) { element.focus(); element.setSelectionRange(start, start) } })
  }
  const choose = (entry: MentionEntry): void => { if (entry.kind === 'card') pickCard(entry.attachment); else pick(entry.hit) }
  /** Returns true when the key belonged to the list (arrows, Enter/Tab to choose, Esc to close): the caller must not send the message. */
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => (value + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length); return true }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); const entry = entries[index]; if (entry) choose(entry); return true }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setClosedAt(start); return true }
    return false
  }
  const menu = open ? <div className="atmenu" role="listbox" aria-label={t.chat.atMention.projectFiles} onMouseDown={(event) => event.preventDefault()}>
    {entries.map((entry, position) => entry.kind === 'card' ? <React.Fragment key={entry.attachment.id}>
      {position === 0 && <div className="atsection">{t.chat.atMention.cardAttachments}</div>}
      <button type="button" role="option" aria-selected={position === index} className={`atitem ${position === index ? 'on' : ''}`} data-tip={entry.attachment.fileName} onMouseEnter={() => setIndex(position)} onClick={() => choose(entry)}>
        <FileIcon />
        <span className="atname">{entry.attachment.fileName}</span><span className="atpath" />
      </button></React.Fragment> : (() => { const hit = entry.hit; return <React.Fragment key={hit.path}>
      {position > 0 && entries[position - 1]!.kind === 'card' && <div className="atsection">{t.chat.atMention.projectFiles}</div>}
      <button type="button" role="option" aria-selected={position === index} className={`atitem ${position === index ? 'on' : ''}`} data-tip={hit.relative} onMouseEnter={() => setIndex(position)} onClick={() => choose(entry)}>
      {hit.directory ? <FolderGlyph /> : <FileIcon />}
      <span className="atname">{hit.name}</span><span className="atpath">{hit.relative.includes('/') ? hit.relative.slice(0, hit.relative.length - hit.name.length - 1) : ''}</span>
    </button></React.Fragment> })())}
  </div> : null
  return {
    menu, keyDown, ref: area,
    /** Call when the text or the cursor changes, to find out whether there is an "@" before the cursor. */
    caret: (value: number): void => setCaret(value)
  }
}

export interface InputToken { start: number; end: number; kind: 'file' | 'skill'; word: string }

/** Fragments of the text that count as a block: `@file` and `/skill` (only known skills), always starting a word. */
export function inputTokens(text: string, skillNames: string[]): InputToken[] {
  const found: InputToken[] = []
  for (const match of text.matchAll(/(^|\s)(@[^\s@]+|\/[^\s/]+)(?=\s|$)/g)) {
    const word = match[2]!, start = (match.index ?? 0) + match[1]!.length
    if (word.startsWith('@')) found.push({ start, end: start + word.length, kind: 'file', word })
    else if (skillNames.includes(word.slice(1))) found.push({ start, end: start + word.length, kind: 'skill', word })
  }
  return found
}

/**
 * Backspace (or Delete) inside an `@file` or `/skill` block removes the whole block, together with the space after it.
 * Returns the new text and the cursor position, or `null` when the key is not on a block (the caller proceeds normally).
 */
export function dropToken(event: React.KeyboardEvent<HTMLTextAreaElement>, text: string, skillNames: string[]): { text: string; at: number; token: InputToken } | null {
  if ((event.key !== 'Backspace' && event.key !== 'Delete') || event.nativeEvent.isComposing || event.shiftKey || event.altKey || event.metaKey) return null
  const { selectionStart, selectionEnd } = event.currentTarget
  if (selectionStart !== selectionEnd) return null
  const caret = selectionStart, back = event.key === 'Backspace'
  const token = inputTokens(text, skillNames).find((item) => back ? caret > item.start && caret <= item.end : caret >= item.start && caret < item.end)
  if (!token) return null
  const stop = token.end + (text[token.end] === ' ' ? 1 : 0)
  return { text: text.slice(0, token.start) + text.slice(stop), at: token.start, token }
}

/** Layer behind the textarea (transparent text): repeats the text and paints the `@file` and `/skill` blocks in another color. */
export function InputMirror({ text, skillNames, area }: { text: string; skillNames: string[]; area: React.RefObject<HTMLTextAreaElement | null> }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = area.current; if (!element) return
    const sync = (): void => { if (box.current) box.current.scrollTop = element.scrollTop }
    element.addEventListener('scroll', sync); sync()
    return () => element.removeEventListener('scroll', sync)
  }, [area, text])
  const parts: React.ReactNode[] = []
  let at = 0
  for (const token of inputTokens(text, skillNames)) {
    if (token.start > at) parts.push(text.slice(at, token.start))
    parts.push(<b key={token.start} className={`hltoken ${token.kind}`}>{token.word}</b>)
    at = token.end
  }
  parts.push(text.slice(at), '\u200b')
  return <div ref={box} className="hlmirror" aria-hidden="true">{parts}</div>
}
