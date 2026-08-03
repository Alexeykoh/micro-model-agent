import { globSync } from 'fs'
import { t } from '../i18n/index'
import type { ToolDefinition } from './types'

const MAX_PREVIEW_LINES = 25

export const globTool: ToolDefinition = {
  name: 'glob',
  description: `Search for files matching a glob pattern. Shows up to ${MAX_PREVIEW_LINES} results by default. Uses standard glob syntax (e.g., **/*.ts, src/**/*.test.ts).`,
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
    if (results.length === 0) {
      return { success: true, output: t('file.no_matches') }
    }
    const truncated = results.length > MAX_PREVIEW_LINES
      ? `\n... (${results.length - MAX_PREVIEW_LINES} more files)`
      : ''
    return { success: true, output: results.slice(0, MAX_PREVIEW_LINES).join('\n') + truncated }
  },
}
