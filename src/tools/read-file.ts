import { readFileSync, existsSync } from 'fs'
import { resolve, normalize } from 'path'
import { t } from '../i18n/index'
import type { ToolDefinition } from './types'

function isPathSafe(baseDir: string, targetPath: string): boolean {
  const resolved = resolve(baseDir, normalize(targetPath))
  return resolved.startsWith(resolve(baseDir))
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file from the filesystem. Optionally specify offset (line number) and limit (number of lines, default all).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
      offset: { type: 'number', description: 'Starting line (1-indexed)' },
      limit: { type: 'number', description: 'Number of lines to read' },
    },
    required: ['path'],
  },
  handler: async (ctx, args) => {
    const path = String(args.path)
    if (!isPathSafe(ctx.baseDir, path)) {
      return { success: false, output: t('file.path_not_allowed', { path }) }
    }
    const resolved = resolve(ctx.baseDir, normalize(path))
    if (!existsSync(resolved)) {
      return { success: false, output: t('file.notfound', { path }) }
    }
    const content = readFileSync(resolved, 'utf-8')
    if (!args.offset && !args.limit) {
      return { success: true, output: content }
    }
    const lines = content.split('\n')
    const offset = (args.offset as number) || 1
    const limit = (args.limit as number) || lines.length
    const selected = lines.slice(offset - 1, offset - 1 + limit).join('\n')
    return { success: true, output: selected }
  },
}
