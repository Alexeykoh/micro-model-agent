/**
 * Unix commands that do not exist (or have incompatible semantics) in Windows
 * cmd.exe. The 9B model keeps reaching for grep/sed/ls/find via the bash tool;
 * each failure returns a hint, but the model retries.
 *
 * This is a session-level, module-side companion to the bash tool's own
 * per-command hard-stop (`UNIX_TO_WIN_HINTS` / `FAILING_FIRST_WORDS` /
 * `HARD_BLOCK_THRESHOLD` in src/tools/bash.ts). That mechanism injects
 * "STOP using X" INTO the tool output, which a 9B model tends to ignore; this
 * one, gated to win32 like bash.ts, queues a <system-summary> that lands
 * before the next model call. Keep the two command lists consistent.
 *
 * This is a command allow/deny list (like the security module's command
 * blacklist), NOT task classification (rule #10).
 */
const FORBIDDEN_COMMANDS = new Set([
  "grep",
  "sed",
  "awk",
  "uniq",
  "xargs",
  "cut",
  "tr",
  "basename",
  "dirname",
  "export",
  "source",
  "sleep",
  "env",
  "ls",
  "find",
  "rm",
  "touch",
  "which",
  "diff",
  "cp",
  "mv",
]);

function firstWord(command: string): string {
  const segs = command.trim().split(/[\s;|&]+/);
  return (segs[0] || "").replace(/[^\w-]/g, "").toLowerCase();
}

/** The forbidden command name if `command` starts with one (handles `cd x && …`). */
export function forbiddenWindowsCommand(command: string): string | null {
  const m = command.match(/^\s*cd\s+\S+\s*&&\s*(\S+)/);
  if (m) return forbiddenWindowsCommand(m[1]);
  const word = firstWord(command);
  if (word && FORBIDDEN_COMMANDS.has(word)) return word;
  return null;
}
