import { statSync, existsSync } from 'fs'
import { resolve, normalize } from 'path'
import { t } from '../i18n/index'
import type { ToolDefinition } from './types'
import { isPathInScope } from '../modules/security/path-validator'

export const fileInfoTool: ToolDefinition = {
  name: 'file_info',
  description: 'Get metadata about a file or directory (size, creation date, modification date).',
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
      return { success: false, output: t('file.not_found_short', { path }) }
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
