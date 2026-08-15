/**
 * Unix commands that do not exist (or have incompatible semantics) in Windows
 * cmd.exe. The 9B model keeps reaching for grep/sed/ls/find via the bash tool;
 * each failure returns a hint, but the model retries. The execution module
 * hard-stops a command after its second consecutive failure so the session
 * stops burning tool calls. This is a command allow/deny list (like the
 * security module's command blacklist), NOT task classification (rule #10).
 */
const FORBIDDEN_COMMANDS = new Set([
	"grep",
	"sed",
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
