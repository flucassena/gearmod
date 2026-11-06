import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { BoardRepository, ProjectRepository } from './projects'
import { verificationOnlyTasks } from './tasks'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))) })

const tasks = `## Tasks
- [ ] T001 Adicionar a verificação de Administrador em \`Admin/Users/index.tsx\`
  - [ ] Rodar o teste do admin e ver passando
- [ ] T005 Escrever os testes de \`Users.resetSenha.test.tsx\`
- [ ] T006 Rodar lint, type-check e a suíte de testes do front, e confirmar que o botão de primeiro acesso continua funcionando
- [ ] T007 Validar o e-mail no formulário de cadastro
- [ ] T008 [P] Verificar permissões e rodar a suíte
- [ ] T009 Confirmar que o login continua funcionando
- [ ] T010 Testar manualmente o fluxo de reset na tela
- [ ] T011 Executar os testes E2E com Playwright
- [ ] T012 Escrever o teste E2E do reset em \`reset.e2e.ts\``

describe('verification-only tasks', () => {
  it('flags only the top-level tasks that are verification', () => {
    expect(verificationOnlyTasks(tasks)).toEqual(['T006', 'T008', 'T009', 'T010', 'T011'])
  })

  it('the agent does not save Tasks with them; the user can', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-tasks-')); roots.push(root)
    const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
    const git = { validate: async () => undefined, branches: async () => ['dev'], inspect: async (localPath: string) => ({ localPath, name: 'p', repositories: [] }) }
    const projects = new ProjectRepository(database, git), board = new BoardRepository(database, projects)
    const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev' })
    const card = board.create({ projectId: project.id, columnId: board.get(project.id).columns[0]!.id, title: 'Reset', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
    expect(() => board.documents.write(card.id, 'tasks', tasks, 'agent')).toThrow(/T006, T008, T009, T010, T011 são só verificação.*Plano de testes/)
    expect(board.documents.write(card.id, 'tasks', tasks, 'user').contentMd).toBe(tasks)
    expect(board.documents.write(card.id, 'tasks', '## Tasks\n- [ ] T001 Escrever os testes do reset em `a.test.ts`', 'agent').contentMd).toContain('T001')
    database.close()
  })
})
