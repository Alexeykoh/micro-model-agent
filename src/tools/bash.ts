import type { ToolDefinition } from './types'
import { isCommandAllowed, sanitizeCommandForLog } from '../modules/security/command-validator'
import { logBashCommand, logSecurityBlock } from '../modules/security/audit-log'
import { getSessionSecurityConfig } from '../modules/security/session-isolation'
import { DEFAULT_SECURITY_CONFIG } from '../config/security'
import { runCommand, processRegistry, isLongRunningCommand } from '../modules/processes'
import { t } from '../i18n/index'
import { platform } from 'os'
import { MAX_PREVIEW_LINES } from './preview'

const BASH_TIMEOUT_MS = 120_000

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

  // No encoding adaptation needed — runner.ts handles UTF-8 decoding
  return command
}

/** Common Unix → Windows command mapping for error hints. */
const UNIX_TO_WIN_HINTS: Record<string, string> = {
  'ls': 'Use "dir" or the list_dir tool instead.',
  'pwd': 'Use "echo %cd%" or the file_info tool instead.',
  'cat': 'Use "type" or the read_file tool instead.',
  'cp': 'Use "copy" or the move_file tool instead.',
  'mv': 'Use "move" or the move_file tool instead.',
  'rm': 'Use "del" or the delete_file tool instead.',
  'grep': 'Use "findstr" or the grep tool instead.',
  'chmod': 'Use icacls or the chmod tool instead.',
  'touch': 'Use type nul > file or the write_file tool instead.',
  'find': 'Use "dir /s" or the glob tool instead.',
  'head': 'Use the read_file tool with offset/limit instead.',
  'tail': 'Use the read_file tool instead.',
  'wc': 'Use the read_file tool instead.',
  'diff': 'Use the diff tool instead.',
  'which': 'Use "where" instead.',
  'echo': 'echo works on Windows, but avoid pipes (|).',
};

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'Execute a shell command and return its output. Use for running tests, build, git, and shell operations. Long-running commands (dev servers, watchers) start in the background and return a process id immediately — manage them with process_list, process_log, process_kill. Set background=true to force background execution.',
  tags: ['shell', 'code'],
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      workdir: { type: 'string', description: 'Working directory (default: baseDir)' },
      background: { type: 'boolean', description: 'Start the command in the background and return immediately with a process id (default: auto-detect long-running commands)' },
    },
    required: ['command'],
  },
  handler: async (ctx, args) => {
    const originalCommand = String(args.command)
    const command = adaptCommandForWindows(originalCommand)
    const workdir = args.workdir ? String(args.workdir) : ctx.baseDir

    // Get session-specific security config with defaults
    const appConfig = ctx.config || {}
    const fullSecurityConfig = ctx.sessionContext 
      ? getSessionSecurityConfig(appConfig, ctx.sessionContext)
      : appConfig.security || DEFAULT_SECURITY_CONFIG
    const securityConfig = fullSecurityConfig.bash || DEFAULT_SECURITY_CONFIG.bash
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
        output: `[SECURITY BLOCKED] Command is not allowed: ${validation.reason}\nHint: Use the "workdir" parameter to run commands in a specific directory instead of "cd dir && cmd". Run one command per tool call.`,
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

    const background = args.background === true || isLongRunningCommand(command)

    if (background) {
      const entry = processRegistry.start(command, workdir, ctx.sessionId)
      if (securityConfig?.logCommands) {
        logBashCommand(
          ctx.sessionId,
          sanitizeCommandForLog(command),
          true,
          `Started in background: ${entry.id} (PID ${entry.pid})`,
        )
      }
      const explicit = args.background === true
      return {
        success: true,
        output: `${t("proc.started", {
          id: entry.id,
          pid: entry.pid,
          command,
        })}${explicit ? "" : `\n${t("proc.detected_hint")}`}\n${t("proc.manage_hint", {
          id: entry.id,
        })}`,
      }
    }

    try {
      const res = await runCommand(command, {
        cwd: workdir,
        callId: ctx.activeCallId,
        timeoutMs: BASH_TIMEOUT_MS,
      })
      const parts = [res.stdout.trimEnd(), res.stderr.trimEnd()].filter(Boolean)
      let output = parts.join("\n")
      if (res.timedOut) {
        output = `${output ? output + "\n" : ""}${t("proc.timed_out", {
          ms: BASH_TIMEOUT_MS,
        })}`
      } else if (!output && res.code !== 0) {
        output = `(exit code ${res.code})`
      }

      // On Windows, hint about Unix commands that don't work
      if (platform() === 'win32' && res.code !== 0) {
        const firstWord = command.trim().split(/\s+/)[0]?.split(/[\\/]/).pop()
        const hint = firstWord ? UNIX_TO_WIN_HINTS[firstWord] : undefined
        if (hint) {
          output = `${output}\n\nHint: "${firstWord}" may not work on Windows. ${hint}`
        }
      }

      // Update audit log with result
      if (securityConfig?.logCommands) {
        logBashCommand(
          ctx.sessionId,
          sanitizeCommandForLog(command),
          res.code === 0,
          `Working directory: ${workdir}, Output length: ${res.stdout.length}`,
        )
      }

      const lines = output.split('\n')
      if (lines.length > MAX_PREVIEW_LINES) {
        output = lines.slice(0, MAX_PREVIEW_LINES).join('\n') + `\n... (${lines.length - MAX_PREVIEW_LINES} more lines)`
      }

      return { success: res.code === 0, output }
    } catch (e: any) {
      // Update audit log with failure
      if (securityConfig?.logCommands) {
        logBashCommand(
          ctx.sessionId,
          sanitizeCommandForLog(command),
          false,
          `Working directory: ${workdir}, Error: ${e.message?.slice(0, 100) || ""}`,
        )
      }
      return { success: false, output: e.message || String(e) }
    }
  },
}
