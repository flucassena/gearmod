import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, delimiter } from 'node:path'
import { createRequire } from 'node:module'
import type { IPty } from 'node-pty'
import { tm } from './i18n'
const require = createRequire(import.meta.url)

export function shellCommand(platform: NodeJS.Platform, userShell?: string): { file: string; args: string[]; prelude: string } {
  if (platform === 'win32') {
    const pwsh = (process.env.PATH ?? '').split(delimiter).map((folder) => join(folder, 'pwsh.exe')).find((path) => existsSync(path))
    return { file: pwsh ?? 'powershell.exe', args: ['-NoLogo'], prelude: '' }
  }
  // The Mac default shell is zsh, and Terminal.app opens it as a login shell (reads ~/.zprofile, where Homebrew sets itself up).
  if (platform === 'darwin') return { file: userShell || '/bin/zsh', args: ['-l'], prelude: '' }
  return { file: userShell || '/bin/sh', args: [], prelude: '' }
}
/** Real PTY sessions, shared with the standalone window by ID. */
export class TerminalService {
  private shells = new Map<string, { proc: IPty; cwd: string; shell: string; text: string; seq: number; exited: boolean }>()
  constructor(private emit: (type: string, payload: Record<string, unknown>) => void, private platform: NodeJS.Platform = process.platform) {}
  open(cwd: string): string {
    const shell = shellCommand(this.platform, process.env.SHELL)
    return this.start({ file: shell.file, args: shell.args, env: process.env, cwd, title: this.platform === 'win32' ? 'PowerShell' : shell.file })
  }
  /** Runs one program (not a shell) in a PTY, e.g. an agent CLI's login; the session ends when the program exits. */
  run(command: { file: string; args: string[] | string; env: NodeJS.ProcessEnv; cwd: string; title: string }): string { return this.start(command) }
  private start(command: { file: string; args: string[] | string; env: NodeJS.ProcessEnv; cwd: string; title: string }): string {
    const id = randomUUID()
    const { spawn } = require('node-pty') as typeof import('node-pty')
    const env = Object.fromEntries(Object.entries(command.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
    const proc = spawn(command.file, command.args, { cwd: existsSync(command.cwd) ? command.cwd : homedir(), env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, cols: 100, rows: 28, name: 'xterm-256color', useConpty: true })
    const session = { proc, cwd: command.cwd, shell: command.title, text: '', seq: 0, exited: false }; this.shells.set(id, session)
    proc.onData((data) => { session.text = (session.text + data).slice(-500_000); session.seq++; this.emit('gearmod/terminal-data', { id, data, seq: session.seq }) })
    proc.onExit(({ exitCode }) => { session.exited = true; this.emit('gearmod/terminal-exit', { id, code: exitCode }) })
    return id
  }
  info(id: string): { id: string; cwd: string; shell: string; text: string; seq: number; exited: boolean } {
    const session = this.shells.get(id); if (!session) throw new Error(tm().terminals.terminalNotFound)
    return { id, cwd: session.cwd, shell: session.shell, text: session.text, seq: session.seq, exited: session.exited }
  }
  write(id: string, data: string): void { const session = this.shells.get(id); if (!session || session.exited) throw new Error(tm().terminals.terminalEnded); session.proc.write(data) }
  resize(id: string, cols: number, rows: number): void { const session = this.shells.get(id); if (session && !session.exited) session.proc.resize(cols, rows) }
  kill(id: string): void {
    const session = this.shells.get(id); if (!session) return
    if (!session.exited) { if (this.platform === 'win32' && session.proc.pid) execFile('taskkill', ['/pid', String(session.proc.pid), '/T', '/F'], () => undefined); session.proc.kill() }
    this.shells.delete(id)
  }
  dispose(): void { for (const id of [...this.shells.keys()]) this.kill(id) }
}
