/**
 * JS/TS global identifiers whose member access (`process.env`, `console.log`,
 * `Math.max`) looks like a file path to `\b[\w./\\-]+\.[a-z]+\b`-style regexes
 * but is code, not a file. Shared by the hallucination factual check and the
 * execution auditor so both stop flagging member access as "missing files".
 */

const JS_GLOBALS = new Set([
	"process",
	"console",
	"math",
	"json",
	"global",
	"globalthis",
	"window",
	"document",
	"buffer",
	"module",
	"require",
	"exports",
	"url",
	"promise",
	"array",
	"object",
	"string",
	"number",
	"boolean",
	"symbol",
	"date",
	"regexp",
	"error",
	"map",
	"set",
	"weakmap",
	"weakset",
	"proxy",
	"reflect",
	"intl",
	"crypto",
	"performance",
	"fetch",
	"navigator",
	"location",
	"settimeout",
	"setinterval",
	"cleartimeout",
	"clearinterval",
	"queuemicrotask",
	"structuredclone",
	"textencoder",
	"textdecoder",
	"atomics",
	"sharedarraybuffer",
	"dataview",
	"arraybuffer",
	"bigint",
	"infinity",
	"nan",
	"undefined",
	"bun",
	"deno",
	"node",
]);

/**
 * True when `candidate` starts with a known JS/TS global followed by a dot
 * (`process.env`, `console.log`, `process.env.NODE` partial matches from
 * `\b[\w./\\-]+\.[a-z]+`-style regexes) — member access, not a file path.
 */
export function isJsMemberAccess(candidate: string): boolean {
	const lower = candidate.toLowerCase();
	const m = lower.match(/^([\w-]+)\./);
	return m !== null && JS_GLOBALS.has(m[1]);
}
