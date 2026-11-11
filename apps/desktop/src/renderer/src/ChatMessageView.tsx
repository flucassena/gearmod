import React, { useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@gearmod/contracts'
import { AgentMessage, answersFor } from './AgentMessage'
import { AttachmentChips, splitAttachmentNote } from './Attachments'
import { ReplyContextCards } from './ChatReplies'
import { splitChatReplies } from './chatReplyContext'
import { useT } from './i18n'
import { parseWorkflowChoice, WorkflowChoiceRecord } from './WorkflowChoice'
import { FileIcon, ListIcon, ScreenIcon } from './icons'

/**
 * One chat message in Claude Code style: mine in the bubble; the agent's straight on the background, in Markdown;
 * tools used as gray lines that expand; system notices kept discreet.
 */
export function ChatMessageView({ message, answered = true, busy = false, answers }: { message: ChatMessage; answered?: boolean; busy?: boolean; answers?: Map<string, string> }): React.JSX.Element {
  if (message.role === 'tool') {
    const [title, ...rest] = message.body.split('\n'), detail = rest.join('\n').trim()
    return detail
      ? <details className="msg tool toolrow"><summary>{title}</summary><pre>{detail}</pre></details>
      : <div className="msg tool toolrow"><span className="toolplain">{title}</span></div>
  }
  // Notice that a system skill is driving this run (instead of showing the prompt): becomes a discreet tag.
  const skill = message.role === 'system' ? /^▶ Usando a skill (\S+)(.*)$/.exec(message.body) : null
  if (skill) return <div className="msg sys skillnote"><span className="skillbadge">skill</span><b>{skill[1]}</b>{skill[2] && <small>{skill[2].replace(/^\s*·\s*/, '')}</small>}</div>
  // The flow chosen on the card stays in the history, where it was chosen, as a collapsed flow card.
  const flowChoice = message.role === 'system' ? parseWorkflowChoice(message.body) : null
  if (flowChoice) return <div className="msg sys flowrecord" data-mid={message.id}><WorkflowChoiceRecord data={flowChoice} /></div>
  const kind = message.role === 'assistant' ? 'agent' : message.role === 'system' ? 'sys' : message.role
  // Long system notice marked with `▸ ` (e.g. files outside the Plan): first line always visible, the rest opens on click, so it does not take up the card.
  if (message.role === 'system' && message.status === 'failed' && message.body.includes('\n')) {
    const [title, ...rest] = message.body.split('\n')
    return <details className="msg sys toolrow sysnote" data-mid={message.id}><summary>⚠ {title}</summary><pre>{rest.join('\n').trim()}</pre></details>
  }
  return <div className={`msg ${kind}`} data-mid={message.id}>{message.role === 'system' && message.status === 'failed' ? '⚠ ' : ''}{message.role === 'assistant' ? <div className="md chatmd"><AgentMessage source={message.body} answered={answered} busy={busy} answers={answers} /></div> : message.role === 'user' ? <UserBody body={message.body} /> : message.body}</div>
}

/** User message: attachments as thumbnails on top and only the written text below (the block of paths stays behind the scenes). */
function UserBody({ body }: { body: string }): React.JSX.Element {
  const context = splitChatReplies(body), { text, files } = splitAttachmentNote(context.text), replies = context.replies
  const review = parseReviewContext(text), screenTest = parseScreenTest(text)
  return <>{files.length > 0 && <AttachmentChips files={files} />}<ReplyContextCards replies={replies} />{review ? <ReviewContext {...review} /> : screenTest ? <ScreenTestCard {...screenTest} /> : text && <div className="usertext">{text}</div>}</>
}

export interface ScreenTestData { skill: string; visible: boolean }

/** Recognizes the request from the "Test on screen (Playwright)" shortcut to show it as a settings card, not as text. */
export function parseScreenTest(body: string): ScreenTestData | null {
  const match = /^Teste os critérios de aceite que dependem da tela usando o Playwright CLI, seguindo a skill (\S+?)\.( Rode com o navegador visível \(--headed\) e com slowMo para eu acompanhar\.| Rode sem janela \(headless\), guardando screenshot e trace do que falhar\.)$/.exec(body.trim())
  return match ? { skill: match[1]!, visible: match[2]!.includes('--headed') } : null
}

/** Screen test card: what will be done and with which options (tool, skill, browser and evidence). */
function ScreenTestCard({ skill, visible }: ScreenTestData): React.JSX.Element {
  const s = useT().chat.screenTest
  const rows: Array<[string, string]> = [[s.tool, 'Playwright CLI'], [s.skill, skill], [s.browser, visible ? s.browserVisible : s.browserHeadless], [s.evidence, visible ? s.evidenceVisible : s.evidenceFailures]]
  return <div className="testcard" aria-label={s.ariaLabel}>
    <div className="testcard-head"><span className="testcard-ico" aria-hidden="true"><ScreenIcon /></span><div><b>{s.title}</b><small>{s.subtitle}</small></div></div>
    <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </div>
}

export interface ReviewContextData { path: string; lines: string; oldCode: boolean; code: string; comment: string }

/** Recognizes the request created when chatting about a diff selection. */
export function parseReviewContext(body: string): ReviewContextData | null {
  const normalized = body.replace(/\r\n?/g, '\n')
  const match = /^Revisão de código em `([^`]+)` \(((?:linha|linhas) [^)]+?|trecho)(, do código antigo)?\):\n\n```diff\n([\s\S]*?)\n```(?:\n\n([\s\S]*))?$/.exec(normalized)
  if (!match) return null
  return { path: match[1]!, lines: match[2]!, oldCode: Boolean(match[3]), code: match[4]!, comment: match[5]?.trim() ?? '' }
}


/** Visual context of the comment: compact location and an excerpt clearly delimited as code. */
function ReviewContext({ path, lines, oldCode, code, comment }: ReviewContextData): React.JSX.Element {
  const r = useT().chat.reviewContext
  return <div className="reviewctx">
    <div className="reviewctx-meta" aria-label={r.contextLabel}>
      <span className="reviewchip path" data-tip={path}><FileIcon /><span>{path}</span></span>
      <span className="reviewchip lines"><ListIcon /><span>{lines}{oldCode ? r.oldCode : ''}</span></span>
    </div>
    <div className="reviewcode">
      <div className="reviewcode-head"><span className="reviewcode-dots" aria-hidden="true"><i /><i /><i /></span><span>diff</span></div>
      <pre aria-label={r.selectedSnippet}><code>{code.split('\n').map((line, index) => {
        const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx'
        return <span key={index} className={kind}>{line || ' '}{index < code.split('\n').length - 1 ? '\n' : ''}</span>
      })}</code></pre>
    </div>
    {comment && <div className="reviewcomment">{comment}</div>}
  </div>
}

const pageSize = 10

/**
 * Consecutive agent actions (Grep, Read…). One action appears normally; from two on, it goes in a small box that shows only the
 * last one and expands into the history, which draws 10 at a time and loads more when scrolling up.
 */
function ToolGroup({ items }: { items: ChatMessage[] }): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false), [shown, setShown] = useState(pageSize)
  const list = useRef<HTMLDivElement>(null), keep = useRef<{ height: number; top: number } | null>(null), atBottom = useRef(true)
  const visible = items.slice(-shown)
  useLayoutEffect(() => {
    const el = list.current; if (!el) return
    if (keep.current) { el.scrollTop = keep.current.top + (el.scrollHeight - keep.current.height); keep.current = null }
    else if (atBottom.current) el.scrollTop = el.scrollHeight
  }, [open, shown, items.length])
  const onScroll = (): void => {
    const el = list.current; if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
    if (el.scrollTop < 24 && shown < items.length) { keep.current = { height: el.scrollHeight, top: el.scrollTop }; setShown(shown + pageSize) }
  }
  const toggle = (): void => { setOpen(!open); setShown(pageSize); atBottom.current = true }
  return <div className={`toolgroup ${open ? 'open' : ''}`}>
    <button type="button" className="toolgroup-head" aria-expanded={open} onClick={toggle}><span>{t.chat.toolGroup.actions(items.length)}</span><span className="chev" aria-hidden="true">›</span></button>
    {open
      ? <div className="toolgroup-list" ref={list} onScroll={onScroll}>{shown < items.length && <div className="toolgroup-more">{t.chat.toolGroup.scrollForPrevious}</div>}{visible.map((m) => <ChatMessageView key={m.id} message={m} />)}</div>
      : <ChatMessageView message={items[items.length - 1]!} />}
  </div>
}

/**
 * Chat message list. Tool actions only appear while the agent works on the current turn
 * (after the user's last message); when it finishes, they disappear and only the conversation remains.
 */
export function ChatMessageList({ messages, busy }: { messages: ChatMessage[]; busy: boolean }): React.JSX.Element {
  const lastUser = messages.reduce((found, m, index) => m.role === 'user' ? index : found, -1)
  const out: React.ReactNode[] = []
  // Answer to the agent's questions: disappears as a bubble and appears inside the question card.
  const hidden = new Set<string>(), answersOf = new Map<string, Map<string, string>>()
  messages.forEach((m, index) => {
    if (m.role !== 'assistant') return
    const next = messages.slice(index + 1).find((item) => item.role !== 'tool')
    const answers = next?.role === 'user' ? answersFor(m.body, next.body) : null
    if (next && answers) { hidden.add(next.id); answersOf.set(m.id, answers) }
  })
  for (let index = 0; index < messages.length; index++) {
    const m = messages[index]!
    if (hidden.has(m.id)) continue
    if (m.role !== 'tool') { out.push(<ChatMessageView key={m.id} message={m} answered={index < lastUser} busy={busy} answers={answersOf.get(m.id)} />); continue }
    const group: ChatMessage[] = []
    while (index < messages.length && messages[index]!.role === 'tool') group.push(messages[index++]!)
    index--
    if (!busy || index < lastUser) continue
    out.push(group.length === 1 ? <ChatMessageView key={group[0]!.id} message={group[0]!} /> : <ToolGroup key={group[0]!.id} items={group} />)
  }
  return <>{out}</>
}
