import { existsSync, readdirSync, type Dirent } from "fs";
import { resolve, isAbsolute, join } from "path";
import type { HallucinationCheckResult } from "./detector";
import { t } from "../../i18n/index";
import { isJsMemberAccess } from "./js-identifiers";

/** Generated/cached dirs to skip when scanning for bare file names. */
const IGNORED_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"coverage",
	".mma",
	"_testing",
]);

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

/**
 * JS/TS global identifiers whose member access (`process.env`, `console.log`)
 * looks like a file path to the regex but is code, not a file.
 */

function looksLikeFilePath(s: string): boolean {
	const lower = s.toLowerCase();
	// "Node.js" etc. are technologies, not files — never flag them.
	if (TECH_NAMES.has(lower)) return false;
	if (!s.includes("/") && !s.includes("\\") && !s.match(/^\w+\.[a-z]{2,4}$/i))
		return false;
	// process.env / console.log / Math.max — member access on JS globals,
	// not file paths. Only applies to bare `word.word` (no slashes).
	if (isJsMemberAccess(s)) return false;
	const ext = s.split(".").pop()?.toLowerCase() || "";
	return !NON_FILE_EXTENSIONS.has(ext);
}

export class FactualCheck {
	private baseDir: string;
	private nameCache: Map<string, string[]> | null = null;
	private nameCacheTime = 0;
	private lastRescan = 0;
	private static readonly NAME_CACHE_TTL_MS = 5_000;
	private static readonly RESCAN_COOLDOWN_MS = 2_000;
	private static readonly MAX_INDEXED_FILES = 20_000;

	constructor(baseDir: string) {
		this.baseDir = baseDir;
	}

	validate(response: string): HallucinationCheckResult {
		const filePaths = this.extractFilePaths(response);
		if (filePaths.length === 0) return { status: "pass" };

		const nonExistent: string[] = [];
		for (const fp of filePaths) {
			if (!this.pathExists(fp)) {
				nonExistent.push(fp);
			}
		}

		if (nonExistent.length > 0) {
			return {
				status: "warn",
				reason: t("hall.unknown_paths", {
					paths: nonExistent.slice(0, 5).join(", "),
				}),
			};
		}

		return { status: "pass" };
	}

	/**
	 * Bare filenames ("bikes.json") and relative paths ("src/data/bikes.json")
	 * both land on the project tree. Absolute paths are checked as-is.
	 */
	private pathExists(fp: string): boolean {
		if (isAbsolute(fp)) return existsSync(fp);

		// "foo.json" has no directory part — treat it as a bare name that may
		// live anywhere under baseDir (e.g. src/data/bikes.json). Resolving it
		// against the workspace root alone produced false "unknown file" warnings.
		if (!fp.includes("/") && !fp.includes("\\")) {
			return this.bareNameExists(fp);
		}

		return existsSync(resolve(this.baseDir, fp));
	}

	private bareNameExists(name: string): boolean {
		if (existsSync(resolve(this.baseDir, name))) return true;
		if (this.indexHas(name)) return true;

		// A write_file from this session may have created the file after the
		// index was built. Do a one-off rescan (rate-limited) before warning.
		const now = Date.now();
		if (now - this.lastRescan < FactualCheck.RESCAN_COOLDOWN_MS) return false;
		this.lastRescan = now;
		this.nameCache = null;
		this.nameCacheTime = 0;
		return this.indexHas(name);
	}

	private indexHas(name: string): boolean {
		return (this.getNameIndex().get(name)?.length ?? 0) > 0;
	}

	/**
	 * Basename → paths index, rebuilt every NAME_CACHE_TTL_MS so newly created
	 * files (write_file) are picked up without a full scan on every response.
	 */
	private getNameIndex(): Map<string, string[]> {
		const now = Date.now();
		if (
			this.nameCache &&
			now - this.nameCacheTime < FactualCheck.NAME_CACHE_TTL_MS
		) {
			return this.nameCache;
		}

		const index = new Map<string, string[]>();
		const scanned = this.scanDir(this.baseDir, index, 0);
		if (scanned > 0 || index.size > 0) {
			this.nameCache = index;
			this.nameCacheTime = now;
		}
		return index;
	}

	private scanDir(
		dir: string,
		index: Map<string, string[]>,
		count: number,
	): number {
		if (count >= FactualCheck.MAX_INDEXED_FILES) return count;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return count;
		}
		for (const entry of entries) {
			if (count >= FactualCheck.MAX_INDEXED_FILES) break;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) {
					count = this.scanDir(full, index, count);
				}
			} else if (entry.isFile()) {
				const list = index.get(entry.name);
				if (list) list.push(full);
				else index.set(entry.name, [full]);
				count++;
			}
		}
		return count;
	}

	private extractFilePaths(text: string): string[] {
		// Capture absolute Windows paths (with drive letter) and relative paths.
		// The old pattern started at a word boundary, so "E:\project\src\a.ts"
		// only matched "project\src\a.ts" — resolve() then glued that onto
		// baseDir producing a bogus path and a false "unknown file" warning
		// even for files that actually exist on disk.
		const pattern = /\b(?:[a-zA-Z]:[\\/])?[\w./\\-]+\.[a-z]{2,6}\b/gi;
		const matches = text.match(pattern) || [];
		return [...new Set(matches)].filter(looksLikeFilePath);
	}
}
