import { renameSync, existsSync } from 'fs'
import { resolve, normalize } from 'path'
import type { ToolDefinition } from './types'

export const moveFileTool: ToolDefinition = {
  name: 'move_file',
  description: 'Move or rename a file or directory.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source path' },
      to: { type: 'string', description: 'Destination path' },
    },
    required: ['from', 'to'],
  },
  handler: async (ctx, args) => {
    const fromPath = String(args.from)
    const toPath = String(args.to)
    const baseDir = resolve(ctx.baseDir)
    const fromResolved = resolve(baseDir, normalize(fromPath))
    const toResolved = resolve(baseDir, normalize(toPath))
    if (!fromResolved.startsWith(baseDir) || !toResolved.startsWith(baseDir)) {
      return { success: false, output: 'Path not allowed' }
    }
    if (!existsSync(fromResolved)) {
      return { success: false, output: `Not found: ${fromPath}` }
    }
    renameSync(fromResolved, toResolved)
    return { success: true, output: `Moved ${fromPath} → ${toPath}` }
  },
}