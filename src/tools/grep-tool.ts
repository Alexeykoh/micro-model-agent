import { execSync } from 'child_process'
import { resolve } from 'path'
import { t } from '../i18n/index'
import type { ToolDefinition } from './types'

export const grepTool: ToolDefinition = {
  name: 'grep',
  description: 'Search file contents using a regular expression. Uses ripgrep (rg) if available, otherwise falls back to grep -r.',
  tags: ['file', 'code', 'research'],
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search' },
      include: { type: 'string', description: 'File pattern to filter (e.g. *.ts)' },
      path: { type: 'string', description: 'Directory to search (defaults to baseDir)' },
    },
    required: ['pattern'],
  },
  handler: async (ctx, args) => {
    const pattern = String(args.pattern)
    const searchPath = args.path ? resolve(ctx.baseDir, String(args.path)) : ctx.baseDir
    try {
      let cmd = `rg -n "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`
      if (args.include) {
        cmd += ` -g "${String(args.include)}"`
      }
      const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 })
      return { success: true, output: output || t('file.no_matches') }
    } catch (e: any) {
      if (e.status === 1) return { success: true, output: t('file.no_matches') }
      return { success: false, output: t('error.grep_failed', { message: e.message }) }
    }
  },
}
