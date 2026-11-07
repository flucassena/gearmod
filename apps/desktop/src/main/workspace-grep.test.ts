import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { grepProject, posixRegex } from './workspace-grep'

const exec = promisify(execFile), dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
const base = { caseSensitive: false, wholeWord: false, regex: false }
async function repository(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gearmod-grep-'))); dirs.push(root)
  await exec('git', ['init', '-q', '-b', 'main', root]); await exec('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', root, 'config', 'user.name', 'Test'])
  await mkdir(join(root, 'src')); await writeFile(join(root, '.gitignore'), 'ignorado.txt\n')
  await writeFile(join(root, 'src', 'a.ts'), 'const total = 1\nconst Totalizador = 2\nlet subtotal = 3\n'); await writeFile(join(root, 'README.md'), 'o total aqui\n')
  await exec('git', ['-C', root, 'add', '-A']); await exec('git', ['-C', root, 'commit', '-qm', 'base'])
  await writeFile(join(root, 'ignorado.txt'), 'total escondido\n'); await writeFile(join(root, 'novo.ts'), 'total novo\n')
  return root
}

describe('posixRegex', () => {
  it('turns \\w, \\d and \\s into POSIX classes, also inside brackets, and keeps the other escapes', () => {
    expect(posixRegex(String.raw`const \w+ = \d`)).toBe('const [[:alnum:]_]+ = [0-9]')
    expect(posixRegex(String.raw`\W\D\S`)).toBe('[^[:alnum:]_][^0-9][^[:space:]]')
    expect(posixRegex(String.raw`[\w.-]+@\s`)).toBe('[[:alnum:]_.-]+@[[:space:]]')
    expect(posixRegex(String.raw`a\.b\(c\)`)).toBe(String.raw`a\.b\(c\)`)
    expect(posixRegex(String.raw`[^\d] [[:upper:]\s] []x]`)).toBe('[^0-9] [[:upper:][:space:]] []x]')
  })
})

describe('grepProject', () => {
  it('finds plain text, ignores what .gitignore hides and includes new files', async () => {
    const root = await repository(), { results } = await grepProject([root], { ...base, query: 'total' })
    expect(results.map((item) => `${item.path.slice(root.length + 1).replace(/\\/g, '/')}:${item.line}`).sort()).toEqual(['README.md:1', 'novo.ts:1', 'src/a.ts:1', 'src/a.ts:2', 'src/a.ts:3'])
    const first = results.find((item) => item.path.endsWith('README.md'))!
    expect(first.preview.slice(first.matchStart, first.matchEnd)).toBe('total'); expect(first.column).toBe(3)
  })
  it('whole word and case sensitivity', async () => {
    const root = await repository()
    const whole = await grepProject([root], { ...base, query: 'total', wholeWord: true })
    expect(whole.results.map((item) => item.line).sort()).toEqual([1, 1, 1]); expect(whole.results.some((item) => item.preview.includes('subtotal'))).toBe(false)
    const sensitive = await grepProject([root], { ...base, query: 'Total', caseSensitive: true })
    expect(sensitive.results.map((item) => item.preview)).toEqual(['const Totalizador = 2'])
  })
  it('regex, file filter and invalid regex', async () => {
    const root = await repository()
    expect((await grepProject([root], { ...base, query: 'const \\w+ = [12]', regex: true })).results.length).toBe(2)
    expect((await grepProject([root], { ...base, query: 'total', include: 'src/*.ts' })).results.every((item) => item.path.includes('src'))).toBe(true)
    await expect(grepProject([root], { ...base, query: '(', regex: true })).rejects.toThrow('Expressão regular inválida')
  })
  it('a root without Git is walked, skipping node_modules, and nested roots are not duplicated', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'gearmod-grep-plain-'))); dirs.push(root)
    await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules', 'x.js'), 'alvo'); await writeFile(join(root, 'a.txt'), 'um alvo\n')
    const found = await grepProject([root, root], { ...base, query: 'alvo' })
    expect(found.results.map((item) => item.path)).toEqual([join(root, 'a.txt')])
  })
})
