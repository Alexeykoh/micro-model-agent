import { execSync } from 'child_process'
import { platform } from 'os'
import type { ToolDefinition } from './types'
import { isCommandAllowed, sanitizeCommandForLog } from '../modules/security/command-validator'
import { logBashCommand, logSecurityBlock } from '../modules/security/audit-log'

function adaptCommandForWindows(command: string): string {
  if (platform() !== 'win32') return command

  // Windows mkdir does not support -p flag, but creates intermediate dirs by default
  const trimmed = command.trim()
  if (trimmed.startsWith('mkdir -p ')) {
    return trimmed.replace(/^mkdir -p /, 'mkdir ')
  }
  if (trimmed === 'mkdir -p' || trimmed.startsWith('mkdir -p ')) {
    return trimmed.replace(/mkdir -p/g, 'mkdir')
  }
  return command
}

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'Execute a shell command and return its output. Use for running tests, build, git, and shell operations.',
  tags: ['shell', 'code'],
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      workdir: { type: 'string', description: 'Working directory (default: baseDir)' },
    },
    required: ['command'],
  },
  handler: async (ctx, args) => {
    const originalCommand = String(args.command)
    const command = adaptCommandForWindows(originalCommand)
    const workdir = args.workdir ? String(args.workdir) : ctx.baseDir

    // Security check: validate command
    const securityConfig = ctx.config.security?.bash
    const validation = isCommandAllowed(command, securityConfig)
    
    if (!validation.allowed) {
      // Log security block
      logSecurityBlock(
        ctx.sessionId,
        "bash_command",
        validation.reason || "Command blocked by security policy",
        sanitizeCommandForLog(originalCommand),
      )
      
      return {
        success: false,
        output: `[SECURITY BLOCKED] Command is not allowed: ${validation.reason}`,
      }
    }

    // Log command execution if enabled
    if (securityConfig?.logCommands) {
      logBashCommand(
        ctx.sessionId,
        sanitizeCommandForLog(command),
        false, // Will be updated after execution
        `Working directory: ${workdir}`,
      )
    }

    try {
      const output = execSync(command, {
        cwd: workdir,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      })
      
      // Update audit log with success
      if (securityConfig?.logCommands) {
        logBashCommand(
          ctx.sessionId,
          sanitizeCommandForLog(command),
          true,
          `Working directory: ${workdir}, Output length: ${output.length}`,
        )
      }
      
      return { success: true, output: output.trimEnd() }
    } catch (e: any) {
      const stderr = e.stderr?.toString() || ''
      const stdout = e.stdout?.toString() || ''
      const errorOutput = stderr || stdout || e.message
      
      // Update audit log with failure
      if (securityConfig?.logCommands) {
        logBashCommand(
          ctx.sessionId,
          sanitizeCommandForLog(command),
          false,
          `Working directory: ${workdir}, Error: ${errorOutput.slice(0, 100)}`,
        )
      }
      
      return { success: false, output: errorOutput }
    }
  },
}
