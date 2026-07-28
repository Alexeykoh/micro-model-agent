import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, normalize, dirname } from 'path'
import type { ToolDefinition } from './types'

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Create or overwrite a file with given content. Creates intermediate directories if needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'File content' },
    },
    required: ['path', 'content'],
  },
  handler: async (ctx, args) => {
    const path = String(args.path)
    const baseDir = resolve(ctx.baseDir)
    const resolved = resolve(baseDir, normalize(path))
    if (!resolved.startsWith(baseDir)) {
      return { success: false, output: `Path not allowed: ${path}` }
    }
    const dir = dirname(resolved)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(resolved, String(args.content), 'utf-8')
    return { success: true, output: `Written ${path}` }
  },
}
