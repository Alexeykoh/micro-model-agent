import type { ToolDefinition } from "./types";
import {
  isCommandAllowed,
  sanitizeCommandForLog,
} from "../modules/security/command-validator";
import {
  logBashCommand,
  logSecurityBlock,
} from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { DEFAULT_SECURITY_CONFIG } from "../config/security";
import {
  processRegistry,
  registerKillable,
  unregisterKillable,
} from "../modules/processes";
import { t } from "../i18n/index";
import { platform } from "os";
import { MAX_PREVIEW_LINES } from "./preview";

/**
 * A command still running after this window is promoted to the background.
 * The decision is based on process *behavior* (still alive), not on matching
 * words in the command text — a command that happens to mention "vite",
 * "server", etc. runs normally, and any genuinely long-running command is
 * caught regardless of how it is written.
 */
export const BASH_GRACE_MS = 5000;
/** Short window for explicit `background: true` — surfaces immediate spawn failures (bad cwd, missing shell). */
const SPAWN_SETTLE_MS = 100;

let bashGraceMs = BASH_GRACE_MS;
/** Test hook: override the auto-background grace window. */
export function setBashGraceMs(ms: number): void {
  bashGraceMs = ms;
}

function adaptCommandForWindows(command: string): string {
  if (platform() !== "win32") return command;

  // The model sometimes appends `|| true` (bash error-suppression idiom)
  // which PowerShell doesn't understand. Replace with `; exit 0` which
  // forces a successful exit code regardless of the previous command's result.
  if (/\|\|\s*true\b/.test(command)) {
    command = command.replace(/\s*\|\|\s*true\b/g, "; exit 0");
  }

  // Windows mkdir does not support -p flag, but creates intermediate dirs by default
  const trimmed = command.trim();
  if (trimmed.startsWith("mkdir -p ")) {
    return trimmed.replace(/^mkdir -p /, "mkdir ");
  }
  if (trimmed === "mkdir -p" || trimmed.startsWith("mkdir -p ")) {
    return trimmed.replace(/mkdir -p/g, "mkdir");
  }

  // Translate simple Unix commands to their cmd.exe equivalents. Only the
  // leading word is rewritten; flags are passed through (ls -la → dir -la,
  // which cmd tolerates). Pipe-using forms are left alone — they would break.
  const firstWord = trimmed.split(/\s+/)[0]?.split(/[\\/]/).pop();
  const translated = firstWord ? UNIX_TO_WIN_TRANSLATE[firstWord] : undefined;
  if (
    translated &&
    !trimmed.includes("|") &&
    !trimmed.includes(">") &&
    !trimmed.includes("&&") &&
    !trimmed.includes(";")
  ) {
    return trimmed.replace(firstWord!, translated);
  }

  // No encoding adaptation needed — registry.ts handles UTF-8/OEM decoding
  return command;
}

/** Common Unix → Windows command mapping for error hints. */
const UNIX_TO_WIN_HINTS: Record<string, string> = {
  ls: "Use the list_dir tool instead.",
  pwd: "Use the file_info tool instead.",
  cat: "Use the read_file tool instead.",
  cp: "Use the move_file tool instead.",
  mv: "Use the move_file tool instead.",
  rm: "Use the delete_file tool instead.",
  grep: "Use the grep tool instead.",
  chmod: "Use the chmod tool instead.",
  touch: "Use the write_file tool instead.",
  find: "Use the glob tool instead.",
  head: "Use the read_file tool with offset/limit instead.",
  tail: "Use the read_file tool instead.",
  wc: "Use the read_file tool instead.",
  diff: "Use the diff tool instead.",
  which: 'Use "where" instead.',
  echo: "echo works on Windows, but avoid pipes (|).",
  "Get-Content": "Use the read_file tool instead.",
  "Select-Object": "Use the read_file tool with offset/limit instead.",
};

/** Unix commands that can be transparently translated to PowerShell equivalents. */
const UNIX_TO_WIN_TRANSLATE: Record<string, string> = {
  ls: "Get-ChildItem",
  pwd: "Get-Location",
  cat: "Get-Content",
  wc: "@(Get-Content).Count",
};

/**
 * Detect when the model mistakes a tool call for a shell command — e.g.
 * `bash` with command "create_dir path=C:\...\src" or "read_file file=x".
 * These are tool invocations, not commands; running them through the shell
 * fails. The matched tool name and raw args are returned so the caller can
 * redirect into the real tool.
 */
export function detectToolCallInBash(command: string): {
  tool: string;
  args: string;
} | null {
  const match = command.trim().match(/^([\w-]+)\s+(.+)$/s);
  if (!match) return null;
  const tool = match[1];
  const rest = match[2].trim();
  // Only treat as a tool call when the first word looks like a snake_case
  // tool name and the rest has at least one '=' or a JSON object shape.
  if (!/^[a-z][a-z0-9_]+$/.test(tool)) return null;
  if (!rest.includes("=") && !rest.startsWith("{")) return null;
  return { tool, args: rest };
}

/**
 * Parse the raw argument string of a mistaken tool call captured in a bash
 * command into a Record. Supports JSON objects ("{"path": "..."}") and
 * key=value pairs ("path=C:\...\src"). Values keep their literal text.
 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      /* fall through to key=value parsing */
    }
  }
  const args: Record<string, unknown> = {};
  // Tokenize respecting double/single-quoted values.
  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      // Strip surrounding quotes from values.
      args[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return args;
}

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Execute a shell command and return its output. Use for running tests, build, git, and shell operations. Commands that are still running after a few seconds are automatically moved to the background and return a process id — manage them with process_list, process_log, process_kill. Set background=true to return a process id immediately for commands you know are long-running (dev servers, watchers).",
  tags: ["shell", "code"],
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      workdir: {
        type: "string",
        description: "Working directory (default: baseDir)",
      },
      background: {
        type: "boolean",
        description:
          "Return a process id immediately without waiting (default: commands still running after a few seconds are auto-promoted to the background)",
      },
    },
    required: ["command"],
  },
  handler: async (ctx, args) => {
    const originalCommand = String(args.command);

    // The model sometimes sends a tool invocation (e.g. "create_dir path=...")
    // as a bash command instead of calling the tool directly. Redirect into
    // the real tool so the intent succeeds instead of failing in the shell.
    const toolCall = detectToolCallInBash(originalCommand);
    if (toolCall && toolCall.tool !== "bash" && ctx.toolExecutor) {
      const redirected = await ctx.toolExecutor.executeByName(
        toolCall.tool,
        parseToolArgs(toolCall.args),
        ctx,
      );
      return {
        success: redirected.success,
        output: `[redirected to tool "${toolCall.tool}"]\n${redirected.output}`,
      };
    }

    const command = adaptCommandForWindows(originalCommand);
    const workdir = args.workdir ? String(args.workdir) : ctx.baseDir;

    // Get session-specific security config with defaults
    const appConfig = ctx.config || {};
    const fullSecurityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(appConfig, ctx.sessionContext)
      : appConfig.security || DEFAULT_SECURITY_CONFIG;
    const securityConfig =
      fullSecurityConfig.bash || DEFAULT_SECURITY_CONFIG.bash;
    const validation = isCommandAllowed(command, securityConfig);

    if (!validation.allowed) {
      // Log security block
      logSecurityBlock(
        ctx.sessionId,
        "bash_command",
        validation.reason || "Command blocked by security policy",
        sanitizeCommandForLog(originalCommand),
      );

      return {
        success: false,
        output: `[SECURITY BLOCKED] Command is not allowed: ${validation.reason}\nHint: Use the "workdir" parameter to run commands in a specific directory instead of "cd dir && cmd". Run one command per tool call.`,
      };
    }

    // Log command execution if enabled
    if (securityConfig?.logCommands) {
      logBashCommand(
        ctx.sessionId,
        sanitizeCommandForLog(command),
        false, // Will be updated after execution
        `Working directory: ${workdir}`,
      );
    }

    const entry = processRegistry.start(command, workdir, ctx.sessionId);
    if (ctx.activeCallId) {
      // Let the executor abort/kill the child during the grace window.
      registerKillable(ctx.activeCallId, () => processRegistry.kill(entry.id));
    }

    try {
      const settleMs = args.background === true ? SPAWN_SETTLE_MS : bashGraceMs;
      const exited = await processRegistry.waitForExit(entry.id, settleMs);

      if (exited) {
        // Command finished (or failed to spawn) within the window.
        if (entry.spawnError) {
          return {
            success: false,
            output: `[process error] ${entry.spawnError}\nHint: check the "workdir" path exists and the command is valid for this OS.`,
          };
        }

        const code = entry.exitCode;
        let output = entry.log.join("\n");
        processRegistry.remove(entry.id);

        if (!output && code !== 0) {
          output = `(exit code ${code})`;
        }

        // On Windows, hint about Unix commands that don't work
        if (platform() === "win32" && code !== 0) {
          const firstWord = command
            .trim()
            .split(/\s+/)[0]
            ?.split(/[\\/]/)
            .pop();
          const hint = firstWord ? UNIX_TO_WIN_HINTS[firstWord] : undefined;
          if (hint) {
            output = `${output}\n\nHint: "${firstWord}" may not work on Windows. ${hint}`;
          }
        }

        // Update audit log with result
        if (securityConfig?.logCommands) {
          logBashCommand(
            ctx.sessionId,
            sanitizeCommandForLog(command),
            code === 0,
            `Working directory: ${workdir}, Output length: ${output.length}`,
          );
        }

        const lines = output.split("\n");
        if (lines.length > MAX_PREVIEW_LINES) {
          output =
            lines.slice(0, MAX_PREVIEW_LINES).join("\n") +
            `\n... (${lines.length - MAX_PREVIEW_LINES} more lines)`;
        }

        return { success: code === 0, output };
      }

      // Still running — promote to a background process.
      const explicit = args.background === true;
      const output = `${t("proc.started", {
        id: entry.id,
        pid: entry.pid,
        command,
      })}${explicit ? "" : `\n${t("proc.promoted_hint", { ms: settleMs })}`}\n${t(
        "proc.manage_hint",
        {
          id: entry.id,
        },
      )}`;

      if (securityConfig?.logCommands) {
        logBashCommand(
          ctx.sessionId,
          sanitizeCommandForLog(command),
          true,
          `Started in background: ${entry.id} (PID ${entry.pid})`,
        );
      }

      return { success: true, output };
    } finally {
      if (ctx.activeCallId) {
        unregisterKillable(ctx.activeCallId);
      }
    }
  },
};
