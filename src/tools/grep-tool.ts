import { execSync } from 'child_process'
import { resolve } from 'path'
import { t } from '../i18n/index'
import type { ToolDefinition } from './types'
import { isCommandAllowed, sanitizeCommandForLog } from '../modules/security/command-validator'
import { logBashCommand, logSecurityBlock } from '../modules/security/audit-log'

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
    
    // Build grep command
    let cmd = `rg -n "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`
    if (args.include) {
      cmd += ` -g "${String(args.include)}"`
    }
    
    // Security check: validate command (grep/rg should be allowed)
    const securityConfig = ctx.config.security?.bash
    const validation = isCommandAllowed(cmd, securityConfig)
    
    if (!validation.allowed) {
      logSecurityBlock(
        ctx.sessionId,
        "bash_command",
        validation.reason || "Command blocked by security policy",
        sanitizeCommandForLog(cmd),
      );
      return {
        success: false,
        output: `[SECURITY BLOCKED] Command is not allowed: ${validation.reason}`,
      }
    }
    
    try {
      const output = execSync(cmd, { 
        encoding: 'utf-8', 
        maxBuffer: 1024 * 1024,
        cwd: ctx.baseDir,
      })
      return { success: true, output: output || t('file.no_matches') }
    } catch (e: any) {
      if (e.status === 1) return { success: true, output: t('file.no_matches') }
      return { success: false, output: t('error.grep_failed', { message: e.message }) }
    }
  },
}
