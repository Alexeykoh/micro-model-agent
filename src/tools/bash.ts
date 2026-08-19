import type { ToolDefinition } from "./types";
import { isCommandAllowed, sanitizeCommandForLog } from "../modules/security/command-validator";
import { logBashCommand, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { DEFAULT_SECURITY_CONFIG } from "../config/security";
import { processRegistry, registerKillable, unregisterKillable } from "../modules/processes";
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
/** Number of already-emitted lines shown in the background start message. */
const BG_OUTPUT_PREVIEW_LINES = 15;

let bashGraceMs = BASH_GRACE_MS;
/** Test hook: override the auto-background grace window. */
export function setBashGraceMs(ms: number): void {
  bashGraceMs = ms;
}

/**
 * Consecutive failures per first command word (resets on success). A model
 * that keeps calling a forbidden Unix command in cmd.exe (head/cat/grep/...)
 * gets a hint the first couple of times; after HARD_BLOCK_THRESHOLD consecutive
 * failures the tool hard-stops with a STOP directive instead of repeating the
 * same hint forever (observed: `head` called 5×, `Select-String` 3× in one run).
 */
const FAILING_FIRST_WORDS = new Map<string, number>();
const HARD_BLOCK_THRESHOLD = 3;

/** Test hook: clear the consecutive-failure tracking state. */
export function resetBashFailureTracking(): void {
  FAILING_FIRST_WORDS.clear();
}

/**
 * Detect a file write via `echo/printf ... > file` — common model habit that
 * breaks in cmd.exe: single quotes are not grouping quotes, `>` only applies
 * to the LAST line of a multi-line command, and double quotes inside the text
 * split the command. Returns the target filename or null.
 */
export function extractEchoFileWrite(command: string): string | null {
  if (!/^\s*(?:echo|printf)\b/i.test(command)) return null;
  const m = command.match(/[>»]{1,2}\s*"?([^"'\s&|]+)"?/i);
  if (!m) return null;
  return m[1].replace(/["'']$/g, "");
}

/**
 * cmd.exe uses `&` as the command separator, not `;` (bash). The model
 * regularly chains commands with `;` — without translation cmd passes the
 * `;` to the first command as an argument (e.g. `node x.ts;` → ENOENT for
 * "x.ts;"). Replace `;` with `&` only OUTSIDE double-quoted strings so
 * `echo "a;b"` stays intact. (Single quotes are not special in cmd.)
 */
export function translateSemicolonsForCmd(command: string): string {
  let out = "";
  let inQuotes = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      out += ch;
      continue;
    }
    out += ch === ";" && !inQuotes ? "&" : ch;
  }
  return out;
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
  return translateSemicolonsForCmd(command);
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
  "Write-Host": "PowerShell cmdlet — this shell is cmd.exe. Print with plain echo instead.",
  "Select-String": "Use the grep tool instead.",
  "Out-File": "Write files with the write_file tool instead.",
  "Set-Content": "Write files with the write_file tool instead.",
  "Get-ChildItem": "Use the list_dir tool instead.",
  "Remove-Item": "Use the delete_file tool instead.",
};

/** Unix commands that can be transparently translated to cmd.exe equivalents. */
const UNIX_TO_WIN_TRANSLATE: Record<string, string> = {
  ls: "dir",
  pwd: "cd",
  cat: "type",
};

/**
 * Detect when the model mistakes a tool call for a shell command — e.g.
 * `bash` with command "create_dir path=C:\...\src" or "read_file file=x".
 * These are tool invocations, not commands; running them through the shell
 * fails. The matched tool name and raw args are returned so the caller can
 * redirect into the real tool.
 */
/**
 * Shell commands that must NEVER be treated as mistaken tool calls. The
 * model often writes files via `echo '<code with = signs>'` or reads them
 * via `cat` — those are shell commands, not tool invocations. Without this
 * guard the redirect heuristic fires on any `<word> <text containing =>`
 * and fails with "Unknown tool: echo".
 */
const NEVER_TOOL_CALLS = new Set([
  "echo",
  "cat",
  "type",
  "printf",
  "touch",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "ls",
  "dir",
  "cd",
  "pwd",
  "grep",
  "find",
  "head",
  "tail",
  "wc",
  "chmod",
  "sed",
  "awk",
]);

export function detectToolCallInBash(command: string): {
  tool: string;
  args: string;
} | null {
  const match = command.trim().match(/^([\w-]+)\s+(.+)$/s);
  if (!match) return null;
  const tool = match[1];
  // Real shell commands (echo, cat, ...) are never mistaken tool calls.
  if (NEVER_TOOL_CALLS.has(tool)) return null;
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

export interface TestRunSummary {
  framework: string;
  /** Number of passing test cases (when the runner reports them). */
  passed: number;
  /** Number of failing test cases. */
  failed: number;
  /** Line of the runner's aggregate summary, if any. */
  summary?: string;
}

/**
 * Detect a test-runner report embedded in command output (bun test / vitest /
 * jest / mocha / `go test` / pytest). Returns null when the output does not
 * look like a test run. Used to inject a warning when tests fail so the model
 * cannot close a "run the tests" step as done.
 */
export function detectTestResults(output: string): TestRunSummary | null {
  if (!output) return null;

  // Framework-specific quantifiers first (unambiguous).
  const jest = output.match(/Tests:\s+(\d+)\s+passed,\s*(\d+)\s+failed/i);
  if (jest) {
    return { framework: "jest", passed: +jest[1], failed: +jest[2] };
  }
  const mochaPass = output.match(/(\d+)\s+passing/i);
  const mochaFail = output.match(/(\d+)\s+failing/i);
  if (mochaPass || mochaFail) {
    return {
      framework: "mocha",
      passed: mochaPass ? +mochaPass[1] : 0,
      failed: mochaFail ? +mochaFail[1] : 0,
    };
  }
  const pytest = output.match(/(\d+)\s+passed[^\n]*?(?:,\s*(\d+)\s+failed)?/i);
  if (
    pytest &&
    /pytest|passed|failed/i.test(output) &&
    /(=====|short test summary|tests\s+ok)/i.test(output) === false &&
    /pytest|collect/i.test(output)
  ) {
    return {
      framework: "pytest",
      passed: +pytest[1],
      failed: pytest[2] ? +pytest[2] : 0,
    };
  }

  // bun test / vitest: per-case markers + trailing "N pass / M fail".
  const failMarkers = output.match(/\(fail\)/g)?.length ?? 0;
  const passMarkers = output.match(/\(pass\)/g)?.length ?? 0;
  const xMarkers = output.match(/\s×\s/g)?.length ?? 0;
  const summaryMatch = output.match(/^\s*(\d+)\s+pass[^\n]*$/m);
  const failSummary = output.match(/^\s*(\d+)\s+fail[^\n]*$/m);
  const ran = output.match(/(?:Ran|ran)\s+\d+\s+tests/i);

  if (failMarkers > 0 || passMarkers > 0 || xMarkers > 0 || ran) {
    const failed = Math.max(failMarkers + xMarkers, failSummary ? +failSummary[1] : 0);
    const passed = Math.max(passMarkers, summaryMatch ? +summaryMatch[1] : 0);
    return {
      framework: ran ? "bun/vitest" : "vitest",
      passed,
      failed,
      summary: summaryMatch?.[0] ?? failSummary?.[0],
    };
  }
  return null;
}

/**
 * R5: a command that runs a script file (bun/node/python/...) exited 0 but
 * printed nothing. The most common cause in agent sessions: the program has
 * no entry point — nobody calls its main() with the CLI args. Surface a
 * concrete hint instead of letting the model stare at an empty output.
 */
const CLI_FILE_RUN_RE =
  /\b(bun|node|deno|python|python3|tsx|ts-node|php|ruby|go\s+run)\S*\s+(run\s+)?["']?[\w./\\-]+\.(ts|js|tsx|jsx|mjs|cjs|py)\b/;

export function emptyCliRunHint(
  command: string,
  output: string,
  code: number | null,
): string | null {
  if (code !== 0 || output.trim()) return null;
  if (/[>|]/.test(command)) return null; // redirection/pipes — output went elsewhere
  if (/\b(bun test|vitest|pytest|jest|mocha|--test)\b/i.test(command)) return null;
  if (!CLI_FILE_RUN_RE.test(command)) return null;
  return "the command exited 0 but printed NOTHING to stdout. If this should run a CLI program, the file probably has no entry point: read it with read_file and check the code actually calls its main function with command-line arguments (e.g. main(process.argv[2])) and prints results with console.log.";
}

/**
 * Detect npm/npx/bunx failing with "could not determine executable to run"
 * — the package declares no `bin` (or `npm run <script>` named a missing
 * script). Append a concrete hint instead of letting the model re-try blindly
 * (observed in two agent sessions: the model burned many iterations re-running
 * the same failing `npx`/`bunx`/`npm run` command).
 */
const NPM_EXEC_RE = /could not determine executable to run/i;

export function npmExecHint(output: string): string {
  if (NPM_EXEC_RE.test(output)) {
    return `${output}\n\nHint: ${t("exec.npm_exec_hint")}`;
  }
  return output;
}

export const bashTool: ToolDefinition = {
  name: "bash",
  icon: "💻",
  description:
    "Execute a shell command and return its output. Use for running tests, build, git, and shell operations. Commands that are still running after a few seconds are automatically moved to the background and return a process id — manage them with process_list, process_log, process_kill. Set background=true to return a process id immediately for commands you know are long-running (dev servers, watchers).\n\nWindows notes: the shell is cmd.exe — PowerShell cmdlets (Write-Host, Get-Content, Select-String, Out-File) and bash heredocs (cat << EOF) do NOT work there. Use the read_file/write_file tools instead of cat/echo redirection. Sequential commands: use && (a leading ; is auto-converted to &).",
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
    if (
      toolCall &&
      toolCall.tool !== "bash" &&
      ctx.toolExecutor &&
      ctx.toolExecutor.hasTool(toolCall.tool)
    ) {
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

    // echo/printf redirection to a file is unreliable in cmd.exe (single
    // quotes don't group, multi-line commands split, embedded double quotes
    // break the command). Steer the model to write_file instead — it
    // produces correct files every time.
    if (platform() === "win32") {
      const echoWrite = extractEchoFileWrite(originalCommand);
      if (echoWrite) {
        return {
          success: false,
          output: t("bash.echo_write_blocked", { path: echoWrite }),
        };
      }
    }
    const workdir = args.workdir ? String(args.workdir) : ctx.baseDir;

    // Get session-specific security config with defaults
    const appConfig = ctx.config || {};
    const fullSecurityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(appConfig, ctx.sessionContext)
      : appConfig.security || DEFAULT_SECURITY_CONFIG;
    const securityConfig = fullSecurityConfig.bash || DEFAULT_SECURITY_CONFIG.bash;
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

        // R5: script file ran with exit 0 but empty output — likely a
        // missing entry point (main is never called with argv).
        const cliHint = emptyCliRunHint(command, output, code);
        if (cliHint) {
          output = `(exit code 0, no output)\n\nHint: ${cliHint}`;
        }

        // Auto-verify test runs: a failing suite must not be reported as a
        // clean success. Inject a prominent marker the model cannot miss
        // (the tpical failure: tests fail but the CLI exit code is 0).
        const testRun = detectTestResults(output);
        if (testRun && testRun.failed > 0) {
          output =
            `[test-runner] ${testRun.framework}: ${testRun.failed} test(s) FAILING, ${testRun.passed} passing — do NOT mark verification steps as done while tests fail. Investigate the failures, fix the code, then re-run the tests.\n\n` +
            output;
        } else if (testRun && testRun.failed === 0 && testRun.passed > 0) {
          output = `[test-runner] ${testRun.framework}: all ${testRun.passed} test(s) passing.\n\n${output}`;
        }

        if (!output && code !== 0) {
          output = `(exit code ${code})`;
        }

        // npm/npx/bunx: "could not determine executable to run" — the
        // package has no `bin` entry (or the script does not exist).
        // This is cross-platform, so it runs before the win32 hint block.
        output = npmExecHint(output);

        // On Windows, hint about Unix commands that don't work, and
        // hard-stop a command that keeps failing the same way. The
        // hint keys on the ORIGINAL command word (before
        // adaptCommandForWindows translated cat→type): the translation
        // is only for execution, but the model wrote `cat`, and that is
        // what UNIX_TO_WIN_HINTS knows about. Keying on the translated
        // word left `cat` invisible to the hint/block (observed: model
        // ran cat 4+ times in one session with no guidance).
        if (platform() === "win32") {
          const originalFirstWord = originalCommand.trim().split(/\s+/)[0]?.split(/[\\/]/).pop();
          if (originalFirstWord && originalFirstWord in UNIX_TO_WIN_HINTS) {
            if (code === 0) {
              FAILING_FIRST_WORDS.delete(originalFirstWord);
            } else {
              const failures = (FAILING_FIRST_WORDS.get(originalFirstWord) || 0) + 1;
              FAILING_FIRST_WORDS.set(originalFirstWord, failures);
              if (failures >= HARD_BLOCK_THRESHOLD) {
                output = `STOP using "${originalFirstWord}" — it does not work in this cmd.exe shell and has failed ${failures} times in a row. ${UNIX_TO_WIN_HINTS[originalFirstWord]}`;
              } else {
                output = `${output}\n\nHint: "${originalFirstWord}" may not work on Windows. ${UNIX_TO_WIN_HINTS[originalFirstWord]}`;
              }
            }
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
        if (testRun && testRun.failed > 0) {
          // Keep the failure details: test runners print passing markers
          // first and the errors + summary at the very end. A short head
          // preview hides exactly what the model needs to fix the failures.
          const TEST_TAIL_LINES = 400;
          const kept = lines.slice(-TEST_TAIL_LINES);
          const skipped = lines.length - kept.length;
          output =
            (skipped > 0 ? `[... ${skipped} earlier lines omitted — failing tests below]\n` : "") +
            kept.join("\n");
        } else if (lines.length > MAX_PREVIEW_LINES) {
          output =
            lines.slice(0, MAX_PREVIEW_LINES).join("\n") +
            `\n... (${lines.length - MAX_PREVIEW_LINES} more lines)`;
        }

        return { success: code === 0, output };
      }

      // Still running — promote to a background process.
      const explicit = args.background === true;
      const preview = entry.log
        .filter((l) => l.trim() !== "")
        .slice(0, BG_OUTPUT_PREVIEW_LINES)
        .join("\n");
      let output = `${t("proc.started", {
        id: entry.id,
        pid: entry.pid,
        command,
      })}${explicit ? "" : `\n${t("proc.promoted_hint", { ms: settleMs })}`}`;
      if (preview) {
        output += `\n\n${t("proc.output_preview", { lines: preview })}`;
      }
      output += `\n${t("proc.manage_hint", { id: entry.id })}`;

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
