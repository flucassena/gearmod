// Checks which published Spec Kit versions still fit what GearMod relies on and writes the verdicts to a JSON file.
//
//   node scripts/speckit-compat.mjs <speckit-compat.json>
//
// Run daily by .github/workflows/speckit-compat.yml. Every version is initialized in throwaway folders with `uv tool run ... specify init`
// (one per supported agent) and the result goes through the same `checkSpecKitContract` the app uses, so the app only has to read the verdicts.
// Versions already in the file are not probed again. Needs Node >= 22.18 (it imports the TypeScript contract directly) and `uv` on the PATH.
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { probeSpecKitVersion } from '../apps/desktop/src/main/spec-contract.ts'

const exec = promisify(execFile)
const out = process.argv[2] ?? 'speckit-compat.json'
const keep = Number(process.env.SPECKIT_COMPAT_KEEP ?? 12)

const headers = { accept: 'application/vnd.github+json', 'user-agent': 'gearmod-speckit-compat', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }
const response = await fetch('https://api.github.com/repos/github/spec-kit/releases?per_page=30', { headers, signal: AbortSignal.timeout(30_000) })
if (!response.ok) throw new Error(`Could not list the Spec Kit releases: HTTP ${response.status}`)
const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] }
const published = (await response.json())
  .filter((release) => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
  .map((release) => release.tag_name.slice(1))
  .sort((a, b) => compare(b, a))
  .slice(0, keep)

let previous = {}
if (existsSync(out)) { try { previous = JSON.parse(readFileSync(out, 'utf8')).versions ?? {} } catch { previous = {} } }

const run = async (command, args, cwd, timeout) => (await exec(command, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 })).stdout
const versions = { ...previous }
const newFailures = []
for (const version of published) {
  if (versions[version]) continue
  console.log(`Probing Spec Kit ${version}...`)
  const report = await probeSpecKitVersion(version, run)
  versions[version] = { ok: report.ok, checkedAt: report.checkedAt, issues: report.issues.map(({ severity, detail }) => ({ severity, detail })) }
  console.log(`  ${report.ok ? 'compatible' : 'NOT compatible'}${report.issues.length ? ` (${report.issues.length} issue(s))` : ''}`)
  for (const issue of report.issues) console.log(`    ${issue.severity}: ${issue.detail}`)
  if (!report.ok) newFailures.push(version)
}

// Keeps the newest versions only, so the file stays small.
const sorted = Object.keys(versions).sort((a, b) => compare(b, a)).slice(0, 40)
writeFileSync(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), versions: Object.fromEntries(sorted.map((version) => [version, versions[version]])) }, null, 2)}\n`)
console.log(`Wrote ${out} with ${sorted.length} version(s).`)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `new_failures=${newFailures.join(' ')}\n`)
