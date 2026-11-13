import { describe, expect, it } from 'vitest'
import { isMcpTool, mcpToolsFor } from './mcp-tools'

const names = (purpose: Parameters<typeof mcpToolsFor>[0], codeIndex = true): string[] => mcpToolsFor(purpose, codeIndex).map((tool) => tool.name)

describe('MCP tool catalog', () => {
  it('lists only the tools of the conversation role', () => {
    expect(names('constitution')).toEqual(['gearmod_read_skill', 'gearmod_create_card', 'gearmod_read_constitution', 'gearmod_write_constitution'])
    expect(names('planning')).toContain('gearmod_finish_planning')
    expect(names('execution')).not.toContain('gearmod_finish_planning')
    expect(names('test')).toContain('gearmod_test_checklist')
  })

  it('leaves the code tools out when the code index is off for the project', () => {
    expect(names('execution')).toContain('gearmod_code_explore')
    expect(names('execution', false).some((name) => name.startsWith('gearmod_code_'))).toBe(false)
  })

  it('marks what only reads, and nothing as destructive or open-world', () => {
    const tools = mcpToolsFor('execution', true)
    expect(tools.find((tool) => tool.name === 'gearmod_code_explore')?.annotations?.readOnlyHint).toBe(true)
    expect(tools.find((tool) => tool.name === 'gearmod_write_document')?.annotations?.readOnlyHint).toBe(false)
    expect(tools.every((tool) => tool.annotations?.destructiveHint === false && tool.annotations.openWorldHint === false)).toBe(true)
  })

  it('knows every tool name of the catalog, and only those', () => {
    expect(isMcpTool('gearmod_request_commit')).toBe(true)
    expect(isMcpTool('gearmod_does_not_exist')).toBe(false)
  })
})
