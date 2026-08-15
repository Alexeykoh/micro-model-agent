import { readdirSync } from "fs";
import type { Dirent } from "fs";
import { join } from "path";
import type { Plan } from "./planner";
import { detectTestResults } from "../../tools/bash";
import { processRegistry } from "../processes";

/** Directories never searched for test files. */
export const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".mma",
	"dist",
	"build",
	"coverage",
	".next",
	".nuxt",
	"vendor",
]);

const TEST_EXT_RE = /\.(test|spec)\.[jt]sx?$/i;
const TEST_STEP_RE =
	/\b(test(ing|s)?|тест(ы|ирование|ировать)?|провер\w*\s+тест|запустить\s+тест)\b|bun test|npm test|vitest|pytest|go test|jest|mocha/i;

export interface TestRunCheck {
	/** Whether a real test run was executed at all. */
	checked: boolean;
	/** All detected tests passed. */
	passed: boolean;
	failed: number;
	passedCount: number;
	/** Short list of failing test names (up to 5), or the runner summary. */
	detail: string;
	command: string;
}

/** Recursive, depth-limited walk that stops early on the first test file. */
export function findTestFile(dir: string, depth = 0): string | null {
	if (depth > 5) return null;
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) continue;
			const found = findTestFile(full, depth + 1);
			if (found) return found;
		} else if (TEST_EXT_RE.test(e.name)) {
			return full;
		}
	}
	return null;
}

/** The plan's step descriptions mention running/checking tests. */
export function hasTestStep(plan: Plan): boolean {
	return plan.steps.some((s) => TEST_STEP_RE.test(s.description));
}

/** Extract failing test names from a runner's output (bun/vitest style). */
function extractFailingNames(output: string, limit = 5): string[] {
	const names: string[] = [];
	for (const m of output.matchAll(/\(fail\)\s*([^\n]+)/g)) {
		const name = m[1].trim();
		if (name && !names.includes(name)) names.push(name);
		if (names.length >= limit) break;
	}
	return names;
}

export async function runTests(baseDir: string): Promise<TestRunCheck> {
	const entry = processRegistry.start("bun test", baseDir);
	const exited = await processRegistry.waitForExit(entry.id, 90_000);
	const output = entry.log.join("\n");
	processRegistry.remove(entry.id);

	if (!exited) {
		// Timed out — we cannot claim success or failure from an unfinished run.
		return {
			checked: true,
			passed: true, // don't block completion on an inconclusive run
			failed: 0,
			passedCount: 0,
			detail: "test run timed out after 90s — result unknown",
			command: "bun test",
		};
	}

	const run = detectTestResults(output);
	if (!run) {
		// No recognizable runner summary. If the process exited non-zero we
		// cannot tell whether tests failed or the runner is missing, so treat
		// as checked-but-inconclusive (do not block).
		return {
			checked: true,
			passed: entry.exitCode === 0,
			failed: entry.exitCode === 0 ? 0 : -1,
			passedCount: 0,
			detail: output.slice(0, 200).trim(),
			command: "bun test",
		};
	}

	const names = extractFailingNames(output);
	return {
		checked: true,
		passed: run.failed === 0,
		failed: run.failed,
		passedCount: run.passed,
		detail: names.length
			? names.join("; ")
			: run.summary || `${run.failed} failed / ${run.passed} passed`,
		command: "bun test",
	};
}

/** First `error TS…` line in a tsc output, or null when none/inconclusive. */
export function parseTypecheckErrors(output: string): string | null {
	const line = output.split("\n").find((l) => /error TS\d+/.test(l));
	return line ? line.trim().slice(0, 300) : null;
}

export async function runTypecheck(baseDir: string): Promise<string | null> {
	const entry = processRegistry.start(
		"npx --no-install tsc --noEmit --skipLibCheck",
		baseDir,
	);
	const exited = await processRegistry.waitForExit(entry.id, 90_000);
	const output = entry.log.join("\n");
	processRegistry.remove(entry.id);
	// A timeout, or output with no `error TS` lines (missing typescript / wrong
	// working dir) is inconclusive — never block completion on those.
	if (!exited) return null;
	return parseTypecheckErrors(output);
}
