import { renameSync, existsSync } from 'fs'
import { resolve, normalize } from 'path'
import { t } from '../i18n/index'
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
      return { success: false, output: t('file.path_not_allowed_short') }
    }
    if (!existsSync(fromResolved)) {
      return { success: false, output: t('file.not_found_short', { path: fromPath }) }
    }
    renameSync(fromResolved, toResolved)
    return { success: true, output: t('file.moved', { from: fromPath, to: toPath }) }
  },
}
