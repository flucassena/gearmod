import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { analyzeHistory, checkMessage, CommitConventionStore, conventionMaxAgeMs, describeRules, isStale, measureHistory, repoKey, subjectLanguage, thinHistoryMaxAgeMs } from './commit-conventions'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const asf = [
  'feat(#ASF-9503): Nova análise de crédito na proposta',
  'fix(#ASF-9028): Corrige o cálculo do limite',
  'feat(#ASF-9411): Adiciona filtro por status',
  'Merge branch \'dev\' into feature/x',
  'fix(#ASF-9300): Ajusta mensagem de erro do cadastro',
  'chore(#ASF-9100): Atualiza dependências',
  'feat(#ASF-9200): Cria tela de histórico',
  'refactor(#ASF-9150): Separa o serviço de propostas',
  'fix(#ASF-9120): Remove validação duplicada do CPF',
  'feat(#ASF-9110): Exporta relatório em CSV',
  'fix(#ASF-9101): Evita erro quando não há contrato',
  'feat(#ASF-9090): Inclui campo de observação'
]
const plain = ['Add retry to the importer', 'Fix crash when the list is empty', 'Update the README', 'Remove the old cache', 'Use the new client for uploads', 'Rename the settings page', 'Improve the error message', 'Allow empty names', 'Support dark mode in the editor', 'Move helpers to utils', 'Fix the build on Linux']

describe('commit convention analysis', () => {
  it('finds Conventional Commits with the ticket in the scope, in Portuguese and capitalized', () => {
    const { rules, used } = measureHistory(asf)
    expect(used).toHaveLength(11)
    expect(rules).toMatchObject({ conventional: 1, ticket: 1, ticketPlacement: 'scope', ticketSample: '#ASF-9503', language: 'pt', capitalized: 1, trailingPeriod: 0 })
    expect(rules.types.slice(0, 2)).toEqual(['feat', 'fix'])
    const text = describeRules(rules, used.length)
    expect(text).toContain('Conventional Commits'); expect(text).toContain('feat(#ASF-9503)'); expect(text).toContain('Portuguese')
  })

  it('finds plain English subjects without a prefix or ticket', () => {
    const { rules } = measureHistory(plain)
    expect(rules).toMatchObject({ conventional: 0, ticket: 0, ticketPlacement: null, language: 'en' })
    expect(describeRules(rules, plain.length)).toContain('No Conventional Commits prefix')
  })

  it('tells the language of a subject', () => {
    expect(subjectLanguage('Corrige o cálculo do limite')).toBe('pt')
    expect(subjectLanguage('Fix the build on Linux')).toBe('en')
    expect(subjectLanguage('v2')).toBeNull()
  })

  it('with almost no history it says there is no settled pattern', () => {
    const entry = analyzeHistory({ path: '/r', name: 'r' }, ['primeiro'])
    expect(entry.sampleSize).toBe(1); expect(entry.description).toContain('almost no commit history')
    expect(checkMessage('qualquer coisa', entry).ok).toBe(true)
  })

  it('checks a message: the missing prefix blocks; ticket and language are notes', () => {
    const entry = analyzeHistory({ path: '/r', name: 'r' }, asf)
    expect(entry.examples[0]).toBe(asf[0]); expect(entry.examples.every((item) => item.includes('(#ASF-'))).toBe(true)
    expect(checkMessage('feat(#ASF-1): Cria a tela', entry)).toEqual({ ok: true, problems: [], notes: [] })
    const bare = checkMessage('Cria a tela de login', entry)
    expect(bare.ok).toBe(false); expect(bare.problems[0]).toContain('Conventional Commits')
    const noTicket = checkMessage('feat: Create the login screen', entry)
    expect(noTicket.ok).toBe(true); expect(noTicket.notes.join(' ')).toContain('ticket'); expect(noTicket.notes.join(' ')).toContain('Portuguese')
    expect(checkMessage('Add login', analyzeHistory({ path: '/r', name: 'r' }, plain)).ok).toBe(true)
  })

  it('is stale after about a month, or after a day with little history', () => {
    const now = Date.parse('2026-11-12T00:00:00Z')
    expect(isStale({ analyzedAt: new Date(now - conventionMaxAgeMs + 1000).toISOString(), sampleSize: 50 }, now)).toBe(false)
    expect(isStale({ analyzedAt: new Date(now - conventionMaxAgeMs - 1000).toISOString(), sampleSize: 50 }, now)).toBe(true)
    expect(isStale({ analyzedAt: new Date(now - thinHistoryMaxAgeMs - 1000).toISOString(), sampleSize: 2 }, now)).toBe(true)
    expect(isStale({ analyzedAt: 'nope', sampleSize: 50 }, now)).toBe(true)
  })
})

describe('CommitConventionStore', () => {
  async function store(now: { value: Date }): Promise<{ store: CommitConventionStore; file: string }> {
    const root = await mkdtemp(join(tmpdir(), 'gearmod-conv-')); roots.push(root)
    const file = join(root, 'data', 'commit-conventions.json')
    return { store: new CommitConventionStore(file, () => now.value), file }
  }

  it('analyzes once, saves one entry per repository with the date, and analyzes again when old', async () => {
    const now = { value: new Date('2026-10-01T10:00:00Z') }, { store: conventions, file } = await store(now)
    let reads = 0
    const history = async (): Promise<string[]> => { reads += 1; return asf }
    const repo = { path: 'C:\\Work\\Repo\\', name: 'repo' }
    const first = await conventions.ensure(repo, history)
    expect(first.refreshed).toBe(true); expect(first.entry).toMatchObject({ repoName: 'repo', source: 'auto', analyzedAt: '2026-10-01T10:00:00.000Z', sampleSize: 11 })
    const saved = JSON.parse(await readFile(file, 'utf8')) as { version: number; repos: Record<string, { analyzedAt: string; description: string; examples: string[] }> }
    expect(saved.version).toBe(1); expect(Object.keys(saved.repos)).toEqual([repoKey(repo.path)])
    expect(saved.repos[repoKey(repo.path)]!.examples.length).toBeGreaterThan(0)
    now.value = new Date('2026-10-20T10:00:00Z')
    expect((await conventions.ensure(repo, history)).refreshed).toBe(false); expect(reads).toBe(1)
    now.value = new Date('2026-11-12T10:00:00Z')
    const again = await conventions.ensure(repo, history)
    expect(again.refreshed).toBe(true); expect(again.previous?.analyzedAt).toBe('2026-10-01T10:00:00.000Z'); expect(again.entry.analyzedAt).toBe('2026-11-12T10:00:00.000Z'); expect(reads).toBe(2)
  })

  it('two callers at the same time share one analysis', async () => {
    const { store: conventions } = await store({ value: new Date() })
    let reads = 0
    const history = async (): Promise<string[]> => { reads += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return plain }
    const [a, b] = await Promise.all([conventions.ensure({ path: '/x', name: 'x' }, history), conventions.ensure({ path: '/x', name: 'x' }, history)])
    expect(reads).toBe(1); expect(a.entry).toEqual(b.entry)
  })

  it('an agent review keeps its description and examples, with the rules measured now', async () => {
    const now = { value: new Date('2026-11-12T10:00:00Z') }, { store: conventions } = await store(now)
    const saved = await conventions.save({ path: '/x', name: 'x' }, { description: 'feat|fix(#ASF-nnnn): Texto em português', examples: [' feat(#ASF-1): Um ', ''] }, async () => asf)
    expect(saved).toMatchObject({ source: 'agent', description: 'feat|fix(#ASF-nnnn): Texto em português', examples: ['feat(#ASF-1): Um'], analyzedAt: '2026-11-12T10:00:00.000Z' })
    expect(saved.rules.conventional).toBe(1)
    expect(conventions.get('/x')?.source).toBe('agent'); expect(conventions.all()).toHaveLength(1)
  })

  it('a damaged file starts over instead of failing', async () => {
    const { store: conventions, file } = await store({ value: new Date() })
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, '{ not json')
    expect(conventions.all()).toEqual([])
    expect((await conventions.ensure({ path: '/y', name: 'y' }, async () => plain)).refreshed).toBe(true)
  })
})
