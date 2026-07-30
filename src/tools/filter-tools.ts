import type { ToolDefinition } from './types'

export function filterToolsByTags(tools: ToolDefinition[], toolTags: string[]): ToolDefinition[] {
  if (!toolTags || toolTags.length === 0) return tools
  const tagSet = new Set(toolTags)
  return tools.filter(t => {
    if (!t.tags || t.tags.length === 0) return false
    return t.tags.some(tag => tagSet.has(tag))
  })
}
