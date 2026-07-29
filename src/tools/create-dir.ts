import { mkdirSync, existsSync } from 'fs'
import { resolve, normalize } from 'path'
import { t } from '../i18n/index'
import type { ToolDefinition } from './types'

export const createDirTool: ToolDefinition = {
  name: 'create_dir',
  description: 'Create a directory (and any intermediate directories).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path' },
    },
    required: ['path'],
  },
  handler: async (ctx, args) => {
    const path = String(args.path)
    const baseDir = resolve(ctx.baseDir)
    const resolved = resolve(baseDir, normalize(path))
    if (!resolved.startsWith(baseDir)) {
      return { success: false, output: t('file.path_not_allowed', { path }) }
    }
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true })
    }
    return { success: true, output: t('file.created', { path }) }
  },
}
