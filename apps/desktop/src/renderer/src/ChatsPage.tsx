import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentPurpose, Card, Chat, ProjectBoard } from '@gearmod/contracts'
import { ArchiveIcon, BoardIcon, ChatIcon, SparkIcon } from './icons'
import { ChatContextMenu } from './ChatContextMenu'
import { ConfirmDialog } from './ConfirmDialog'
import { plainError } from './NoticeDialog'
import { tr, useT } from './i18n'

const label = (chat: Chat): string => chat.purpose === 'free' ? tr().chat.chatsPage.freeChat : chat.purpose === 'constitution' ? tr().chat.chatsPage.constitution : chat.purpose === 'conflict' ? tr().chat.chatsPage.conflict : chat.purpose === 'test-setup' ? tr().chat.chatsPage.testSetup : tr().chat.steps[chat.purpose]

const steps: readonly string[] = ['planning', 'execution', 'test']
const stepOrder = (chat: Chat): number => { const index = steps.indexOf(chat.purpose); return index < 0 ? steps.length : index }

const ago = (iso: string): string => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  const t = tr().chat.chatsPage
  if (minutes < 1) return t.now
  if (minutes < 60) return t.minutesAgo(minutes)
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t.hoursAgo(hours)
  const days = Math.round(hours / 24)
  return days === 1 ? t.yesterday : t.daysAgo(days)
}

/** Project chats page (in place of the board): search, new chat and the list of all chats, free ones and each card's. */
export function ChatsPage({ board, openCard, openCardEditor, openFree, deleted, current, changed }: { board: ProjectBoard; openCard(card: Card, purpose: AgentPurpose): void; openCardEditor(card: Card): void; openFree(chat?: Chat): void; deleted(chatId: string): void; current?: string; changed(): void }): React.JSX.Element {
  const t = useT(), p = t.chat.chatsPage
  const archived = board.cards.filter((card) => card.archivedAt), [restoring, setRestoring] = useState<string>()
  const [chats, setChats] = useState<Chat[]>([]), [query, setQuery] = useState(''), [filter, setFilter] = useState<'all' | 'free' | 'card' | 'archived'>('all'), [loaded, setLoaded] = useState(false)
  const [menu, setMenu] = useState<{ chat: Chat; x: number; y: number }>(), [deleting, setDeleting] = useState<Chat>(), [error, setError] = useState('')
  const load = useCallback(async () => { try { setChats(await window.gearmod.invoke('chats:list', { projectId: board.project.id })) } catch { /* the list is informational */ } finally { setLoaded(true) } }, [board.project.id])
  useEffect(() => { void load() }, [load])
  useEffect(() => window.gearmod.onRunEvent((event) => { if (['gearmod/run-started', 'gearmod/run-completed', 'gearmod/tool-activity'].includes(event.eventType)) void load() }), [load])
  // One row per card (its chats become step buttons) and one row per chat without a card.
  const rows = useMemo(() => {
    const groups = new Map<string, { card?: Card; chats: Chat[] }>()
    for (const chat of chats) {
      const card = chat.cardId ? board.cards.find((item) => item.id === chat.cardId) : undefined
      if (chat.cardId && (!card || card.archivedAt)) continue
      if (filter === 'free' && chat.cardId || filter === 'card' && !chat.cardId) continue
      const key = card ? card.id : chat.id
      groups.set(key, { card, chats: [...(groups.get(key)?.chats ?? []), chat] })
    }
    const q = query.trim().toLowerCase()
    return [...groups.values()].map((group) => ({ ...group, chats: group.chats.sort((a, b) => stepOrder(a) - stepOrder(b)), busy: group.chats.some((chat) => chat.busy), updatedAt: group.chats.reduce((latest, chat) => chat.updatedAt > latest ? chat.updatedAt : latest, '') }))
      .filter(({ card, chats: list }) => `${card?.title ?? ''} ${list.map((chat) => `${chat.title ?? ''} ${label(chat)}`).join(' ')}`.toLowerCase().includes(q))
      .sort((a, b) => Number(b.busy) - Number(a.busy) || b.updatedAt.localeCompare(a.updatedAt))
  }, [chats, board.cards, query, filter, p])
  const open = (chat: Chat, card?: Card): void => { if (!chat.cardId) openFree(chat); else if (card) openCard(card, chat.purpose as AgentPurpose) }
  const latest = (list: Chat[]): Chat => list.reduce((a, b) => b.updatedAt > a.updatedAt ? b : a)
  return <section className="chatspage" aria-label={p.projectChats}>
    <div className="cptools">
      <div className="cpsearch"><input className="in" type="search" placeholder={filter === 'archived' ? p.searchArchivedPlaceholder : p.searchPlaceholder} aria-label={filter === 'archived' ? p.searchArchived : p.search} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus /><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg></div>
      <div className="tabs" role="tablist" aria-label={p.filterLabel}>{([['all', t.common.all], ['free', p.filterFree], ['card', p.filterCards], ['archived', p.filterArchived]] as const).map(([value, label]) => <button type="button" key={value} role="tab" aria-selected={filter === value} className={`tab ${filter === value ? 'on' : ''}`} onClick={() => setFilter(value)}>{label}{value === 'archived' && archived.length > 0 ? ` (${archived.length})` : ''}</button>)}</div>
      <button type="button" className="cpnew" onClick={() => openFree()}><SparkIcon />{p.newChat}</button>
    </div>
    <div className="cplistpage">
      {error && <p className="error">{error}</p>}
      {filter === 'archived' ? <>{archived.filter((card) => (card.title || p.untitled).toLowerCase().includes(query.trim().toLowerCase())).map((card) => <div className="cpitem" key={card.id}><span className="cpico"><ArchiveIcon /></span><span className="cpmain"><b>{card.title || p.untitled}</b><span className="cpmeta">{p.archivedCard}</span></span><button type="button" className="mini secondary" disabled={restoring === card.id} onClick={() => { setRestoring(card.id); setError(''); void window.gearmod.invoke('cards:restore', { cardId: card.id }).then(() => changed()).catch((reason: unknown) => setError(plainError(reason))).finally(() => setRestoring(undefined)) }}>{p.restore}</button></div>)}{!archived.some((card) => (card.title || p.untitled).toLowerCase().includes(query.trim().toLowerCase())) && <div className="emptyBox cpempty">{query ? p.noArchivedFound : p.noArchived}</div>}</> : <>{rows.map(({ card, chats: list, busy, updatedAt }) => {
        const chat = latest(list)
        if (!card) return <button type="button" className={`cpitem ${current === chat.id ? 'on' : ''}`} key={chat.id} onClick={() => open(chat)} onContextMenu={(event) => { event.preventDefault(); setMenu({ chat, x: event.clientX, y: event.clientY }) }}>
          <span className="cpico"><ChatIcon /></span>
          <span className="cpmain"><b>{chat.purpose === 'constitution' ? p.projectConstitution : chat.purpose === 'free' ? chat.title || p.freeConversation : chat.purpose === 'conflict' ? chat.title || p.conflict : label(chat)}</b>
            <span className="cpmeta"><em className="cpchip free">{label(chat)}</em><span>{ago(chat.updatedAt)}</span></span></span>
          {chat.busy && <span className="spin sm" aria-label={p.running} />}
        </button>
        // Card row: a div, since the step buttons inside it are buttons themselves. Clicking the row opens the card's latest chat.
        return <div className={`cpitem cpcard ${list.some((item) => item.id === current) ? 'on' : ''}`} key={card.id} onClick={() => open(chat, card)} onContextMenu={(event) => { event.preventDefault(); setMenu({ chat, x: event.clientX, y: event.clientY }) }}>
          <span className="cpico"><BoardIcon /></span>
          <span className="cpmain"><b>{card.title || t.chat.tile.newCard}</b>
            <span className="cpmeta"><span>{board.columns.find((column) => column.id === card.columnId)?.label}</span><span>{ago(updatedAt)}</span>
              <span className="cpsteps">{list.map((item) => <button type="button" key={item.id} className={`cpstep ${item.busy ? 'busy' : ''} ${current === item.id ? 'on' : ''}`} title={ago(item.updatedAt)} onClick={(event) => { event.stopPropagation(); open(item, card) }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ chat: item, x: event.clientX, y: event.clientY }) }}>{item.busy && <span className="spin xs" aria-label={p.running} />}{label(item)}</button>)}</span></span></span>
          {busy && <span className="spin sm" aria-label={p.running} />}
        </div>
      })}
      {loaded && !rows.length && <div className="emptyBox cpempty">{query || filter !== 'all' ? p.noneFound : p.noneYet}</div>}</>}
    </div>
    {menu && <ChatContextMenu x={menu.x} y={menu.y} chat={menu.chat} cardTitle={board.cards.find((card) => card.id === menu.chat.cardId)?.title} openCard={menu.chat.cardId ? () => { const card = board.cards.find((item) => item.id === menu.chat.cardId); setMenu(undefined); if (card) openCardEditor(card) } : undefined} close={() => setMenu(undefined)} remove={() => { if (!menu.chat.cardId) setDeleting(menu.chat); setMenu(undefined) }} />}
    {deleting && <ConfirmDialog eyebrow={p.deleteChat} title={deleting.title || (deleting.purpose === 'constitution' ? p.projectConstitution : p.freeConversation)} text={p.deleteText} ok={p.delete} danger cancel={() => setDeleting(undefined)} confirm={() => { const chat = deleting; setDeleting(undefined); setError(''); void window.gearmod.invoke('chats:delete', { chatId: chat.id }).then(() => { deleted(chat.id); return load() }).catch((reason: unknown) => setError(plainError(reason))) }} />}
  </section>
}
