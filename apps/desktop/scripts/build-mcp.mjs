// Builds the native MCP relay (native/gearmod-mcp) and copies it next to resources/gearmod-mcp/server.mjs, where the app and
// the package look for it. Usage: node scripts/build-mcp.mjs [--arch x64|arm64]   (--arch picks the Mac target; default: this machine)
// Without Rust (cargo) it only warns, and the app keeps using server.mjs on Electron as Node; in CI (CI=true) a missing cargo fails.
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const crate = join(root, 'native', 'gearmod-mcp')
const archIndex = process.argv.indexOf('--arch')
const arch = archIndex > 0 ? process.argv[archIndex + 1] : process.arch
const targets = { darwin: { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' } }
const target = targets[process.platform]?.[arch]
const exe = process.platform === 'win32' ? 'gearmod-mcp.exe' : 'gearmod-mcp'

try { execFileSync('cargo', ['--version'], { stdio: 'ignore' }) } catch {
  if (process.env.CI) { process.stderr.write('cargo not found: install Rust to build the native MCP relay\n'); process.exit(1) }
  process.stderr.write('cargo not found: skipping the native MCP relay (the app uses resources/gearmod-mcp/server.mjs)\n')
  process.exit(0)
}
if (target) execFileSync('rustup', ['target', 'add', target], { stdio: 'inherit' })
execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', join(crate, 'Cargo.toml'), ...(target ? ['--target', target] : [])], { stdio: 'inherit' })
const built = join(crate, 'target', ...(target ? [target] : []), 'release', exe)
const destination = join(root, 'resources', 'gearmod-mcp', exe)
mkdirSync(dirname(destination), { recursive: true })
copyFileSync(built, destination)
process.stdout.write(`gearmod-mcp (${target ?? `${process.platform}-${arch}`}) -> ${destination}\n`)
