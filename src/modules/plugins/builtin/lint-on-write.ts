import type { AgentPlugin } from '../../types'
import type { ToolContext, ToolCall, ToolResult } from '../../../tools/types'
import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { resolve, extname, join } from 'path'

export class LintOnWritePlugin implements AgentPlugin {
  name = 'lint-on-write'
  priority = 10

  async onAfterTool(ctx: ToolContext, call: ToolCall, result: ToolResult): Promise<void> {
    if (call.name !== 'write_file' && call.name !== 'edit_file') {
      return
    }

    if (!result.success) {
      return
    }

    const path = String(call.arguments.path || '')
    if (!path) return

    const fullPath = resolve(ctx.baseDir, path)
    if (!existsSync(fullPath)) return

    const ext = extname(fullPath)
    const syntaxError = this.checkSyntax(fullPath, ext, ctx.baseDir)

    if (syntaxError) {
      result.output += `\n\n[Syntax check failed]: ${syntaxError}`
      return
    }

    await this.runProjectLint(ctx, result)
  }

  private checkSyntax(filePath: string, ext: string, baseDir: string): string | null {
    if (ext === '.ts' || ext === '.tsx') {
      try {
        execSync(`npx tsc --noEmit --skipLibCheck "${filePath}"`, { cwd: baseDir, stdio: 'pipe', timeout: 10000 })
        return null
      } catch (err: any) {
        if (err.status === 127 || err.message.includes('not found') || err.message.includes('ENOENT')) {
          return null
        }
        const stderr = err.stderr?.toString() || err.stdout?.toString() || ''
        if (stderr.includes('error TS') && !stderr.includes('Cannot find module')) {
          const firstError = stderr.split('\n').find((line: string) => line.includes('error TS')) || 'TypeScript syntax error'
          return firstError.trim()
        }
        return null
      }
    }

    if (ext === '.js' || ext === '.jsx') {
      try {
        execSync(`node --check "${filePath}"`, { cwd: baseDir, stdio: 'pipe', timeout: 5000 })
        return null
      } catch (err: any) {
        const stderr = err.stderr?.toString() || ''
        const firstError = stderr.split('\n').find((line: string) => line.trim()) || 'JavaScript syntax error'
        return firstError.trim()
      }
    }

    return null
  }

  private async runProjectLint(ctx: ToolContext, result: ToolResult): Promise<void> {
    try {
      const packageJsonPath = join(ctx.baseDir, 'package.json')
      if (!existsSync(packageJsonPath)) {
        return
      }

      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
      const lintScript = packageJson.scripts?.lint

      if (!lintScript) {
        return
      }

      ctx.logger.debug(`Running lint: ${lintScript}`)
      execSync(lintScript, { cwd: ctx.baseDir, stdio: 'pipe' })
      ctx.logger.debug('Lint passed')
    } catch (err: any) {
      ctx.logger.warn(`Lint failed: ${err.message}`)
      result.output += `\n\n[Project lint failed]: ${err.message}`
    }
  }
}

export const plugin = new LintOnWritePlugin()
