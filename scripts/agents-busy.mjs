// Prints how many agent runs and automated test runs are working now in the GearMod data (0 = safe to close the app).
// Usage: node scripts/agents-busy.mjs [path to gearmod.sqlite]   (default: %APPDATA%\GearMod\data\gearmod.sqlite)
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const file = process.argv[2] ?? join(process.env.APPDATA ?? '', 'GearMod', 'data', 'gearmod.sqlite')
if (!existsSync(file)) { console.log(0); process.exit(0) }
const db = new DatabaseSync(file, { readOnly: true })
const count = (sql) => { try { return Number(db.prepare(sql).get().n) || 0 } catch { return 0 } }
const runs = count("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')")
const tests = count("SELECT COUNT(*) AS n FROM test_runs WHERE status = 'running'")
db.close()
console.log(runs + tests)
