import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { BoardRepository, GitService, ProjectRepository, setLiveWaitingChats } from './projects'

const roots: string[] = [], opened: AppDatabase[] = []
afterEach(async () => {
  setLiveWaitingChats(() => [])
  for (const database of opened.splice(0)) database.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

async function setup(): Promise<{ database: AppDatabase; projects: ProjectRepository; board: BoardRepository; projectId: string; columnId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-waiting-')); roots.push(root)
  const folder = join(root, 'folder'); await mkdir(folder)
  const database = new AppDatabase(join(root, 'data', 'db.sqlite'), '0.1.0'); await database.open(); opened.push(database)
  const projects = new ProjectRepository(database, new GitService())
  const project = await projects.create({ sourcePaths: [folder] })
  const board = new BoardRepository(database, projects)
  return { database, projects, board, projectId: project.id, columnId: board.get(project.id).columns[0]!.id }
}

describe('what waits for the user on a card', () => {
  it('counts questions for the user, pending changes, open approvals and agents asking permission, and lists them per project', async () => {
    const { database, projects, board, projectId, columnId } = await setup()
    const card = board.create({ projectId, columnId, sourceId: null, title: 'Login', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    const quiet = board.create({ projectId, columnId, sourceId: null, title: 'Quiet', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    expect(board.card(card.id).waiting).toBe(0)
    expect(projects.list()[0]!.activity).toMatchObject({ waiting: 0, alerts: [] })

    const now = new Date().toISOString()
    database.db.prepare("INSERT INTO card_questions(id, card_id, number, asker_purpose, question, status, created_at) VALUES ('q1', ?, 1, 'execution', 'Which API?', 'user', ?)").run(card.id, now)
    database.db.prepare("INSERT INTO agent_profiles(id, provider, label, scope, color, config_dir, enabled, created_at, updated_at) VALUES ('profile-1', 'claude', 'Claude', 'Pessoal', '#fff', 'x', 1, ?, ?)").run(now, now)
    database.db.prepare("INSERT INTO chats(id, project_id, card_id, purpose, provider, profile_id, created_at, updated_at) VALUES ('chat-1', ?, ?, 'execution', 'claude', 'profile-1', ?, ?)").run(projectId, card.id, now, now)
    expect(board.card(card.id).waiting).toBe(1)

    // The agent asks permission right now (kept in memory by the orchestrator).
    setLiveWaitingChats(() => ['chat-1'])
    expect(board.card(card.id).waiting).toBe(2)
    expect(board.card(quiet.id).waiting).toBe(0)

    const activity = projects.list()[0]!.activity
    expect(activity.waiting).toBe(1)
    expect(activity.alerts).toEqual([{ cardId: card.id, title: 'Login', kind: 'waiting' }])

    // Answered and allowed: nothing waits any more.
    database.db.prepare("UPDATE card_questions SET status = 'answered' WHERE id = 'q1'").run()
    setLiveWaitingChats(() => [])
    expect(board.card(card.id).waiting).toBe(0)
    expect(projects.list()[0]!.activity.alerts).toEqual([])
  })
})
