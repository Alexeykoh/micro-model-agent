import { existsSync, readdirSync } from "fs";
import type { Dirent } from "fs";
import { resolve, join, basename } from "path";
import { t } from "../../i18n/index";
import type { Plan } from "./planner";
import { extractFileLikeTokens, stripUrls } from "../hallucination/js-identifiers";
import { detectTestResults } from "../../tools/bash";
import { processRegistry } from "../processes";

const MASS_EDIT_THRESHOLD = 10;

/** Directories never searched for test files. */
const SKIP_DIRS = new Set([
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

/** Subtree walk depth cap for file resolution. */
const RESOLVE_MAX_DEPTH = 8;

/**
 * Resolve a plan-step file token to an existing file.
 *
 * A step description frequently names a file by its bare basename
 * ("App.tsx") or a partially-prefixed path ("src/App.tsx") while the real
 * file lives in a nested project directory relative to the agent baseDir
 * (e.g. `bicycle-shop/src/App.tsx`). Naively resolving against baseDir
 * reports the file as missing — observed in session ses_mssl5izw where the
 * final audit gate rejected a fully-completed task with "1 files missing"
 * forever, sending the model into a read/retry loop.
 *
 * Strategy: exact resolve first, then a bounded subtree walk matching either
 * the exact basename or a path suffix (so both "App.tsx" and
 * "src/App.tsx" find "bicycle-shop/src/App.tsx").
 */
export function findExistingFile(baseDir: string, filePath: string): string | null {
	const direct = resolve(baseDir, filePath);
	if (existsSync(direct)) return direct;

	const name = basename(filePath).toLowerCase();
	const suffix = filePath.replace(/\\/g, "/").toLowerCase();
	let found: string | null = null;

	const walk = (dir: string, depth: number): void => {
		if (found || depth > RESOLVE_MAX_DEPTH) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (found) return;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (SKIP_DIRS.has(e.name)) continue;
				walk(full, depth + 1);
			} else if (
				e.name.toLowerCase() === name ||
				full.replace(/\\/g, "/").toLowerCase().endsWith("/" + suffix)
			) {
				found = full;
				return;
			}
		}
	};

	walk(baseDir, 0);
	return found;
}

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

export interface AuditResult {
	passed: boolean;
	missingFiles: string[];
	/** Delete-kind steps (done) whose named files still exist. */
	leftoverFiles: string[];
	createdFiles: string[];
	modifiedFiles: string[];
	summary: string;
	massEditWarning: string | null;
	testRun: TestRunCheck | null;
	/** First `error TS…` line from a real `tsc --noEmit` run, or null. */
	typecheckError: string | null;
}

/** Recursive, depth-limited walk that stops early on the first test file. */
function findTestFile(dir: string, depth = 0): string | null {
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
function hasTestStep(plan: Plan): boolean {
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

async function runTests(baseDir: string): Promise<TestRunCheck> {
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

async function runTypecheck(baseDir: string): Promise<string | null> {
	const entry = processRegistry.start(
		"npx --no-install tsc --noEmit --skipLibCheck",
		baseDir,
	);
	const exited = await processRegistry.waitForExit(entry.id, 90_000);
	const output = entry.log.join("\n");
	processRegistry.remove(entry.id);
	// Timeout / non-zero exit with no `error TS` lines = inconclusive (missing
	// typescript, wrong working dir) — never block completion on those.
	if (!exited) return null;
	return parseTypecheckErrors(output);
}

export class Auditor {
	private baseDir: string;

	constructor(baseDir: string) {
		this.baseDir = baseDir;
	}

	async audit(plan: Plan): Promise<AuditResult> {
		// Only steps the model claims completed may require their named files to
		// exist. Skipped/pending steps must never contribute "missing files"
		// (observed: a skipped step's prose mention of "type.ts" kept the audit
		// gate rejecting a finished task with "1 files missing" forever).
		const doneCreate = plan.steps.filter(
			(s) => s.status === "done" && s.kind !== "delete",
		);
		const doneDelete = plan.steps.filter(
			(s) => s.status === "done" && s.kind === "delete",
		);
		const createText = doneCreate
			.map((s) => s.description.replace(/\([^)]*\)/g, " "))
			.join(" ");
		const deleteText = doneDelete
			.map((s) => s.description.replace(/\([^)]*\)/g, " "))
			.join(" ");
		// File tokens are extracted with the SAME shared filter as the
		// hallucination factual check (js-identifiers.ts). URLs are stripped
		// first so a hostname / https://host/repo.git in a step description
		// can never be reported as a missing file (observed: a git-remote
		// plan flagged `whom-pointing-jewel-maine.trycloudflare.com`).
		const createFiles = extractFileLikeTokens(stripUrls(createText));
		const deleteFiles = extractFileLikeTokens(stripUrls(deleteText));

		const missingFiles: string[] = [];
		const existingFiles: string[] = [];
		const leftoverFiles: string[] = [];

		for (const filePath of createFiles) {
			if (findExistingFile(this.baseDir, filePath)) {
				existingFiles.push(filePath);
			} else {
				missingFiles.push(filePath);
			}
		}
		// A done delete-kind step requires its named files to be GONE.
		for (const filePath of deleteFiles) {
			if (findExistingFile(this.baseDir, filePath)) {
				leftoverFiles.push(filePath);
			}
		}

		// Real test run: when the plan includes a verification step, do not
		// trust the model's word (or exit codes) — actually execute the tests
		// and check the runner summary. This catches the "all 7 passing ✅"
		// final answers that hide 3 failing tests.
		let testRun: TestRunCheck | null = null;
		if (hasTestStep(plan) && findTestFile(this.baseDir)) {
			try {
				testRun = await runTests(this.baseDir);
			} catch {
				testRun = null; // infra failure — don't block on it
			}
		}

		// Real typecheck: the audit must catch "the build is broken" even when
		// every file exists (observed: deleting .js files left the .tsx sources
		// with 11 tsc errors and the agent still declared success). Runs only
		// when a tsconfig.json exists; inconclusive results never block.
		let typecheckError: string | null = null;
		if (existsSync(join(this.baseDir, "tsconfig.json"))) {
			try {
				typecheckError = await runTypecheck(this.baseDir);
			} catch {
				typecheckError = null;
			}
		}

		const doneSteps = plan.steps.filter((s) => s.status === "done").length;
		// done + skipped are both deliberate terminal states: `done` claims the
		// work, `skipped` documents a decision that the step is not needed (the
		// deliverable gate's documented escape hatch). Neither is a lie the
		// audit must catch — a plan with a legitimately skipped step must be
		// able to pass (observed: skipped step 1 kept the task rejected forever).
		const terminalSteps = plan.steps.filter(
			(s) => s.status === "done" || s.status === "skipped",
		).length;
		const totalSteps = plan.steps.length;

		let massEditWarning: string | null = null;
		const uniqueFiles = createFiles.length + deleteFiles.length;
		if (uniqueFiles > MASS_EDIT_THRESHOLD) {
			massEditWarning = t("exec.mass_edit_warning", {
				count: String(uniqueFiles),
			});
		}

		const testsFailing = testRun !== null && testRun.failed > 0;
		const typecheckFailing = typecheckError !== null;
		const passed =
			missingFiles.length === 0 &&
			leftoverFiles.length === 0 &&
			!testsFailing &&
			!typecheckFailing;
		// A "Task complete ✓" summary for an unfinished plan is a lie the model
		// reads as a green light (observed: audit gate injected "[✓] Task
		// complete: 1/3 steps done" while the plan had 2 pending steps). The
		// summary must only claim completion when every step is actually done.
		const stepsPending = terminalSteps < totalSteps;

		let summary: string;
		if (missingFiles.length > 0) {
			summary = t("exec.audit_fail", {
				done: doneSteps,
				total: totalSteps,
				files: missingFiles.length,
			});
		} else if (leftoverFiles.length > 0) {
			summary = t("exec.audit_leftovers", {
				done: doneSteps,
				total: totalSteps,
				files: leftoverFiles.length,
			});
		} else if (testsFailing) {
			summary = t("exec.audit_fail_tests", {
				done: doneSteps,
				total: totalSteps,
				failed: String(testRun!.failed),
				passed: String(testRun!.passedCount),
				detail: testRun!.detail,
			});
		} else if (typecheckFailing) {
			summary = t("exec.audit_fail_typecheck", {
				done: doneSteps,
				total: totalSteps,
				missing: String(missingFiles.length),
				typeError: typecheckError!,
			});
		} else if (stepsPending) {
			summary = t("exec.audit_pending", {
				done: doneSteps,
				total: totalSteps,
			});
		} else {
			summary = t("exec.audit_pass", {
				done: doneSteps,
				total: totalSteps,
				files: existingFiles.length,
			});
		}

		return {
			passed,
			missingFiles,
			leftoverFiles,
			createdFiles: existingFiles,
			modifiedFiles: [],
			summary,
			massEditWarning,
			testRun,
			typecheckError,
		};
	}
}
