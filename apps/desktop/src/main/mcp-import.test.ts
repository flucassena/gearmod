import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { acpMcpServers } from './gemini-acp'
import { McpRegistry, claudeMcpServers, geminiMcpServers, mcpNameFrom, parseMcpJson } from './mcp-registry'
import { GitService, ProjectRepository } from './projects'

const roots: string[] = [], opened: AppDatabase[] = []
afterEach(async () => { opened.splice(0).forEach((item) => item.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))) })
const storage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value, 'utf8'), decryptString: (value: Buffer) => value.toString('utf8') }

async function setup(): Promise<{ registry: McpRegistry; database: AppDatabase; folder: string; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-mcp-import-')); roots.push(root)
  const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open(); opened.push(database)
  const folder = join(root, 'project'); await mkdir(folder)
  const project = await new ProjectRepository(database, new GitService()).create({ localPath: folder })
  return { registry: new McpRegistry(database, join(root, 'secrets'), storage), database, folder, projectId: project.id }
}

const sseJson = JSON.stringify({ mcpServers: { 'manager-project': { type: 'sse', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer test-secret' } } } })

describe('reading an mcpServers JSON', () => {
  it('reads a remote SSE server with its headers', () => {
    expect(parseMcpJson(sseJson)).toEqual([{ name: 'manager-project', transport: 'http', sse: true, command: '', args: [], url: 'https://mcp.example.com/sse', env: [], headers: [{ key: 'Authorization', value: 'Bearer test-secret' }] }])
  })

  it('tells SSE from streamable HTTP and reads local servers', () => {
    const found = parseMcpJson(JSON.stringify({ mcpServers: {
      explicit: { type: 'http', url: 'https://a.example/sse' }, byAddress: { url: 'https://b.example/sse' }, plain: { url: 'https://c.example/mcp' },
      local: { command: 'npx', args: ['-y', 'x', 3], env: { KEY: 'v' } }, ignored: { nothing: true }
    } }))
    expect(found.map((item) => [item.name, item.transport, item.sse])).toEqual([['explicit', 'http', false], ['byAddress', 'http', true], ['plain', 'http', false], ['local', 'stdio', false]])
    expect(found[3]).toMatchObject({ args: ['-y', 'x'], env: [{ key: 'KEY', value: 'v' }] })
  })

  it('turns a name with spaces into one the registry accepts', () => {
    expect(mcpNameFrom('BIT MANAGER PROJECT')).toBe('BIT-MANAGER-PROJECT')
    expect(mcpNameFrom('  --a b/c__  ')).toBe('a-b-c')
    expect(parseMcpJson(JSON.stringify({ mcpServers: { 'My Server': { url: 'https://x.example/mcp' } } }))[0]!.name).toBe('My-Server')
  })

  it('refuses text that is not JSON or has no servers', () => {
    expect(() => parseMcpJson('{ nope')).toThrow()
    expect(() => parseMcpJson('{"mcpServers":{}}')).toThrow()
    expect(() => parseMcpJson('{"other":1}')).toThrow()
  })
})

describe('SSE servers in each agent', () => {
  it('imports one, hides its secret from SQLite, gives Claude "sse" and never hands it to Codex', async () => {
    const { registry, database, projectId } = await setup()
    expect(await registry.importJson({ scope: 'project', projectId, text: sseJson })).toEqual({ added: ['manager-project'], skipped: [] })
    expect(JSON.stringify(database.db.prepare('SELECT * FROM mcp_servers').all())).not.toContain('test-secret')
    const claude = await registry.effective(projectId, 'claude')
    expect(claude[0]).toMatchObject({ transport: 'http', sse: true, headers: { Authorization: 'Bearer test-secret' } })
    expect(claudeMcpServers(claude)['manager-project']).toMatchObject({ type: 'sse', url: 'https://mcp.example.com/sse' })
    expect(geminiMcpServers(claude)['manager-project']).toMatchObject({ url: 'https://mcp.example.com/sse' })
    expect(acpMcpServers(claude)[0]).toMatchObject({ type: 'sse' })
    expect(await registry.effective(projectId, 'codex')).toEqual([])
  })

  it('leaves out the names that already exist', async () => {
    const { registry, projectId } = await setup()
    await registry.importJson({ scope: 'project', projectId, text: sseJson })
    expect(await registry.importJson({ scope: 'project', projectId, text: sseJson })).toEqual({ added: [], skipped: ['manager-project'] })
  })
})

describe('the project .mcp.json', () => {
  it('is only detected, then imported when the user chooses', async () => {
    const { registry, folder, projectId } = await setup()
    expect(await registry.detect(projectId)).toEqual({ path: null, servers: [] })
    await writeFile(join(folder, '.mcp.json'), sseJson)
    const detected = await registry.detect(projectId)
    expect(detected.path).toBe(join(folder, '.mcp.json'))
    expect(detected.servers).toEqual([{ name: 'manager-project', kind: 'sse', exists: false }])
    expect(await registry.effective(projectId, 'claude')).toEqual([])  // detecting loads nothing
    expect(await registry.importJson({ scope: 'project', projectId, fromProjectFile: true })).toEqual({ added: ['manager-project'], skipped: [] })
    expect((await registry.detect(projectId)).servers[0]!.exists).toBe(true)
    await expect(registry.importJson({ scope: 'project', projectId: '40000000-0000-4000-8000-0000000000ff', fromProjectFile: true })).rejects.toThrow()
  })
})
