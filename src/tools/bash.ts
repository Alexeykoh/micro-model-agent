import type { ToolDefinition } from './types'
import { isCommandAllowed, sanitizeCommandForLog } from '../modules/security/command-validator'
import { logBashCommand, logSecurityBlock } from '../modules/security/audit-log'
import { getSessionSecurityConfig } from '../modules/security/session-isolation'
import { DEFAULT_SECURITY_CONFIG } from '../config/security'
import { processRegistry, registerKillable, unregisterKillable } from '../modules/processes'
import { t } from '../i18n/index'
import { platform } from 'os'
import { MAX_PREVIEW_LINES } from './preview'

/**
 * A command still running after this window is promoted to the background.
 * The decision is based on process *behavior* (still alive), not on matching
 * words in the command text — a command that happens to mention "vite",
 * "server", etc. runs normally, and any genuinely long-running command is
 * caught regardless of how it is written.
 */
export const BASH_GRACE_MS = 5000
/** Short window for explicit `background: true` — surfaces immediate spawn failures (bad cwd, missing shell). */
const SPAWN_SETTLE_MS = 100

let bashGraceMs = BASH_GRACE_MS
/** Test hook: override the auto-background grace window. */
export function setBashGraceMs(ms: number): void {
  bashGraceMs = ms
}

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

  // No encoding adaptation needed — registry.ts handles UTF-8/OEM decoding
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
  description: 'Execute a shell command and return its output. Use for running tests, build, git, and shell operations. Commands that are still running after a few seconds are automatically moved to the background and return a process id — manage them with process_list, process_log, process_kill. Set background=true to return a process id immediately for commands you know are long-running (dev servers, watchers).',
  tags: ['shell', 'code'],
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      workdir: { type: 'string', description: 'Working directory (default: baseDir)' },
      background: { type: 'boolean', description: 'Return a process id immediately without waiting (default: commands still running after a few seconds are auto-promoted to the background)' },
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

    const entry = processRegistry.start(command, workdir, ctx.sessionId)
    if (ctx.activeCallId) {
      // Let the executor abort/kill the child during the grace window.
      registerKillable(ctx.activeCallId, () => processRegistry.kill(entry.id))
    }

    try {
      const settleMs = args.background === true ? SPAWN_SETTLE_MS : bashGraceMs
      const exited = await processRegistry.waitForExit(entry.id, settleMs)

      if (exited) {
        // Command finished (or failed to spawn) within the window.
        if (entry.spawnError) {
          return {
            success: false,
            output: `[process error] ${entry.spawnError}\nHint: check the "workdir" path exists and the command is valid for this OS.`,
          }
        }

        const code = entry.exitCode
        let output = entry.log.join('\n')
        processRegistry.remove(entry.id)

        if (!output && code !== 0) {
          output = `(exit code ${code})`
        }

        // On Windows, hint about Unix commands that don't work
        if (platform() === 'win32' && code !== 0) {
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
            code === 0,
            `Working directory: ${workdir}, Output length: ${output.length}`,
          )
        }

        const lines = output.split('\n')
        if (lines.length > MAX_PREVIEW_LINES) {
          output = lines.slice(0, MAX_PREVIEW_LINES).join('\n') + `\n... (${lines.length - MAX_PREVIEW_LINES} more lines)`
        }

        return { success: code === 0, output }
      }

      // Still running — promote to a background process.
      const explicit = args.background === true
      const output = `${t('proc.started', {
        id: entry.id,
        pid: entry.pid,
        command,
      })}${explicit ? '' : `\n${t('proc.promoted_hint', { ms: settleMs })}`}\n${t('proc.manage_hint', {
        id: entry.id,
      })}`

      if (securityConfig?.logCommands) {
        logBashCommand(
          ctx.sessionId,
          sanitizeCommandForLog(command),
          true,
          `Started in background: ${entry.id} (PID ${entry.pid})`,
        )
      }

      return { success: true, output }
    } finally {
      if (ctx.activeCallId) {
        unregisterKillable(ctx.activeCallId)
      }
    }
  },
}
