// Runs the MCP tests against the native relay (resources/gearmod-mcp/gearmod-mcp[.exe], built by `pnpm build:mcp`)
// instead of server.mjs. It fails if the relay was not built.
import process from 'node:process'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const binary = join(root, 'resources', 'gearmod-mcp', process.platform === 'win32' ? 'gearmod-mcp.exe' : 'gearmod-mcp')
if (!existsSync(binary)) { process.stderr.write(`Native MCP relay not found: ${binary} (run pnpm build:mcp)\n`); process.exit(1) }
execSync('pnpm exec vitest run src/main/mcp-bridge.test.ts src/main/code-index/mcp-code-tools.test.ts', { cwd: root, stdio: 'inherit', env: { ...process.env, GEARMOD_MCP_BINARY: binary } })
