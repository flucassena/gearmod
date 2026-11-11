import { describe, expect, it } from 'vitest'
import { hasNewDescendant, parseElapsed } from './process-tree'

describe('background command liveness', () => {
  const tree = [
    { pid: 10, ppid: 1, startedAt: 1_000 },        // agent
    { pid: 11, ppid: 10, startedAt: 1_100 },       // MCP server, started with the agent
    { pid: 12, ppid: 10, startedAt: 50_000 },      // shell of the background command
    { pid: 13, ppid: 12, startedAt: 50_100 },      // the command itself
    { pid: 20, ppid: 1, startedAt: 60_000 }        // unrelated process
  ]
  it('finds a process the agent started after the task began', () => {
    expect(hasNewDescendant(tree, 10, 49_000)).toBe(true)
  })
  it('ignores older children and processes outside the agent tree', () => {
    expect(hasNewDescendant(tree.filter((item) => item.pid !== 12 && item.pid !== 13), 10, 49_000)).toBe(false)
  })
  it('ignores the hidden Windows console host of the agent', () => {
    expect(hasNewDescendant([{ pid: 10, ppid: 1, startedAt: 1_000 }, { pid: 14, ppid: 10, startedAt: 50_000, name: 'conhost.exe' }], 10, 49_000)).toBe(false)
  })
  it('reads ps elapsed times', () => {
    expect(parseElapsed('05:03')).toBe(303)
    expect(parseElapsed('2:00:01')).toBe(7201)
    expect(parseElapsed('1-00:00:10')).toBe(86410)
  })
})
