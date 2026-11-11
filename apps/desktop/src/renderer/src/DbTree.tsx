import React, { useState } from 'react'
import type { IpcOutput } from '@gearmod/contracts'
import { plainError } from './NoticeDialog'
import { SchemaIcon } from './DbIcons'
import { useT } from './i18n'
import { ChevronRightSmallIcon } from './icons'

type TableItem = { oid: number; name: string; kind: string }
type Description = IpcOutput<'db:describe'>
const groups = [['tables', 'tables', (kind: string) => kind === 'r' || kind === 'p'], ['views', 'views', (kind: string) => kind === 'v' || kind === 'm'], ['sequences', 'sequences', (kind: string) => kind === 'S']] as const

/** With the mouse, only the arrow expands; with the keyboard (Enter/space, `detail` 0) the whole row still expands. */
export const viaChevron = (event: React.MouseEvent): boolean => event.detail === 0 || Boolean((event.target as Element).closest('.wf-chevron'))

const Chevron = ({ open, empty }: { open: boolean; empty?: boolean }): React.JSX.Element => <span className={`wf-chevron ${open ? 'open' : ''}`} aria-hidden="true">{!empty && <ChevronRightSmallIcon />}</span>
const Icon = ({ kind }: { kind: 'schema' | 'folder' | 'table' | 'view' | 'sequence' | 'column' | 'key' }): React.JSX.Element => <svg className={`ico db-ico ${kind}`} viewBox="0 0 16 16" aria-hidden="true">{{
  schema: <path d="M2.5 4.5h4l1 1.5h6v6.5h-11z" />,
  folder: <path d="M2.5 4.5h4l1 1.5h6v6.5h-11z" />,
  table: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M6.5 6.5V13" /></>,
  view: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><circle cx="8" cy="8.5" r="1.8" /></>,
  sequence: <path d="M4 4v8M4 4 2.8 5.2M8.5 12V4l-1 .8M12.5 12H9.5l3-3.5a1.5 1.5 0 0 0-3-.5" />,
  column: <><rect x="3" y="3" width="10" height="10" rx="1.5" /><path d="M3 6.5h10" /></>,
  key: <><circle cx="5.5" cy="8" r="2.5" /><path d="M8 8h5.5M11.5 8v2" /></>
}[kind]}</svg>

/** Object tree: already chosen server/database → schemas → tables/views/sequences → columns, keys and indexes. */
export function DbTree({ connectionId, schemas, tables, expanded, toggleSchema, query, activeOid, open, fail }: { connectionId: string; schemas: Array<{ oid: number; name: string }>; tables: Record<number, TableItem[]>; expanded: number[]; toggleSchema(oid: number, open: boolean): void; query: string; activeOid: number | 'sql'; open(item: { oid: number; name: string }): void; fail(message: string): void }): React.JSX.Element {
  const t = useT()
  const [toggled, setToggled] = useState<Set<string>>(new Set()), [details, setDetails] = useState<Record<number, Description>>({})
  const isOpen = (key: string, byDefault: boolean): boolean => byDefault !== toggled.has(key)
  const flip = (key: string): void => setToggled((current) => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next })
  const loadDetails = (oid: number): void => { if (!details[oid]) void window.gearmod.invoke('db:describe', { connectionId, oid }).then((value) => setDetails((current) => ({ ...current, [oid]: value }))).catch((reason) => fail(plainError(reason))) }
  const q = query.trim().toLowerCase()
  const group = (label: string, key: string, count: number, children: React.ReactNode, byDefault: boolean, level: number): React.JSX.Element => <div role="group" key={key}><button type="button" role="treeitem" aria-expanded={isOpen(key, byDefault)} className="db-node" style={{ paddingLeft: 6 + level * 16 }} onClick={(event) => { if (viaChevron(event)) flip(key) }}><Chevron open={isOpen(key, byDefault)} /><Icon kind="folder" /><span className="nm">{label}</span><em>{count}</em></button>{isOpen(key, byDefault) && children}</div>
  const leaf = (key: string, kind: 'column' | 'key', label: string, note: string, level: number, title?: string): React.JSX.Element => <div key={key} role="treeitem" className="db-node leaf" style={{ paddingLeft: 6 + level * 16 }} data-tip={title ?? `${label} ${note}`}><Chevron open={false} empty /><Icon kind={kind} /><span className="nm">{label}</span>{note && <small>{note}</small>}</div>
  const objectNode = (schema: { oid: number; name: string }, table: TableItem, kindName: string): React.JSX.Element => {
    const key = `t:${table.oid}`, expandable = kindName !== 'sequences', open_ = isOpen(key, false), info = details[table.oid]
    const pk = info?.columns.filter((column) => column.primaryKey) ?? [], fks = [...new Set(info?.columns.flatMap((column) => column.foreignKeys ?? []) ?? [])], idx = [...new Set(info?.columns.flatMap((column) => column.indexes ?? []) ?? [])]
    return <div role="group" key={table.oid}><button type="button" role="treeitem" aria-expanded={expandable ? open_ : undefined} className={`db-node table${activeOid === table.oid ? ' on' : ''}`} style={{ paddingLeft: 6 + 2 * 16 }} data-tip={expandable ? t.database.tree.openHint(table.name) : table.name}
      onClick={(event) => { if (!expandable || !viaChevron(event)) return; flip(key); if (!open_) loadDetails(table.oid) }} onDoubleClick={() => { if (expandable) open({ oid: table.oid, name: `${schema.name}.${table.name}` }) }}><Chevron open={open_} empty={!expandable} /><Icon kind={kindName === 'views' ? 'view' : kindName === 'sequences' ? 'sequence' : 'table'} /><span className="nm">{table.name}</span></button>
      {open_ && (info ? <>
        {group('columns', `c:${table.oid}`, info.columns.length, info.columns.map((column) => leaf(`col-${column.attnum}`, column.primaryKey ? 'key' : 'column', column.name, `${column.typeSql}${column.nullable ? '' : ' · not null'}`, 4)), false, 3)}
        {group('keys', `k:${table.oid}`, pk.length ? 1 : 0, pk.length ? leaf('pk', 'key', 'PRIMARY KEY', `(${pk.map((column) => column.name).join(', ')})`, 4) : null, false, 3)}
        {group('foreign keys', `f:${table.oid}`, fks.length, fks.map((item) => leaf(item, 'key', item.replace(/^FOREIGN KEY\s*/i, ''), '', 4, item)), false, 3)}
        {group('indexes', `i:${table.oid}`, idx.length, idx.map((item) => leaf(item, 'key', /INDEX\s+("?[\w.]+"?)\s+ON/i.exec(item)?.[1] ?? item, /\(([^)]*)\)\s*$/.exec(item)?.[1] ? `(${/\(([^)]*)\)\s*$/.exec(item)![1]})` : '', 4, item)), false, 3)}
      </> : <div className="db-node leaf" style={{ paddingLeft: 6 + 4 * 16 }}><span className="nm muted">{t.common.loading}</span></div>)}
    </div>
  }
  return <div role="tree" aria-label={t.database.page.schemasTitle} className="db-tree">{schemas.filter((schema) => !q || schema.name.toLowerCase().includes(q) || (tables[schema.oid] ?? []).some((table) => table.name.toLowerCase().includes(q))).map((schema) => {
    const opened = expanded.includes(schema.oid), list = (tables[schema.oid] ?? []).filter((table) => !q || schema.name.toLowerCase().includes(q) || table.name.toLowerCase().includes(q))
    return <div role="group" key={schema.oid}><button type="button" role="treeitem" aria-expanded={opened} className="db-node schema" style={{ paddingLeft: 6 }} onClick={(event) => { if (viaChevron(event)) toggleSchema(schema.oid, !opened) }}><Chevron open={opened} /><SchemaIcon /><span className="nm">{schema.name}</span>{tables[schema.oid] && <em>{tables[schema.oid]!.filter((table) => table.kind !== 'S').length}</em>}</button>
      {opened && (tables[schema.oid] ? groups.map(([name, label, pick]) => { const items = list.filter((table) => pick(table.kind)); return items.length ? group(label, `g:${schema.oid}:${name}`, items.length, items.map((table) => objectNode(schema, table, name)), name === 'tables', 1) : null }) : <div className="db-node leaf" style={{ paddingLeft: 6 + 1 * 16 }}><span className="nm muted">{t.common.loading}</span></div>)}
    </div>
  })}</div>
}
