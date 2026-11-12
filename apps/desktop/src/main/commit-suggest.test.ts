import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentProfile, ModelOption } from '@gearmod/contracts'
import { cheapestCodexModel, commitLine, suggestCommitMessage, suggestCommitMessageCodex, type ProcessFactory } from './adapters'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

/** A CLI that reads stdin and, when it ends, runs `answer` (writes stdout, files) and exits 0. */
function fakeCli(answer: (input: string, child: ChildProcessWithoutNullStreams) => void): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcessWithoutNullStreams>
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  Object.assign(child, { stdin, stdout, stderr, killed: false, kill: () => true })
  let input = ''
  stdin.on('data', (chunk: Buffer) => { input += chunk.toString() })
  stdin.on('end', () => { answer(input, child as ChildProcessWithoutNullStreams); setTimeout(() => child.emit('exit', 0), 5) })
  return child as ChildProcessWithoutNullStreams
}

const model = (id: string, efforts: string[]): ModelOption => ({ id, label: id, description: '', efforts: efforts as ModelOption['efforts'], recommendedFor: [], defaultEffort: null })

describe('commit message suggestion', () => {
  it('keeps only the first line, without quotes', () => {
    expect(commitLine('\n  "feat(#ASF-1): Cria a tela"\nexplicação')).toBe('feat(#ASF-1): Cria a tela')
    expect(commitLine('   ')).toBe('')
  })

  it('picks the lightest Codex model with its lowest effort', () => {
    expect(cheapestCodexModel([model('gpt-6', ['low', 'high']), model('gpt-6-mini', ['low', 'medium']), model('gpt-6-nano', ['minimal', 'low'])])).toEqual({ id: 'gpt-6-nano', effort: 'minimal' })
    expect(cheapestCodexModel([model('gpt-6', ['low']), model('gpt-6-codex-mini', ['medium', 'low'])])).toEqual({ id: 'gpt-6-codex-mini', effort: 'low' })
    expect(cheapestCodexModel([model('gpt-6', ['low'])])).toBeNull()
    expect(cheapestCodexModel([])).toBeNull()
  })

  it('Claude: Haiku, with the repository convention in the prompt', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    let prompt = ''
    const processes: ProcessFactory = { start(command, args) { calls.push({ command, args }); return fakeCli((input, child) => { prompt = input; (child.stdout as PassThrough).write('feat(#ASF-9): Cria a tela\n') }) } }
    const message = await suggestCommitMessage({ executablePath: 'claude', configDir: '' } as unknown as AgentProfile, 'Padrão de commit do repositório (siga-o): ...', processes)
    expect(message).toBe('feat(#ASF-9): Cria a tela')
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['--model', 'haiku']))
    expect(prompt).toContain('Siga o padrão de commit do repositório'); expect(prompt).toContain('Padrão de commit do repositório (siga-o)')
  })

  it('Codex: exec with the cheapest cached model, read-only, reading the last message file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gearmod-codex-')); roots.push(home)
    await writeFile(join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6', supported_reasoning_levels: [{ effort: 'low' }] }, { slug: 'gpt-6-mini', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] }] }))
    let args: string[] = []
    const processes: ProcessFactory = { start(_command, received) {
      args = received
      return fakeCli((_input, child) => { (child.stdout as PassThrough).write('log de progresso\n'); writeFileSync(received[received.indexOf('--output-last-message') + 1]!, 'fix: Corrige o limite\n') })
    } }
    const message = await suggestCommitMessageCodex({ executablePath: 'codex', configDir: home } as unknown as AgentProfile, 'contexto', processes)
    expect(message).toBe('fix: Corrige o limite')
    expect(args.slice(0, 1)).toEqual(['exec'])
    expect(args).toEqual(expect.arrayContaining(['--model', 'gpt-6-mini', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', 'model_reasoning_effort="low"']))
    expect(args.at(-1)).toBe('-')
  })
})
