import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpPreset, McpServer, McpServerInput } from '@gearmod/contracts'
import type { AppDatabase } from './database'
import { SecretStore, type SecureStorage } from './secrets'
import { tm } from './i18n'

export type McpProvider = 'claude' | 'codex' | 'gemini'
/** What the adapter receives to inject into the run; contains secrets, never goes to the renderer. */
export type McpRunServer = { name: string } & ({ transport: 'stdio'; command: string; args: string[]; env: Record<string, string> } | { transport: 'http'; url: string; headers: Record<string, string>; sse?: boolean })

/** Most-used servers to get started. They only fill in the form: nothing is installed or run when one is chosen. */
export const mcpPresets: McpPreset[] = [
  { id: 'filesystem', label: 'Filesystem', get description() { return tm().mcpPresets.filesystemDescription }, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '<pasta permitida>'], env: [], headers: [], get note() { return tm().mcpPresets.filesystemNote } },
  { id: 'github', label: 'GitHub', get description() { return tm().mcpPresets.githubDescription }, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: ['GITHUB_PERSONAL_ACCESS_TOKEN'], headers: [], get note() { return tm().mcpPresets.githubNote } },
  { id: 'playwright', label: 'Playwright', get description() { return tm().mcpPresets.playwrightDescription }, transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: [], headers: [] },
  { id: 'context7', label: 'Context7', get description() { return tm().mcpPresets.context7Description }, transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: [], headers: [] },
  { id: 'fetch', label: 'Fetch', get description() { return tm().mcpPresets.fetchDescription }, transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], env: [], headers: [], get note() { return tm().mcpPresets.fetchNote } },
  { id: 'memory', label: 'Memory', get description() { return tm().mcpPresets.memoryDescription }, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: [], headers: [] },
  { id: 'sequential-thinking', label: 'Sequential Thinking', get description() { return tm().mcpPresets.sequentialThinkingDescription }, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], env: [], headers: [] },
  { id: 'postgres', label: 'PostgreSQL', get description() { return tm().mcpPresets.postgresDescription }, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', '<string de conexão>'], env: [], headers: [], get note() { return tm().mcpPresets.postgresNote } },
  { id: 'remote', get label() { return tm().mcpPresets.remoteLabel }, get description() { return tm().mcpPresets.remoteDescription }, transport: 'http', command: '', args: [], env: [], headers: ['Authorization'], get note() { return tm().mcpPresets.remoteNote } }
]

export type ImportedServer = { name: string; transport: 'stdio' | 'http'; sse: boolean; command: string; args: string[]; url: string; env: Array<{ key: string; value: string }>; headers: Array<{ key: string; value: string }> }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const pairsOf = (value: unknown): Array<{ key: string; value: string }> => (isRecord(value) ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, text]) => ({ key, value: text })) : [])
/** A name the registry accepts (letters, numbers, "-" and "_", up to 40): other characters become "-". */
export const mcpNameFrom = (raw: string): string => raw.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40)

/**
 * Reads the usual `{ "mcpServers": { "<name>": { type, url, headers } | { command, args, env } } }` (also `servers`). A server with `command` is local; with `url`
 * it is remote, SSE when `type` says so or the address ends in `/sse`. Entries that are neither are ignored.
 */
export function parseMcpJson(text: string): ImportedServer[] {
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new Error(tm().mcpRegistry.invalidJson) }
  const table = isRecord(data) ? (isRecord(data.mcpServers) ? data.mcpServers : isRecord(data.servers) ? data.servers : null) : null
  if (!table) throw new Error(tm().mcpRegistry.noServersInJson)
  const found: ImportedServer[] = []
  for (const [rawName, entry] of Object.entries(table)) {
    const name = mcpNameFrom(rawName)
    if (!name || !isRecord(entry)) continue
    const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '', command = typeof entry.command === 'string' ? entry.command.trim() : '', url = typeof entry.url === 'string' ? entry.url.trim() : ''
    if (command) found.push({ name, transport: 'stdio', sse: false, command, args: Array.isArray(entry.args) ? entry.args.filter((item): item is string => typeof item === 'string') : [], url: '', env: pairsOf(entry.env), headers: [] })
    else if (url) found.push({ name, transport: 'http', sse: type === 'sse' || (type !== 'http' && type !== 'streamable-http' && /\/sse\/?$/i.test(url)), command: '', args: [], url, env: [], headers: pairsOf(entry.headers) })
  }
  if (!found.length) throw new Error(tm().mcpRegistry.noServersInJson)
  return found
}

const nameRule = /^[a-z0-9][a-z0-9_-]{0,39}$/i
const reserved = new Set(['gearmod'])
type Secrets = { env: Record<string, string>; headers: Record<string, string> }
type Row = { id: string; scope: 'global' | 'project'; projectId: string | null; name: string; presetId: string | null; transport: 'stdio' | 'http'; sse: number; command: string | null; argsJson: string; url: string | null; envKeysJson: string; headerKeysJson: string; providersJson: string; enabled: number }

/**
 * GearMod MCP server registry: a global list and one per project, with an on/off switch per agent.
 * Servers are injected when each agent runs; the Claude/Codex configuration files are not touched.
 * Env and header values live in the system vault, never in SQLite or the renderer.
 */
export class McpRegistry {
  constructor(private readonly database: AppDatabase, private readonly secretDir: string, private readonly storage: SecureStorage) {}
  private store(id: string): SecretStore { return new SecretStore(join(this.secretDir, `${id}.bin`), this.storage) }
  private async secrets(id: string): Promise<Secrets> {
    try { const raw = await this.store(id).read(); const parsed = raw ? JSON.parse(raw) as Partial<Secrets> : {}; return { env: parsed.env ?? {}, headers: parsed.headers ?? {} } } catch { return { env: {}, headers: {} } }
  }
  private rows(projectId?: string): Row[] {
    return this.database.db.prepare(`SELECT id, scope, project_id AS projectId, name, preset_id AS presetId, transport, sse, command, args_json AS argsJson, url, env_keys_json AS envKeysJson, header_keys_json AS headerKeysJson, providers_json AS providersJson, enabled FROM mcp_servers
      WHERE scope = 'global' ${projectId ? "OR (scope = 'project' AND project_id = @projectId)" : ''} ORDER BY scope, name`).all(projectId ? { projectId } : {}) as Row[]
  }
  private disabledHere(projectId: string): Set<string> { return new Set(this.database.db.prepare('SELECT server_id FROM mcp_project_disabled WHERE project_id = ?').pluck().all(projectId) as string[]) }
  private async view(row: Row, disabled: Set<string>): Promise<McpServer> {
    const secrets = await this.secrets(row.id), keys = (json: string): string[] => JSON.parse(json) as string[]
    return { id: row.id, scope: row.scope, projectId: row.projectId, name: row.name, presetId: row.presetId, transport: row.transport, sse: row.sse === 1, command: row.command ?? '', args: JSON.parse(row.argsJson) as string[], url: row.url ?? '', env: keys(row.envKeysJson).map((key) => ({ key, set: Boolean(secrets.env[key]) })), headers: keys(row.headerKeysJson).map((key) => ({ key, set: Boolean(secrets.headers[key]) })), providers: JSON.parse(row.providersJson) as McpProvider[], enabled: Boolean(row.enabled), disabledHere: disabled.has(row.id) }
  }

  /** Global ones and, with `projectId`, the project's too. Secret values appear only as "set or not". */
  async list(projectId?: string): Promise<McpServer[]> {
    const disabled = projectId ? this.disabledHere(projectId) : new Set<string>()
    return Promise.all(this.rows(projectId).map((row) => this.view(row, disabled)))
  }

  async save(input: McpServerInput): Promise<McpServer> {
    const name = input.name.trim()
    if (!nameRule.test(name)) throw new Error(tm().mcpRegistry.invalidServerName)
    if (reserved.has(name.toLowerCase())) throw new Error(tm().mcpRegistry.reservedName(name))
    if (input.scope === 'project' && !input.projectId) throw new Error(tm().mcpRegistry.projectServerNeedsProject)
    if (input.scope === 'project' && !this.database.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(input.projectId)) throw new Error(tm().mcpRegistry.projectNotFoundDot)
    if (input.transport === 'stdio' && !input.command.trim()) throw new Error(tm().mcpRegistry.enterServerCommand)
    if (input.transport === 'http' && !/^https?:\/\/\S+$/i.test(input.url.trim())) throw new Error(tm().mcpRegistry.enterValidUrl)
    if (!input.providers.length) throw new Error(tm().mcpRegistry.chooseAtLeastOneAgent)
    const duplicate = this.database.db.prepare(`SELECT id FROM mcp_servers WHERE lower(name) = lower(?) AND scope = ? AND COALESCE(project_id, '') = ? AND id <> ?`).pluck().get(name, input.scope, input.scope === 'project' ? input.projectId ?? '' : '', input.id ?? '')
    if (duplicate) throw new Error(tm().mcpRegistry.serverNameExists(name))
    const id = input.id ?? randomUUID(), now = new Date().toISOString()
    const previous = input.id ? await this.secrets(id) : { env: {}, headers: {} }
    // An empty value keeps the secret already stored; a removed key disappears. Only what was typed replaces.
    const merge = (keys: Array<{ key: string; value?: string }>, old: Record<string, string>): Record<string, string> => Object.fromEntries(keys.filter((item) => item.key.trim()).map((item) => [item.key.trim(), item.value ? item.value : old[item.key.trim()] ?? '']))
    const env = merge(input.env, previous.env), headers = merge(input.headers, previous.headers)
    const row = { id, scope: input.scope, projectId: input.scope === 'project' ? input.projectId : null, name, presetId: input.presetId ?? null, transport: input.transport, sse: input.transport === 'http' && input.sse ? 1 : 0, command: input.transport === 'stdio' ? input.command.trim() : null, argsJson: JSON.stringify(input.transport === 'stdio' ? input.args.filter((arg) => arg !== '') : []), url: input.transport === 'http' ? input.url.trim() : null, envKeys: JSON.stringify(input.transport === 'stdio' ? Object.keys(env) : []), headerKeys: JSON.stringify(input.transport === 'http' ? Object.keys(headers) : []), providers: JSON.stringify([...new Set(input.providers)]), enabled: input.enabled ? 1 : 0, now }
    this.database.db.prepare(`INSERT INTO mcp_servers(id, scope, project_id, name, preset_id, transport, sse, command, args_json, url, env_keys_json, header_keys_json, providers_json, enabled, created_at, updated_at)
      VALUES (@id, @scope, @projectId, @name, @presetId, @transport, @sse, @command, @argsJson, @url, @envKeys, @headerKeys, @providers, @enabled, @now, @now)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, preset_id = excluded.preset_id, transport = excluded.transport, sse = excluded.sse, command = excluded.command, args_json = excluded.args_json, url = excluded.url, env_keys_json = excluded.env_keys_json, header_keys_json = excluded.header_keys_json, providers_json = excluded.providers_json, enabled = excluded.enabled, updated_at = excluded.updated_at`).run(row)
    await this.store(id).write(Object.keys(env).length || Object.keys(headers).length ? JSON.stringify({ env: input.transport === 'stdio' ? env : {}, headers: input.transport === 'http' ? headers : {} }) : null)
    return (await this.list(input.scope === 'project' ? input.projectId : undefined)).find((item) => item.id === id)!
  }

  /** `.mcp.json` files that may belong to the project: the one in the project folder and the ones in each repository. */
  private projectFiles(projectId: string): string[] {
    const folders = [
      ...(this.database.db.prepare('SELECT local_path FROM projects WHERE id = ?').pluck().all(projectId) as string[]),
      ...(this.database.db.prepare('SELECT local_path FROM project_sources WHERE project_id = ? ORDER BY sort_order').pluck().all(projectId) as string[])
    ]
    return [...new Set(folders.map((folder) => join(folder, '.mcp.json')))].filter((file) => existsSync(file))
  }

  /** What the project's own `.mcp.json` declares. Nothing is loaded from it: the user chooses to import (the file can start local programs). */
  async detect(projectId: string): Promise<{ path: string | null; servers: Array<{ name: string; kind: 'stdio' | 'http' | 'sse'; exists: boolean }> }> {
    const path = this.projectFiles(projectId)[0]
    if (!path) return { path: null, servers: [] }
    let found: ImportedServer[]
    try { found = parseMcpJson(readFileSync(path, 'utf8')) } catch { return { path, servers: [] } }
    const have = new Set((await this.list(projectId)).filter((item) => item.scope === 'project' || item.scope === 'global').map((item) => item.name.toLowerCase()))
    return { path, servers: found.map((item) => ({ name: item.name, kind: item.transport === 'stdio' ? 'stdio' as const : item.sse ? 'sse' as const : 'http' as const, exists: have.has(item.name.toLowerCase()) })) }
  }

  /** Adds the servers of an `mcpServers` JSON (what Claude Code, Cursor and others use), from pasted text or from the project's `.mcp.json`. Names already registered are left alone. */
  async importJson(input: { scope: 'global' | 'project'; projectId?: string; text?: string; fromProjectFile?: boolean }): Promise<{ added: string[]; skipped: string[] }> {
    let text = input.text ?? ''
    if (input.fromProjectFile) {
      const path = input.projectId ? this.projectFiles(input.projectId)[0] : undefined
      if (!path) throw new Error(tm().mcpRegistry.noProjectMcpFile)
      text = readFileSync(path, 'utf8')
    }
    const servers = parseMcpJson(text)
    const added: string[] = [], skipped: string[] = []
    const have = new Set((await this.list(input.projectId)).filter((item) => item.scope === input.scope).map((item) => item.name.toLowerCase()))
    for (const server of servers) {
      if (have.has(server.name.toLowerCase()) || reserved.has(server.name.toLowerCase())) { skipped.push(server.name); continue }
      try {
        await this.save({ scope: input.scope, ...(input.scope === 'project' ? { projectId: input.projectId } : {}), name: server.name, presetId: null, transport: server.transport, sse: server.sse, command: server.command, args: server.args, url: server.url, env: server.env, headers: server.headers, providers: server.sse ? ['claude'] : ['claude', 'codex'], enabled: true })
        added.push(server.name)
      } catch { skipped.push(server.name) }
    }
    return { added, skipped }
  }

  async remove(id: string): Promise<void> {
    this.database.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    await this.store(id).write(null)
  }

  /** Global server turned on/off for this project only. */
  setProjectEnabled(projectId: string, serverId: string, enabled: boolean): void {
    if (!this.database.db.prepare("SELECT 1 FROM mcp_servers WHERE id = ? AND scope = 'global'").get(serverId)) throw new Error(tm().mcpRegistry.onlyGlobalCanBeDisabled)
    if (enabled) this.database.db.prepare('DELETE FROM mcp_project_disabled WHERE project_id = ? AND server_id = ?').run(projectId, serverId)
    else this.database.db.prepare('INSERT OR IGNORE INTO mcp_project_disabled(project_id, server_id) VALUES (?, ?)').run(projectId, serverId)
  }

  /** What actually runs in this project with this agent: enabled, belonging to the agent, and not turned off in the project. */
  async effective(projectId: string, provider: McpProvider): Promise<McpRunServer[]> {
    const disabled = this.disabledHere(projectId), result: McpRunServer[] = []
    for (const row of this.rows(projectId)) {
      if (!row.enabled || disabled.has(row.id) || !(JSON.parse(row.providersJson) as string[]).includes(provider)) continue
      // Codex only speaks streamable HTTP: an SSE server is never handed to it.
      if (provider === 'codex' && row.sse === 1) continue
      const secrets = await this.secrets(row.id)
      result.push(row.transport === 'stdio'
        ? { name: row.name, transport: 'stdio', command: row.command ?? '', args: JSON.parse(row.argsJson) as string[], env: secrets.env }
        : { name: row.name, transport: 'http', url: row.url ?? '', headers: secrets.headers, ...(row.sse === 1 ? { sse: true } : {}) })
    }
    // Project wins over global when they have the same name.
    const byName = new Map<string, McpRunServer>(); for (const server of result) byName.set(server.name.toLowerCase(), server)
    return [...byName.values()]
  }
}

/** Extra servers in Codex's `mcp_servers` format (thread config). */
export function codexMcpServers(servers: McpRunServer[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(servers.map((server) => [server.name, server.transport === 'stdio'
    ? { command: server.command, args: server.args, env: server.env }
    : { url: server.url, ...(Object.keys(server.headers).length ? { http_headers: server.headers } : {}) }]))
}

/** Extra servers in Claude Code's `--mcp-config` format. */
export function claudeMcpServers(servers: McpRunServer[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(servers.map((server) => [server.name, server.transport === 'stdio'
    ? { command: server.command, args: server.args, env: server.env }
    : { type: server.sse ? 'sse' : 'http', url: server.url, ...(Object.keys(server.headers).length ? { headers: server.headers } : {}) }]))
}

/** Extra servers in the `mcpServers` format of the Gemini CLI's settings.json. */
export function geminiMcpServers(servers: McpRunServer[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(servers.map((server) => [server.name, server.transport === 'stdio'
    ? { command: server.command, args: server.args, env: server.env }
    : { [server.sse ? 'url' : 'httpUrl']: server.url, ...(Object.keys(server.headers).length ? { headers: server.headers } : {}) }]))
}
