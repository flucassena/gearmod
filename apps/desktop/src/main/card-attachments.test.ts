import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CardAttachmentRepository, parseAttachmentNote } from './card-attachments'
import { ConversationRepository } from './conversations'
import { AppDatabase } from './database'
import { attachmentNote, attachmentNoteMarker } from './orchestrator'
import { BoardRepository, ProfileRepository, ProjectRepository } from './projects'
import { seedProfiles } from './test-helpers'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const git = { validate: async () => undefined, branches: async () => ['dev'], inspect: async (localPath: string) => ({ localPath, name: 'p', repositories: [] }) }

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-cardatt-')); roots.push(root)
  const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
  const profiles = new ProfileRepository(database, root); seedProfiles(profiles)
  const profile = profiles.list()[0]!
  const projects = new ProjectRepository(database, git)
  const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev', profileIds: [profile.id] })
  const board = new BoardRepository(database, projects)
  const columns = board.get(project.id).columns
  const column = (state: string) => columns.find((item) => item.semanticState === state)!
  const card = (columnId: string) => board.create({ projectId: project.id, columnId, title: 'C', description: '', type: 'task', priority: 'low', acceptanceCriteria: [] })
  const attachmentsDir = join(root, 'attachments')
  const repo = new CardAttachmentRepository(database, attachmentsDir)
  const file = async (name: string, content: string) => { const path = join(root, name); await writeFile(path, content); return path }
  return { root, database, repo, attachmentsDir, project, profile, column, card, file }
}

describe('CardAttachmentRepository', () => {
  it('copies a file into the card folder, keeps the original and does not duplicate the same content', async () => {
    const { database, repo, attachmentsDir, card, column, file } = await setup()
    const c = card(column('todo').id)
    const original = await file('nota.txt', 'conteudo')
    const first = await repo.addFromPath(c.id, original, 'manual')
    const again = await repo.addFromPath(c.id, await file('outra.txt', 'conteudo'), 'manual')
    expect(again.id).toBe(first.id)
    expect(first).toMatchObject({ fileName: 'nota.txt', sizeBytes: 8, mediaType: 'text/plain', available: true, source: 'manual' })
    expect(first.path.startsWith(join(attachmentsDir, 'cards', c.id))).toBe(true)
    expect(existsSync(original)).toBe(true)
    expect(await readdir(join(attachmentsDir, 'cards', c.id))).toHaveLength(1)
    expect(repo.list(c.id)).toHaveLength(1)
    // Sent again from its own copy: still one.
    expect((await repo.addFromPath(c.id, first.path, 'chat')).id).toBe(first.id)
    database.close()
  })

  it('refuses folders and missing files, accepts pasted bytes and flags a copy that disappeared', async () => {
    const { database, repo, root, card, column } = await setup()
    const c = card(column('todo').id)
    await mkdir(join(root, 'pasta'))
    await expect(repo.addFromPath(c.id, join(root, 'pasta'), 'manual')).rejects.toThrow()
    await expect(repo.addFromPath(c.id, join(root, 'nao-existe.txt'), 'manual')).rejects.toThrow()
    await expect(repo.addFromPath(c.id, 'relativo.txt', 'manual')).rejects.toThrow()
    const pasted = await repo.addFromBuffer(c.id, 'print.png', Buffer.from('png'))
    expect(pasted.mediaType).toBe('image/png')
    await rm(pasted.path)
    expect(repo.list(c.id)[0]!.available).toBe(false)
    database.close()
  })

  it('sends only copies inside the card folder to the trash, refuses tampered paths and keeps what the trash refuses', async () => {
    const { database, repo, card, column, file } = await setup()
    const c = card(column('todo').id), other = card(column('todo').id)
    const a = await repo.addFromPath(c.id, await file('a.txt', 'a'), 'manual'), b = await repo.addFromPath(c.id, await file('b.txt', 'b'), 'manual'), d = await repo.addFromPath(c.id, await file('d.txt', 'd'), 'manual')
    const foreign = await repo.addFromPath(other.id, await file('e.txt', 'e'), 'manual')
    database.db.prepare('UPDATE card_attachments SET relative_path = ? WHERE id = ?').run('cards/x/../../../fora.txt', d.id)
    const trashed: string[] = []
    const result = await repo.remove(c.id, [a.id, b.id, d.id, foreign.id], async (path) => { if (path === b.path) throw new Error('no'); trashed.push(path) })
    expect(result.removed).toEqual([a.id])
    expect(result.failed.map((item) => item.id).sort()).toEqual([b.id, d.id, foreign.id].sort())
    expect(trashed).toEqual([a.path])
    expect(repo.list(c.id).map((item) => item.id).sort()).toEqual([b.id, d.id].sort())
    expect(repo.list(other.id)).toHaveLength(1)
    database.close()
  })

  it('counts and clears only the attachments of cards in Done', async () => {
    const { database, repo, card, column, file } = await setup()
    const done = card(column('done').id), doing = card(column('doing').id)
    await repo.addFromPath(done.id, await file('a.txt', 'aa'), 'manual'); await repo.addFromPath(done.id, await file('b.txt', 'bbb'), 'manual')
    await repo.addFromPath(doing.id, await file('c.txt', 'c'), 'manual')
    expect(repo.doneSummary()).toEqual({ cards: 1, files: 2, bytes: 5 })
    const trashed: string[] = []
    expect(await repo.clearDone(async (path) => { trashed.push(path) })).toEqual({ cards: 1, files: 2, bytes: 5, failed: 0 })
    expect(trashed).toHaveLength(2)
    expect(repo.list(done.id)).toHaveLength(0)
    expect(repo.list(doing.id)).toHaveLength(1)
    expect(repo.doneSummary()).toEqual({ cards: 0, files: 0, bytes: 0 })
    database.close()
  })

  it('parseAttachmentNote reads back what attachmentNote writes', () => {
    const paths = ['C:\\a b\\x.png', '/tmp/y.pdf']
    expect(attachmentNote(paths).startsWith(attachmentNoteMarker)).toBe(true)
    expect(parseAttachmentNote(`oi\n\n${attachmentNote(paths)}`)).toEqual(paths)
    expect(parseAttachmentNote('sem anexos')).toEqual([])
  })

  it('imports old card chat attachments once, skipping missing files and free chats', async () => {
    const { database, repo, card, column, file, project, profile } = await setup()
    const conversations = new ConversationRepository(database)
    const c = card(column('todo').id)
    const chat = conversations.createChat({ projectId: project.id, cardId: c.id, purpose: 'planning', profileId: profile.id })
    const free = conversations.createChat({ projectId: project.id, cardId: null, purpose: 'free', profileId: profile.id })
    const real = await file('antigo.txt', 'velho'), gone = join(tmpdir(), 'gearmod-nunca-existiu.txt')
    conversations.addMessage({ chatId: chat.id, role: 'user', body: `veja\n\n${attachmentNote([real, gone])}`, status: 'complete' })
    conversations.addMessage({ chatId: free.id, role: 'user', body: `livre\n\n${attachmentNote([real])}`, status: 'complete' })
    expect((await repo.importFromChats()).imported).toBe(1)
    expect((await repo.importFromChats()).imported).toBe(0)
    const items = repo.list(c.id)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ fileName: 'antigo.txt', source: 'import' })
    database.close()
  })
})
