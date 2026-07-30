import { globSync } from 'fs'
import { t } from '../i18n/index'
import type { ToolDefinition } from './types'

export const globTool: ToolDefinition = {
  name: 'glob',
  description: 'Search for files matching a glob pattern. Uses standard glob syntax (e.g., **/*.ts, src/**/*.test.ts).',
  tags: ['file', 'code', 'research'],
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
    },
    required: ['pattern'],
  },
  handler: async (ctx, args) => {
    const pattern = String(args.pattern)
    const results = globSync(pattern, { cwd: ctx.baseDir })
    return { success: true, output: results.length > 0 ? results.join('\n') : t('file.no_matches') }
  },
}
