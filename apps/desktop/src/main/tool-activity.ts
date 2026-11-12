type Json = Record<string, unknown>
const asObject = (value: unknown): Json => (value && typeof value === 'object' ? value as Json : {})
const short = (text: string, max: number): string => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat }

export interface ToolActivity { title: string; detail: string }

/** Summary of a tool used by the agent (for the gray line in the chat): short title + detail shown when expanded. */
function describe(name: string, input: Json): ToolActivity {
  const target = [input.file_path, input.path, input.pattern, input.command, input.url, input.query].find((value) => typeof value === 'string') as string | undefined
  const label = name.replace(/^mcp__gearmod__/, '')
  return { title: short(target ? `${label} ${target}` : label, 90), detail: short(JSON.stringify(input, null, 2), 800) }
}

/** Files the agent changed (Claude's write tools): used to notice work done in another card's worktree. */
export function toolEditedFiles(type: string, payload: Json): string[] {
  // Antigravity marks every editing tool with ACP kind `edit` (its names vary: write_file, replace_file_content…).
  if (type === 'gemini/tool_use') { const input = asObject(payload.parameters), file = input.file_path ?? input.path; return (payload.tool_kind === 'edit' || ['write_file', 'replace', 'edit'].includes(String(payload.tool_name))) && typeof file === 'string' ? [file] : [] }
  if (type !== 'claude/assistant') return []
  const content = asObject(payload.message).content
  return (Array.isArray(content) ? content : []).map(asObject)
    .filter((block) => block.type === 'tool_use' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(String(block.name)))
    .map((block) => asObject(block.input).file_path ?? asObject(block.input).notebook_path).filter((value): value is string => typeof value === 'string')
}

/** Extracts the tools used from a Claude event (`tool_use` in assistant messages) or a Codex event (started items). */
export function toolActivities(type: string, payload: Json): ToolActivity[] {
  if (type === 'gemini/tool_use' && typeof payload.tool_name === 'string') return [describe(payload.tool_name, asObject(payload.parameters))]
  if (type === 'claude/assistant') {
    const content = asObject(payload.message).content
    return (Array.isArray(content) ? content : []).map(asObject).filter((block) => block.type === 'tool_use' && typeof block.name === 'string').map((block) => describe(block.name as string, asObject(block.input)))
  }
  if (type === 'item/started') {
    const item = asObject(payload.item)
    if (item.type === 'commandExecution' && typeof item.command === 'string') return [{ title: short(`Comando ${item.command}`, 90), detail: short(item.command, 800) }]
    if (item.type === 'mcpToolCall' && typeof item.tool === 'string') return [describe(item.tool, asObject(item.arguments))]
    if (item.type === 'fileChange') return [{ title: 'Alterou arquivos', detail: '' }]
  }
  return []
}
