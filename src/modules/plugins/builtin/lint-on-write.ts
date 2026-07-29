import type { AgentPlugin } from '../../types'
import type { ToolContext } from '../../../tools/types'
import type { ToolResult } from '../../../tools/types'
import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export class LintOnWritePlugin implements AgentPlugin {
  name = 'lint-on-write'
  priority = 10

  async onAfterTool(ctx: ToolContext, result: ToolResult & { toolName?: string }): Promise<void> {
    if (result.toolName !== 'write_file' && result.toolName !== 'edit_file') {
      return
    }

    if (!result.success) {
      return
    }

    try {
      const packageJsonPath = join(ctx.baseDir, 'package.json')
      if (!existsSync(packageJsonPath)) {
        ctx.logger.debug('No package.json found, skipping lint')
        return
      }

      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
      const lintScript = packageJson.scripts?.lint

      if (!lintScript) {
        ctx.logger.debug('No lint script in package.json, skipping')
        return
      }

      ctx.logger.debug(`Running lint: ${lintScript}`)
      execSync(lintScript, { cwd: ctx.baseDir, stdio: 'pipe' })
      ctx.logger.debug('Lint passed')
    } catch (err: any) {
      ctx.logger.warn(`Lint failed: ${err.message}`)
    }
  }
}

export const plugin = new LintOnWritePlugin()
