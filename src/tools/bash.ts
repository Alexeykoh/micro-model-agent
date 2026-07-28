import { execSync } from 'child_process'
import type { ToolDefinition } from './types'

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'Execute a shell command and return its output. Use for running tests, build, git, and shell operations.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      workdir: { type: 'string', description: 'Working directory (default: baseDir)' },
    },
    required: ['command'],
  },
  handler: async (ctx, args) => {
    const command = String(args.command)
    const workdir = args.workdir ? String(args.workdir) : ctx.baseDir
    try {
      const output = execSync(command, {
        cwd: workdir,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      })
      return { success: true, output: output.trimEnd() }
    } catch (e: any) {
      const stderr = e.stderr?.toString() || ''
      const stdout = e.stdout?.toString() || ''
      return { success: false, output: stderr || stdout || e.message }
    }
  },
}
