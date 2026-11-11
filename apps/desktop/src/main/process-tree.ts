import { execFile } from 'node:child_process'

/** One running process: id, parent id and when it started (ms since epoch). */
export interface ProcessInfo { pid: number; ppid: number; startedAt: number; name?: string }

/** Windows gives every console process a hidden `conhost.exe`; it lives as long as its parent and says nothing about the command. */
const consoleHosts = new Set(['conhost.exe'])

/** `ps` elapsed time (`[[dd-]hh:]mm:ss`) in seconds. */
export function parseElapsed(value: string): number {
  const [days, rest] = value.includes('-') ? value.split('-') as [string, string] : ['0', value]
  const parts = rest.split(':').map(Number)
  while (parts.length < 3) parts.unshift(0)
  const [h, m, s] = parts as [number, number, number]
  return Number(days) * 86400 + h * 3600 + m * 60 + s
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)))
}

/** Every process of the machine, with parent and start time. */
export async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) $($_.Name)" }'
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    return out.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((row) => row.length >= 3)
      .map(([pid, ppid, startedAt, ...name]) => ({ pid: Number(pid), ppid: Number(ppid), startedAt: Number(startedAt), name: name.join(' ').toLowerCase() }))
      .filter((row) => [row.pid, row.ppid, row.startedAt].every(Number.isFinite))
  }
  const now = Date.now(), out = await run('ps', ['-A', '-o', 'pid=,ppid=,etime='])
  return out.split('\n').map((line) => line.trim().split(/\s+/)).filter((row) => row.length === 3).map(([pid, ppid, etime]) => ({ pid: Number(pid), ppid: Number(ppid), startedAt: now - parseElapsed(etime!) * 1000 })).filter((row) => Number.isFinite(row.pid) && Number.isFinite(row.ppid))
}

/**
 * Whether the agent process still has a child started after `since` (a background command is a shell the agent started for it).
 * Older children (MCP servers, anything started before the task) do not count. A small margin covers clock rounding.
 */
export function hasNewDescendant(processes: ProcessInfo[], rootPid: number, since: number): boolean {
  const children = new Map<number, ProcessInfo[]>()
  for (const item of processes) { if (item.pid === item.ppid) continue; const list = children.get(item.ppid) ?? []; list.push(item); children.set(item.ppid, list) }
  const seen = new Set<number>([rootPid]), queue = [rootPid]
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid); queue.push(child.pid)
      if (child.startedAt >= since - 1_000 && !consoleHosts.has(child.name ?? '')) return true
    }
  }
  return false
}

/** Background command still running under the agent? When the check itself fails, assume it is alive (never kill on doubt). */
export async function backgroundAlive(rootPid: number | undefined, since: number): Promise<boolean> {
  if (!rootPid) return false
  try { return hasNewDescendant(await listProcesses(), rootPid, since) } catch { return true }
}
