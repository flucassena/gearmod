import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentContextService } from '../agent-context'
import { AppDatabase } from '../database'
import { McpBridge } from '../mcp-bridge'
import { BoardRepository, ProjectRepository } from '../projects'
import { SettingsRepository } from '../settings'
import { createHostHandler } from './host-handler'
import type { HostMessage, HostRequest } from './protocol'
import { CodeIndexService, type HostProcess } from './service'

const dirs: string[] = []
const closers: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of closers.splice(0)) await close(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
const temp = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), 'gearmod-code-mcp-')); dirs.push(dir); return dir }
const git = { validate: async () => undefined, branches: async () => ['dev'], inspect: async (localPath: string) => ({ localPath, name: 'p', repositories: [] }) }
const serverScript = join(__dirname, '..', '..', '..', 'resources', 'gearmod-mcp', 'server.mjs')
// GEARMOD_MCP_BINARY=<path of native/gearmod-mcp build> runs these same tests against the native relay (`pnpm test:mcp-native`).
const relay = process.env.GEARMOD_MCP_BINARY ? { serverBinary: process.env.GEARMOD_MCP_BINARY } : {}

function fakeHost(): HostProcess {
  const listeners: Array<(message: HostMessage) => void> = []
  const handler = createHostHandler((message) => listeners.forEach((listener) => listener(message)))
  const host: HostProcess = {
    postMessage(message) {
      const { id, request } = message as { id: number; request: HostRequest }
      handler.handle(request).then((value) => listeners.forEach((listener) => listener({ id, ok: true, value })), (error: unknown) => listeners.forEach((listener) => listener({ id, ok: false, error: (error as Error).message })))
    },
    on(event: string, listener: never) { if (event === 'message') listeners.push(listener); return host },
    kill() { handler.close(); return true }
  }
  closers.push(() => { handler.close() })
  return host
}

function mcpClient(endpoint: { command: string; args: string[]; env: Record<string, string> }) {
  const child = spawn(endpoint.command, endpoint.args, { env: { ...process.env, ...endpoint.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['pipe', 'pipe', 'pipe'] })
  closers.push(() => { child.kill() })
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  createInterface({ input: child.stdout }).on('line', (line) => { const message = JSON.parse(line) as { id: number }; pending.get(message.id)?.(message as unknown as Record<string, unknown>) })
  let id = 0
  const request = (method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolve) => { id += 1; pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`) })
  const call = async (name: string, args: unknown) => (await request('tools/call', { name, arguments: args })).result as { content: Array<{ text: string }>; isError: boolean }
  const names = async () => ((await request('tools/list')).result as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> }).tools
  return { call, names }
}

async function setup(on: { value: boolean } = { value: true }) {
  const root = await temp(), data = await temp()
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'paths.ts'), 'export function allowedPath(roots: string[], requested: string): string { return requested }\n')
  await writeFile(join(root, 'src', 'files.ts'), "import { allowedPath } from './paths'\nexport function readFile(roots: string[], path: string): string { return allowedPath(roots, path) }\n")
  const database = new AppDatabase(join(data, 'db.sqlite'), '0.1.0'); await database.open()
  const projects = new ProjectRepository(database, git), board = new BoardRepository(database, projects)
  const project = await projects.create({ name: 'P', localPath: root, baseBranch: 'dev' })
  const card = board.create({ projectId: project.id, columnId: board.get(project.id).columns[1]!.id, title: 'Card', description: '', type: 'task', priority: 'medium', acceptanceCriteria: [] })
  const codeIndex = new CodeIndexService({ dataDir: data, fork: fakeHost })
  const asked: Array<{ cardId: string | null; chatId: string }> = []
  const bridge = new McpBridge({ board, context: new AgentContextService(board, new SettingsRepository(database), null), serverScript, runtime: process.execPath, ...relay, codeIndex, codeRoots: (run) => { asked.push(run); return [root] }, codeEnabled: () => on.value })
  await bridge.listen()
  closers.push(async () => { await bridge.close(); codeIndex.dispose(); database.close() })
  return { bridge, card, asked }
}

describe('gearmod_code_* tools through the MCP server', () => {
  it('appear as read-only for planning, execution, testing and free chat, and not in the Constitution chat', async () => {
    const { bridge, card } = await setup()
    const execution = await mcpClient(bridge.register('r1', card.id, () => undefined, { id: 'c1', purpose: 'execution' })).names()
    expect(execution.filter((tool) => tool.name.startsWith('gearmod_code_')).map((tool) => [tool.name, tool.annotations.readOnlyHint])).toEqual([['gearmod_code_explore', true], ['gearmod_code_node', true], ['gearmod_code_search', true], ['gearmod_code_impact', true], ['gearmod_code_callers', true], ['gearmod_code_map', true], ['gearmod_code_affected_tests', true]])
    const free = await mcpClient(bridge.register('r2', null, () => undefined, { id: 'c2', purpose: 'free' })).names()
    expect(free.some((tool) => tool.name === 'gearmod_code_explore')).toBe(true)
    expect(free.some((tool) => tool.name === 'gearmod_code_affected_tests')).toBe(true)
    expect(free.some((tool) => tool.name === 'gearmod_code_callers')).toBe(true)
    expect(free.some((tool) => tool.name === 'gearmod_code_map')).toBe(true)
    const constitution = await mcpClient(bridge.register('r3', null, () => undefined, { id: 'c3', purpose: 'constitution' })).names()
    expect(constitution.some((tool) => tool.name.startsWith('gearmod_code_'))).toBe(false)
  })

  it("answers in the card and in free chat with the conversation's folders; the Constitution refuses", async () => {
    const { bridge, card, asked } = await setup()
    const onCard = mcpClient(bridge.register('r1', card.id, () => undefined, { id: 'c1', purpose: 'execution' }))
    const impact = await onCard.call('gearmod_code_impact', { simbolo: 'allowedPath' })
    expect(impact.isError).toBe(false)
    expect(impact.content[0]!.text).toContain('readFile:2 — calls at lines 2')
    const free = mcpClient(bridge.register('r2', null, () => undefined, { id: 'c2', purpose: 'free' }))
    expect((await free.call('gearmod_code_explore', { pergunta: 'readFile allowedPath' })).content[0]!.text).toContain('**Flow')
    // the folders are requested when the run is registered (early indexing) and on each call
    expect(asked).toContainEqual({ cardId: card.id, chatId: 'c1' })
    expect(asked).toContainEqual({ cardId: null, chatId: 'c2' })
    const missing = await free.call('gearmod_code_search', {})
    expect(missing).toMatchObject({ isError: true })
    const constitution = mcpClient(bridge.register('r3', null, () => undefined, { id: 'c3', purpose: 'constitution' }))
    expect(await constitution.call('gearmod_code_search', { consulta: 'x' })).toMatchObject({ isError: true })
  })

  it('with the index turned off in the project the tools disappear, and anything already running gets a refusal', async () => {
    const on = { value: false }
    const { bridge, card, asked } = await setup(on)
    const off = mcpClient(bridge.register('r1', card.id, () => undefined, { id: 'c1', purpose: 'execution' }))
    expect((await off.names()).some((tool) => tool.name.startsWith('gearmod_code_'))).toBe(false)
    expect(asked).toEqual([]) // no early indexing
    on.value = true
    const running = mcpClient(bridge.register('r2', card.id, () => undefined, { id: 'c2', purpose: 'execution' }))
    expect((await running.names()).some((tool) => tool.name === 'gearmod_code_explore')).toBe(true)
    on.value = false
    const refused = await running.call('gearmod_code_search', { consulta: 'readFile' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toContain('turned off')
  })
})
