import { execFileSync, execSync } from 'child_process'
import { resolve } from 'path'
import { t } from '../i18n/index'
import type { ToolDefinition } from './types'
import { logBashCommand } from '../modules/security/audit-log'

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

    // Build rg arguments as an array to avoid shell interpretation of regex
    // metacharacters like |, (, ) — these are regex patterns, not shell operators.
    const rgArgs = ['-n', '--with-filename', pattern, searchPath]
    if (args.include) {
      rgArgs.push('-g', String(args.include))
    }

    // Log the search (sanitized) for audit purposes
    logBashCommand(ctx.sessionId, `rg ${rgArgs.join(' ')}`, false, 'grep-tool')

    try {
      const output = execFileSync('rg', rgArgs, {
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        cwd: ctx.baseDir,
      })
      return { success: true, output: output || t('file.no_matches') }
    } catch (e: any) {
      if (e.status === 1) return { success: true, output: t('file.no_matches') }
      // Fall back to plain grep -r when rg is not available or fails
      try {
        const cmd = `grep -rn "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`
        const output = execSync(cmd, {
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
          cwd: ctx.baseDir,
        })
        return { success: true, output: output || t('file.no_matches') }
      } catch (e2: any) {
        if (e2.status === 1) return { success: true, output: t('file.no_matches') }
        return { success: false, output: t('error.grep_failed', { message: e2.message }) }
      }
    }
  },
}
