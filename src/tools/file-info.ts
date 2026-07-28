import { statSync, existsSync } from 'fs'
import { resolve, normalize } from 'path'
import type { ToolDefinition } from './types'

export const fileInfoTool: ToolDefinition = {
  name: 'file_info',
  description: 'Get metadata about a file or directory (size, creation date, modification date).',
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
      return { success: false, output: `Not found: ${path}` }
    }
    const stat = statSync(resolved)
    return {
      success: true,
      output: JSON.stringify({
        path,
        size: stat.size,
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        created: stat.birthtime,
        modified: stat.mtime,
      }, null, 2),
    }
  },
}