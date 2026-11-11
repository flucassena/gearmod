import { createRequire } from 'node:module'
import * as nodeFs from 'node:fs'

// Inside Electron, `fs` treats every `.asar` file as a folder: deleting a worktree whose node_modules has Electron
// (dist/resources/default_app.asar) failed on that file and kept it open, so the folder never went away.
// `original-fs` is the same module without that; outside Electron (tests) it does not exist and plain `fs` is used.
const fs: typeof nodeFs = (() => { try { return createRequire(import.meta.url)('original-fs') as typeof nodeFs } catch { return nodeFs } })()

/** Deletes a folder (or file) recursively, without Electron's `.asar` handling; missing paths are fine. */
export function rmTree(path: string, retries = 3): Promise<void> {
  return fs.promises.rm(path, { recursive: true, force: true, maxRetries: retries, retryDelay: 300 })
}
