import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from './database'
import { ApprovalService } from './approvals'

const roots: string[] = [], databases: AppDatabase[] = []
async function service(): Promise<ApprovalService> { const root = await mkdtemp(join(tmpdir(), 'gearmod-approval-')); roots.push(root); const database = new AppDatabase(join(root, 'db.sqlite'), 'test'); databases.push(database); await database.open(); return new ApprovalService(database) }
afterEach(async () => { while (databases.length) databases.pop()!.close(); while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }) })

describe('ApprovalService', () => {
  it('consumes an approved operation once and rejects hash mismatches', async () => {
    const approvals = await service(), payload = { action: 'move', to: 'done' }, requested = approvals.request({ kind: 'agent-move', subjectRef: 'card', payload, requestedActor: 'agent' })
    expect(() => approvals.consume(requested.id, requested.opHash)).toThrow(/não é válida/)
    const approved = approvals.decide(requested.id, true)
    expect(approvals.consume(approved.id, approved.opHash).consumedAt).toBeTruthy()
    expect(() => approvals.consume(approved.id, approved.opHash)).toThrow(/não é válida/)
    expect(() => approvals.consume(approved.id, ApprovalService.operationHash({ other: true }))).toThrow(/não é válida/)
  })

  it('expires only the open requests of one kind on one card', async () => {
    const approvals = await service(), ask = (kind: string, cardId: string) => approvals.request({ kind, subjectRef: cardId, payload: { kind }, requestedActor: 'agent', cardId })
    const decided = ask('workflow-choice', 'a'); approvals.decide(decided.id, true)
    const old = ask('workflow-choice', 'a'), other = ask('workflow-choice', 'b'), move = ask('agent-move', 'a')
    expect(approvals.expireOpen('workflow-choice', 'a')).toBe(1)
    expect(approvals.get(old.id).status).toBe('expired')
    expect(approvals.get(decided.id).status).toBe('approved')
    expect(approvals.get(other.id).status).toBe('requested')
    expect(approvals.get(move.id).status).toBe('requested')
  })
})
