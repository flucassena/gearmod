import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BackupService } from './backup'
import { AppDatabase } from './database'
import { latestSchemaVersion, type Migration } from './migrations'
import { NoteRepository } from './repository'

const roots: string[] = []
async function tempRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'gearmod-')); roots.push(root); return root }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('AppDatabase', () => {
  it('preserves records and ids across a restart', async () => {
    const root = await tempRoot()
    const path = join(root, 'gearmod.sqlite')
    const first = new AppDatabase(path, '0.1.0')
    await first.open()
    const created = new NoteRepository(first).create('sobrevive ao reinício')
    first.close()

    const second = new AppDatabase(path, '0.1.0')
    await second.open()
    expect(new NoteRepository(second).list()).toEqual([created])
    expect(second.schemaVersion()).toBe(latestSchemaVersion)
    second.close()
  })

  it('migration 52 adds the card attachment columns and the per-card content index', async () => {
    const root = await tempRoot()
    const database = new AppDatabase(join(root, 'gearmod.sqlite'), '0.1.0')
    await database.open()
    const columns = (database.db.prepare('PRAGMA table_info(card_attachments)').all() as { name: string }[]).map((column) => column.name)
    expect(columns).toEqual(expect.arrayContaining(['source', 'source_message_id', 'original_path']))
    const indexes = (database.db.prepare('PRAGMA index_list(card_attachments)').all() as { name: string; unique: number }[])
    expect(indexes.find((index) => index.name === 'card_attachments_card_checksum')?.unique).toBe(1)
    expect(indexes.some((index) => index.name === 'card_attachments_card')).toBe(true)
    database.db.pragma('foreign_keys = OFF')
    const insert = database.db.prepare(`INSERT INTO card_attachments(id, card_id, file_name, relative_path, size_bytes, checksum, created_at) VALUES (?, 'c1', 'a.txt', 'cards/c1/a.txt', 1, 'sha256:x', '2026-01-01')`)
    insert.run('a1')
    expect(() => insert.run('a2')).toThrow(/UNIQUE/)
    database.close()
  })

  it('rolls back the complete migration batch when an upgrade fails', async () => {
    const root = await tempRoot()
    const path = join(root, 'gearmod.sqlite')
    const v1: Migration = { version: 1, checksum: 'v1', up: (db) => db.exec('CREATE TABLE durable(id TEXT PRIMARY KEY)') }
    const initial = new AppDatabase(path, '0.1.0', [v1])
    await initial.open()
    initial.db.prepare('INSERT INTO durable(id) VALUES (?)').run('same-id')
    initial.close()

    const broken: Migration = { version: 2, checksum: 'broken', up: (db) => { db.exec('ALTER TABLE durable ADD COLUMN label TEXT'); throw new Error('simulated failure') } }
    const upgrading = new AppDatabase(path, '0.2.0', [v1, broken])
    await expect(upgrading.open()).rejects.toThrow('simulated failure')
    expect(upgrading.schemaVersion()).toBe(1)
    expect(upgrading.db.prepare('PRAGMA table_info(durable)').all()).toHaveLength(1)
    expect(upgrading.db.prepare('SELECT id FROM durable').get()).toEqual({ id: 'same-id' })
    upgrading.close()
  })

  it('runs the pre-upgrade hook before applying a new schema', async () => {
    const root = await tempRoot()
    const path = join(root, 'gearmod.sqlite')
    const v1: Migration = { version: 1, checksum: 'v1', up: (db) => db.exec('CREATE TABLE item(id TEXT PRIMARY KEY)') }
    const v2: Migration = { version: 2, checksum: 'v2', up: (db) => db.exec('ALTER TABLE item ADD COLUMN title TEXT') }
    const first = new AppDatabase(path, '0.1.0', [v1]); await first.open(); first.close()
    const seen: number[] = []
    const second = new AppDatabase(path, '0.2.0', [v1, v2])
    await second.open(async (_db, from, to) => { seen.push(from, to) })
    expect(seen).toEqual([1, 2])
    second.close()
  })
})

describe('BackupService', () => {
  it('backs up a WAL database plus attachments and restores verified content', async () => {
    const root = await tempRoot()
    const path = join(root, 'gearmod.sqlite')
    const database = new AppDatabase(path, '0.1.0'); await database.open()
    const notes = new NoteRepository(database)
    const original = notes.create('valor original')
    const backups = new BackupService(root, '0.1.0')
    await mkdir(join(root, 'attachments'), { recursive: true })
    await writeFile(join(root, 'attachments', 'proof.txt'), 'attachment-data')
    const backup = await backups.create(database.db, 'test')
    notes.create('valor posterior')
    await writeFile(join(root, 'attachments', 'proof.txt'), 'changed')
    database.close()

    await backups.restore(backup.id, path)
    const restored = new AppDatabase(path, '0.1.0'); await restored.open()
    expect(new NoteRepository(restored).list()).toEqual([original])
    expect(await readFile(join(root, 'attachments', 'proof.txt'), 'utf8')).toBe('attachment-data')
    restored.close()
  })

  it('if copying the attachments fails, the current database and attachments stay as they were (D2)', async () => {
    const root = await tempRoot(); const path = join(root, 'gearmod.sqlite')
    const database = new AppDatabase(path, '0.1.0'); await database.open()
    const notes = new NoteRepository(database), backups = new BackupService(root, '0.1.0')
    await mkdir(join(root, 'attachments'), { recursive: true }); await writeFile(join(root, 'attachments', 'a.txt'), 'atual')
    const backup = await backups.create(database.db, 'test')
    const atual = notes.create('valor atual')
    await rm(join(root, 'backups', backup.id, 'attachments'), { recursive: true, force: true })
    database.close()
    await expect(backups.restore(backup.id, path)).rejects.toThrow()
    expect(await readFile(join(root, 'attachments', 'a.txt'), 'utf8')).toBe('atual')
    const reopened = new AppDatabase(path, '0.1.0'); await reopened.open()
    expect(new NoteRepository(reopened).list()).toContainEqual(atual)
    reopened.close()
  })

  it('rejects a database whose backup checksum was changed', async () => {
    const root = await tempRoot(); const path = join(root, 'gearmod.sqlite')
    const database = new AppDatabase(path, '0.1.0'); await database.open()
    const backups = new BackupService(root, '0.1.0'); const backup = await backups.create(database.db, 'test'); database.close()
    await writeFile(join(root, 'backups', backup.id, 'gearmod.sqlite'), 'tampered')
    await expect(backups.restore(backup.id, path)).rejects.toThrow('checksum')
  })
})
