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
 *
 * Bare `word.ext` tokens are gated on an allow-list of real file extensions
 * (`FILE_EXTENSIONS`) instead of a deny-list of TLDs — a domain in any present
 * or future TLD (`Gismeteo.by`, `weather.com`, `example.xyz`) can never be
 * mistaken for a file, and no TLD list needs maintaining.
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

/**
 * File extensions that make a bare `word.ext` token a plausible file path.
 *
 * An allow-list, deliberately: enumerating everything that is NOT a file (TLDs,
 * brand names, …) is a brittle heuristic that can never be complete. Instead a
 * bare `word.ext` is only treated as a file when its extension is a known one —
 * so `Gismeteo.by`, `weather.com`, or any future TLD is never flagged, while a
 * genuine `config.json` / `helper.ts` still is.
 */
const FILE_EXTENSIONS = new Set([
	// source / code
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"py",
	"pyc",
	"rb",
	"go",
	"rs",
	"java",
	"jar",
	"kt",
	"kts",
	"c",
	"h",
	"cc",
	"cpp",
	"cxx",
	"hpp",
	"hh",
	"cs",
	"php",
	"swift",
	"m",
	"mm",
	"lua",
	"pl",
	"sh",
	"bash",
	"zsh",
	"fish",
	"bat",
	"cmd",
	"ps1",
	"vue",
	"svelte",
	"dart",
	// config / data / docs
	"json",
	"jsonc",
	"json5",
	"yaml",
	"yml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"env",
	"xml",
	"html",
	"htm",
	"md",
	"markdown",
	"rst",
	"txt",
	"log",
	"csv",
	"tsv",
	"lock",
	"sql",
	"sqlite",
	"db",
	"wasm",
	"map",
	"css",
	"scss",
	"sass",
	"less",
	// assets / binary
	"svg",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"bmp",
	"ico",
	"avif",
	"tiff",
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"odt",
	"ods",
	"zip",
	"gz",
	"tar",
	"tgz",
	"bz2",
	"xz",
	"7z",
	"rar",
	"bin",
	"exe",
	"dll",
	"so",
	"o",
	"a",
	"dylib",
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

const FILE_TOKEN_RE = /\b(?:[a-zA-Z]:[\\/])?[\w./\\-]+\.[a-z]{1,6}\b/gi;

/**
 * True when `candidate` is a plausible file path token: for a path with a
 * directory separator the last segment must carry a non-empty stem before the
 * extension (extension-only segments like `tsx/.ts` are rejected), while a bare
 * `word.ext` is only a file when its extension is a known file extension (so
 * domains like `Gismeteo.by` / `weather.com` are never files). JS member access
 * (`process.env`) and technology names (`node.js`) are never files.
 */
export function isFilePathLike(s: string): boolean {
	const lower = s.toLowerCase();
	if (TECH_NAMES.has(lower)) return false;
	if (isJsMemberAccess(s)) return false;
	const ext = s.split(".").pop()?.toLowerCase() || "";
	if (!s.includes("/") && !s.includes("\\")) {
		if (!/^\w+\.[a-z]{1,6}$/i.test(s)) return false;
		return FILE_EXTENSIONS.has(ext);
	}
	// Tokens with a directory separator: require the LAST segment to carry a
	// real file name (a non-empty stem before the extension). Otherwise an
	// extension-only segment like "tsx/.ts" (from ".tsx/.ts" in a step
	// description) or a dotfile ("src/.env") is misread as a file and the plan
	// deliverable gate demands "create tsx/.ts" (observed in ses_mstda6uo:
	// step "Проверить что остались только .tsx/.ts файлы").
	const last = s.split(/[\\/]/).pop() ?? "";
	const lastDot = last.lastIndexOf(".");
	if (lastDot <= 0) return false;
	return true;
}

/**
 * Extract deduplicated file-like tokens from free text. Bare `word.ext` tokens
 * are filtered through `isFilePathLike` (allow-list of real file extensions, so
 * hostnames/TLDs like `whom-pointing-jewel-maine.trycloudflare.com` or
 * `Gismeteo.by` never survive); URLs are stripped first so
 * `https://host/repo.git` never survives as a "file".
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
