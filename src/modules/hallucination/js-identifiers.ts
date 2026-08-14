/**
 * JS/TS global identifiers whose member access (`process.env`, `console.log`,
 * `Math.max`) looks like a file path to `\b[\w./\\-]+\.[a-z]+\b`-style regexes
 * but is code, not a file. Shared by the hallucination factual check and the
 * execution auditor so both stop flagging member access as "missing files".
 *
 * Also home of the shared "is this token actually a file?" filter
 * (`isFilePathLike` / `extractFileLikeTokens` / `stripUrls`) so the two
 * extractors cannot drift apart again (observed: auditor treated a URL
 * hostname `whom-pointing-jewel-maine.trycloudflare.com` in a plan step as a
 * missing file while the factual check correctly ignored it).
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

/** Top-level domains that are never file extensions. */
const NON_FILE_EXTENSIONS = new Set([
	"com",
	"org",
	"net",
	"gov",
	"edu",
	"io",
	"dev",
	"app",
	"co",
	"ai",
	"ru",
	"de",
	"fr",
	"uk",
	"us",
	"es",
	"it",
	"jp",
	"cn",
	"br",
]);

/** Well-known runtime/library names that end in .js/.ts but are NOT files. */
const TECH_NAMES = new Set([
	"node.js",
	"react.js",
	"vue.js",
	"next.js",
	"angular.js",
	"express.js",
	"deno.js",
	"qwik.js",
	"svelte.js",
	"jquery.js",
]);

const FILE_TOKEN_RE = /\b(?:[a-zA-Z]:[\\/])?[\w./\\-]+\.[a-z]{2,6}\b/gi;

/**
 * True when `candidate` is a plausible file path token: has a directory part
 * OR is a simple `word.ext` bare name, is not JS member access, is not a
 * technology name (node.js), and does not end in a TLD (com/org/ru/...).
 */
export function isFilePathLike(s: string): boolean {
	const lower = s.toLowerCase();
	if (TECH_NAMES.has(lower)) return false;
	if (!s.includes("/") && !s.includes("\\") && !/^\w+\.[a-z]{2,4}$/i.test(s))
		return false;
	if (isJsMemberAccess(s)) return false;
	const ext = s.split(".").pop()?.toLowerCase() || "";
	return !NON_FILE_EXTENSIONS.has(ext);
}

/**
 * Extract deduplicated file-like tokens from free text. Multi-label hostnames
 * (`whom-pointing-jewel-maine.trycloudflare.com`) and TLD ends are rejected by
 * `isFilePathLike`; URLs are stripped first so `https://host/repo.git` never
 * survives as a "file".
 */
export function extractFileLikeTokens(text: string): string[] {
	const matches = text.match(FILE_TOKEN_RE) || [];
	return [...new Set(matches.filter(isFilePathLike))];
}

/** Remove URL tokens (scheme://… up to whitespace/quote) so they are never
 *  parsed as file paths. */
export function stripUrls(text: string): string {
	return text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, " ");
}
