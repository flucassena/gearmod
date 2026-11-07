import { defineConfig } from 'vitest/config'

// Git and SDD tests create real repositories; with the whole suite in parallel (and on CI machines) they exceed 30s.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000, setupFiles: ['./vitest.setup.ts'] } })
