import { readdirSync, statSync, existsSync } from 'fs'
import { resolve, normalize } from 'path'
import { t } from '../i18n/index'
import type { ToolDefinition } from './types'
import { isPathInScope } from '../modules/security/path-validator'

export const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description: 'List files and directories in a given path.',
  tags: ['file'],
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
    
    // Check path permissions
    const scopeCheck = isPathInScope(ctx.baseDir, path, ctx.scope, ctx.config.security?.paths);
    if (!scopeCheck.allowed) {
      return {
        success: false,
        output: t('file.path_not_allowed', {
          path: `${path} — ${scopeCheck.reason}`,
        }),
      }
    }
    
    if (!existsSync(resolved)) {
      return { success: false, output: t('file.dir_notfound', { path }) }
    }
    const entries = readdirSync(resolved)
    const lines = entries.map(e => {
      const full = resolve(resolved, e)
      return statSync(full).isDirectory() ? `${e}/` : e
    })
    return { success: true, output: lines.join('\n') || t('file.empty') }
  },
}
