import { unlinkSync, existsSync, statSync } from 'fs'
import { resolve, normalize } from 'path'
import { t } from '../i18n/index'
import type { ToolDefinition } from './types'
import { isPathWritable } from './scope-check'

export const deleteFileTool: ToolDefinition = {
  name: 'delete_file',
  description: 'Delete a file from the filesystem.',
  tags: ['file'],
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
    const scopeCheck = isPathWritable(ctx.baseDir, path, ctx.scope)
    if (!scopeCheck.allowed) {
      return { success: false, output: t('file.path_not_allowed', { path: `${path} — ${scopeCheck.reason}` }) }
    }
    if (!existsSync(resolved)) {
      return { success: false, output: t('file.notfound', { path }) }
    }
    if (statSync(resolved).isDirectory()) {
      return { success: false, output: t('file.is_directory', { path }) }
    }
    unlinkSync(resolved)
    return { success: true, output: t('file.deleted', { path }) }
  },
}
