import { readFileSync, writeFileSync } from 'fs'
import { resolve, normalize } from 'path'
import type { ToolDefinition } from './types'

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: 'Find and replace text in an existing file. Uses exact string match (not regex).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old: { type: 'string', description: 'Text to replace' },
      new: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old', 'new'],
  },
  handler: async (ctx, args) => {
    const path = String(args.path)
    const baseDir = resolve(ctx.baseDir)
    const resolved = resolve(baseDir, normalize(path))
    if (!resolved.startsWith(baseDir)) {
      return { success: false, output: `Path not allowed: ${path}` }
    }
    const content = readFileSync(resolved, 'utf-8')
    const oldStr = String(args.old)
    const newStr = String(args.new)
    if (!content.includes(oldStr)) {
      return { success: false, output: `String not found in file:\n${oldStr}` }
    }
    const updated = content.replace(oldStr, newStr)
    writeFileSync(resolved, updated, 'utf-8')
    return { success: true, output: `Replaced in ${path}` }
  },
}
