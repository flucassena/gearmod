// GearMod MCP server (stdio). Runs as a child process of the agent and only talks to the app over a local channel
// (Unix socket or named pipe) using the execution token. It opens no network port and does not read the database.
// It is only a relay: the tool list (by conversation role) and every answer come from the app (src/main/mcp-tools.ts and McpBridge).
// The package normally runs the native version of this same relay (native/gearmod-mcp); this file is the fallback, on Electron as Node.
import process from 'node:process'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'

const socketPath = process.env.GEARMOD_SOCKET
const token = process.env.GEARMOD_TOKEN

function callApp(request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    socket.on('connect', () => socket.write(`${JSON.stringify({ token, ...request })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const end = buffer.indexOf('\n')
      if (end < 0) return
      socket.end()
      try { resolve(JSON.parse(buffer.slice(0, end))) } catch (error) { reject(error) }
    })
    socket.on('error', reject)
  })
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const unreachable = (error) => `Could not reach GearMod: ${error instanceof Error ? error.message : String(error)}`

async function handle(message) {
  const { id, method, params } = message
  if (id === undefined) return
  if (method === 'initialize') return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'gearmod', version: '1.0.0' } } })
  if (method === 'ping') return send({ id, result: {} })
  if (method === 'tools/list') {
    try {
      const answer = await callApp({ list: true })
      return answer.ok ? send({ id, result: { tools: answer.tools } }) : send({ id, error: { code: -32603, message: answer.error } })
    } catch (error) { return send({ id, error: { code: -32603, message: unreachable(error) } }) }
  }
  if (method === 'tools/call') {
    // The app refuses a tool outside the role with the proper notice (e.g. "This tool belongs to the planner"), never a protocol error.
    try {
      const answer = await callApp({ tool: params?.name, args: params?.arguments ?? {} })
      if (answer.unknown) return send({ id, error: { code: -32602, message: answer.error } })
      send({ id, result: { content: [{ type: 'text', text: answer.ok ? answer.text : answer.error }], isError: !answer.ok } })
      // The call changed the conversation role (e.g. free chat → planning): the agent asks for the tool list again.
      if (answer.listChanged) send({ method: 'notifications/tools/list_changed' })
      return
    } catch (error) {
      return send({ id, result: { content: [{ type: 'text', text: unreachable(error) }], isError: true } })
    }
  }
  return send({ id, error: { code: -32601, message: `Unsupported method: ${method}` } })
}

if (!socketPath || !token) { process.stderr.write('GEARMOD_SOCKET and GEARMOD_TOKEN are required\n'); process.exit(1) }
createInterface({ input: process.stdin }).on('line', (line) => { try { void handle(JSON.parse(line)) } catch { /* invalid line */ } })
