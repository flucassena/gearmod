import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { AppDatabase } from './database'
import { tm } from './i18n'
import { attachmentNoteMarker } from './orchestrator'

export type CardAttachmentSource = 'chat' | 'manual' | 'import'
export interface CardAttachmentRecord {
  id: string; cardId: string; fileName: string; path: string; mediaType: string | null; sizeBytes: number
  source: CardAttachmentSource; createdAt: string; available: boolean
}
export type Trash = (path: string) => Promise<void>

/** Mirror of the renderer's splitAttachmentNote: the paths listed in the block the app appends to a message with attachments. */
export function parseAttachmentNote(body: string): string[] {
  const at = body.indexOf(attachmentNoteMarker)
  if (at < 0) return []
  return body.slice(at + attachmentNoteMarker.length).split('\n').map((line) => /^-\s+(.+)$/.exec(line.trim())?.[1]).filter((path): path is string => Boolean(path))
}

const mimeByExt: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv', '.xml': 'application/xml',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.zip': 'application/zip'
}
const mediaTypeOf = (name: string): string | null => mimeByExt[extname(name).toLowerCase()] ?? null
const safeName = (name: string): string => basename(name).replace(/[^\w. -]/g, '_').slice(-100) || 'arquivo'
const sameFold = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

interface Row { id: string; card_id: string; file_name: string; relative_path: string; media_type: string | null; size_bytes: number; checksum: string; created_at: string; source: CardAttachmentSource }
const columns = 'id, card_id, file_name, relative_path, media_type, size_bytes, checksum, created_at, source'

/** The app's own copy of each card attachment, under `<attachmentsDir>/cards/<cardId>/`. The user's original file is only ever read. */
export class CardAttachmentRepository {
  constructor(private readonly database: AppDatabase, private readonly attachmentsDir: string) {}

  /** Folder of the card's copies. */
  cardDir(cardId: string): string {
    if (!/^[\w-]{1,64}$/.test(cardId)) throw new Error(tm().ipc.attachmentCopyFailed)
    return resolve(this.attachmentsDir, 'cards', cardId)
  }

  /** Absolute path of a row's copy, only if it stays inside the card's folder (a tampered relative_path is refused). */
  private copyPath(row: Pick<Row, 'card_id' | 'relative_path'>): string | null {
    const dir = this.cardDir(row.card_id), full = resolve(this.attachmentsDir, row.relative_path), inside = relative(dir, full)
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || inside.includes(sep) || sameFold(full, dir)) return null
    return full
  }

  private view(row: Row): CardAttachmentRecord {
    const path = this.copyPath(row)
    return { id: row.id, cardId: row.card_id, fileName: row.file_name, path: path ?? '', mediaType: row.media_type, sizeBytes: row.size_bytes, source: row.source, createdAt: row.created_at, available: Boolean(path && existsSync(path)) }
  }

  list(cardId: string): CardAttachmentRecord[] {
    const rows = this.database.db.prepare(`SELECT ${columns} FROM card_attachments WHERE card_id = ? ORDER BY created_at DESC, rowid DESC`).all(cardId) as Row[]
    return rows.map((row) => this.view(row))
  }

  private byChecksum(cardId: string, checksum: string): Row | undefined {
    return this.database.db.prepare(`SELECT ${columns} FROM card_attachments WHERE card_id = ? AND checksum = ?`).get(cardId, checksum) as Row | undefined
  }

  /** Copies a file the user has on disk (stream: no limit by size, nothing loaded whole in memory). The same content in the same card is not copied twice. */
  async addFromPath(cardId: string, path: string, source: CardAttachmentSource, messageId?: string): Promise<CardAttachmentRecord> {
    if (!isAbsolute(path)) throw new Error(tm().ipc.attachmentNotFile)
    // Already one of this card's own copies (sent again from the folder or by "@"): nothing to copy.
    const own = this.database.db.prepare(`SELECT ${columns} FROM card_attachments WHERE card_id = ? AND relative_path = ?`).get(cardId, relative(this.attachmentsDir, resolve(path)).split(sep).join('/')) as Row | undefined
    if (own) return this.view(own)
    let info
    try { info = await stat(path) } catch { throw new Error(tm().ipc.fileNotFound) }
    if (!info.isFile()) throw new Error(tm().ipc.attachmentNotFile)
    const dir = this.cardDir(cardId); await mkdir(dir, { recursive: true })
    const temp = join(dir, `.${randomUUID()}.part`), hash = createHash('sha256')
    try {
      const hasher = new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); done(null, chunk) } })
      await pipeline(createReadStream(path), hasher, createWriteStream(temp))
    } catch { await rm(temp, { force: true }); throw new Error(tm().ipc.attachmentCopyFailed) }
    return this.store(cardId, temp, `sha256:${hash.digest('hex')}`, basename(path), source, messageId, path)
  }

  /** A file with no path (pasted screenshot): written from the bytes. */
  async addFromBuffer(cardId: string, name: string, data: Buffer): Promise<CardAttachmentRecord> {
    const dir = this.cardDir(cardId); await mkdir(dir, { recursive: true })
    const temp = join(dir, `.${randomUUID()}.part`)
    try { await writeFile(temp, data) } catch { await rm(temp, { force: true }); throw new Error(tm().ipc.attachmentCopyFailed) }
    return this.store(cardId, temp, `sha256:${createHash('sha256').update(data).digest('hex')}`, name, 'manual', undefined, null)
  }

  /** Turns the finished temporary copy into the attachment, or discards it when the card already has that content. */
  private async store(cardId: string, temp: string, checksum: string, name: string, source: CardAttachmentSource, messageId: string | undefined, original: string | null): Promise<CardAttachmentRecord> {
    const existing = this.byChecksum(cardId, checksum)
    if (existing) {
      await rm(temp, { force: true })
      // The copy was deleted from disk outside the app: this upload is what brings it back.
      return this.view(existing)
    }
    const id = randomUUID(), fileName = safeName(name), finalName = `${id.slice(0, 8)}-${fileName}`, final = join(dirname(temp), finalName)
    try {
      await rename(temp, final)
      const size = (await stat(final)).size
      this.database.db.prepare(`INSERT INTO card_attachments(id, card_id, file_name, relative_path, media_type, size_bytes, checksum, created_at, source, source_message_id, original_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, cardId, fileName, relative(this.attachmentsDir, final).split(sep).join('/'), mediaTypeOf(fileName), size, checksum, new Date().toISOString(), source, messageId ?? null, original)
    } catch (error) {
      await rm(final, { force: true }); await rm(temp, { force: true })
      const raced = this.byChecksum(cardId, checksum)  // a parallel copy of the same content won
      if (raced) return this.view(raced)
      throw error
    }
    return this.view(this.byChecksum(cardId, checksum)!)
  }

  /** Takes attachments out of the card. Only the app's copies go to the trash; if the trash refuses, the row stays and the id is reported. */
  async remove(cardId: string, ids: string[], trash: Trash): Promise<{ removed: string[]; failed: { id: string; reason: string }[] }> {
    const removed: string[] = [], failed: { id: string; reason: string }[] = []
    const get = this.database.db.prepare(`SELECT ${columns} FROM card_attachments WHERE id = ?`), del = this.database.db.prepare('DELETE FROM card_attachments WHERE id = ?')
    for (const id of new Set(ids)) {
      const row = get.get(id) as Row | undefined
      if (!row || row.card_id !== cardId) { failed.push({ id, reason: tm().ipc.attachmentNotFromCard }); continue }
      const path = this.copyPath(row)
      if (!path) { failed.push({ id, reason: tm().ipc.attachmentCopyFailed }); continue }
      if (existsSync(path)) {
        try { await trash(path) } catch { failed.push({ id, reason: tm().ipc.attachmentTrashFailed }); continue }
      }
      del.run(id); removed.push(id)
    }
    return { removed, failed }
  }

  /** Cards sitting in a column of type Done, with their attachments. */
  private doneRows(): Row[] {
    return this.database.db.prepare(`SELECT ${columns.split(', ').map((column) => `a.${column}`).join(', ')} FROM card_attachments a JOIN cards c ON c.id = a.card_id JOIN board_columns b ON b.id = c.column_id WHERE b.semantic_state = 'done' ORDER BY a.card_id`).all() as Row[]
  }

  doneSummary(): { cards: number; files: number; bytes: number } {
    const rows = this.doneRows()
    return { cards: new Set(rows.map((row) => row.card_id)).size, files: rows.length, bytes: rows.reduce((sum, row) => sum + row.size_bytes, 0) }
  }

  /** Empties the attachments of every Done card. Returns what was actually freed and how many the trash refused. */
  async clearDone(trash: Trash): Promise<{ cards: number; files: number; bytes: number; failed: number }> {
    const rows = this.doneRows(), sizes = new Map(rows.map((row) => [row.id, row.size_bytes]))
    const cards = new Set<string>(); let failed = 0, bytes = 0, files = 0
    for (const cardId of new Set(rows.map((row) => row.card_id))) {
      const result = await this.remove(cardId, rows.filter((row) => row.card_id === cardId).map((row) => row.id), trash)
      failed += result.failed.length; files += result.removed.length
      for (const id of result.removed) bytes += sizes.get(id) ?? 0
      if (result.removed.length) cards.add(cardId)
    }
    return { cards: cards.size, files, bytes, failed }
  }

  /** Brings the files of old messages (chats of cards) into the cards' folders. Idempotent: the unique (card, content) index stops duplicates. Missing files are skipped. */
  async importFromChats(): Promise<{ imported: number }> {
    const messages = this.database.db.prepare(`SELECT m.id AS id, m.body AS body, ch.card_id AS cardId FROM chat_messages m JOIN chats ch ON ch.id = m.chat_id JOIN cards c ON c.id = ch.card_id WHERE m.role = 'user' AND ch.card_id IS NOT NULL AND m.body LIKE ? ORDER BY m.created_at`).all(`%${attachmentNoteMarker.split('\n')[0]}%`) as { id: string; body: string; cardId: string }[]
    let imported = 0
    for (const message of messages) {
      for (const path of new Set(parseAttachmentNote(message.body))) {
        if (!isAbsolute(path)) continue
        try {
          if (!existsSync(path) || !statSync(path).isFile()) continue
          const before = this.database.db.prepare('SELECT COUNT(*) FROM card_attachments WHERE card_id = ?').pluck().get(message.cardId) as number
          await this.addFromPath(message.cardId, path, 'import', message.id)
          const after = this.database.db.prepare('SELECT COUNT(*) FROM card_attachments WHERE card_id = ?').pluck().get(message.cardId) as number
          if (after > before) imported += 1
        } catch { /* a file that cannot be read now is just not imported */ }
      }
    }
    return { imported }
  }
}
