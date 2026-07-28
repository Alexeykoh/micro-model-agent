import { unlinkSync, existsSync, statSync } from 'fs'
import { resolve, normalize } from 'path'
import type { ToolDefinition } from './types'

export const deleteFileTool: ToolDefinition = {
  name: 'delete_file',
  description: 'Delete a file from the filesystem.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
    },
    required: ['path'],
  },
  handler: async (ctx, args) => {
    const path = String(args.path)
    const baseDir = resolve(ctx.baseDir)
    const resolved = resolve(baseDir, normalize(path))
    if (!resolved.startsWith(baseDir)) {
      return { success: false, output: `Path not allowed: ${path}` }
    }
    if (!existsSync(resolved)) {
      return { success: false, output: `File not found: ${path}` }
    }
    if (statSync(resolved).isDirectory()) {
      return { success: false, output: `Is a directory, use rmdir: ${path}` }
    }
    unlinkSync(resolved)
    return { success: true, output: `Deleted ${path}` }
  },
}