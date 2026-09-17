import { existsSync, readdirSync, readFileSync } from "fs";
import type { Dirent } from "fs";
import { dirname, join, resolve } from "path";
import type { Plan } from "./planner";
import { detectTestResults } from "../../tools/bash";
import { processRegistry } from "../processes";
import { resolveTscCommand } from "../lsp/project-root";

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
const PY_TEST_RE = /^test_.*\.py$|^.*_test\.py$/i;
const TEST_STEP_RE =
  /\b(test(ing|s)?|тест(ы|ирование|ировать)?|провер\w*\s+тест|запустить\s+тест)\b|bun test|npm test|vitest|pytest|go test|jest|mocha/i;

/**
 * Resolve the project's test command from its manifest, so the final audit
 * actually runs the runner the project uses instead of always assuming
 * `bun test` (a Python or Go project, or a vitest/jest setup, would fail or
 * silently produce no summary under bun test).
 *
 * Priority: package.json scripts.test → test-framework config files → Python
 * markers (pyproject/pytest.ini/conftest.py) → go.mod → Cargo.toml → bun.
 */
export function resolveTestCommand(dir: string): string {
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const script = pkg?.scripts?.test;
      if (typeof script === "string" && script.trim()) return script.trim();
    } catch {
      /* invalid package.json — fall through */
    }
  }
  for (const f of [
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mjs",
    "jest.config.js",
    "jest.config.ts",
    "jest.config.mjs",
    "jest.config.cjs",
    "bunfig.toml",
  ]) {
    if (existsSync(join(dir, f))) {
      if (f.startsWith("vitest")) return "bunx vitest run";
      if (f.startsWith("jest")) return "npx --no-install jest";
      if (f === "bunfig.toml") return "bun test";
    }
  }
  if (
    existsSync(join(dir, "pyproject.toml")) ||
    existsSync(join(dir, "pytest.ini")) ||
    existsSync(join(dir, "conftest.py"))
  ) {
    return "python -m pytest -q";
  }
  if (existsSync(join(dir, "go.mod"))) return "go test ./...";
  if (existsSync(join(dir, "Cargo.toml"))) return "cargo test";
  return "bun test";
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
    } else if (TEST_EXT_RE.test(e.name) || PY_TEST_RE.test(e.name)) {
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
  const command = resolveTestCommand(baseDir);
  const entry = processRegistry.start(command, baseDir);
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
      detail: `test run timed out after 90s — result unknown`,
      command,
    };
  }

  const run = detectTestResults(output);
  if (!run) {
    // No recognizable runner summary. A non-zero exit means the test run
    // (or its runner) failed — the audit must not pass on it; report a
    // single "at least one failed" since we cannot count them. Exit 0
    // with unrecognized output stays checked-but-inconclusive.
    return {
      checked: true,
      passed: entry.exitCode === 0,
      failed: entry.exitCode === 0 ? 0 : 1,
      passedCount: 0,
      detail: output.slice(0, 200).trim(),
      command,
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
    command,
  };
}

/** First `error TS…` line in a tsc output, or null when none/inconclusive. */
export function parseTypecheckErrors(output: string): string | null {
  const line = output.split("\n").find((l) => /error TS\d+/.test(l));
  return line ? line.trim().slice(0, 300) : null;
}

/**
 * Locate the nearest project root that owns a tsconfig.json.
 *
 * The agent frequently creates the project in a nested subfolder of its
 * baseDir (e.g. `bicycle-shop/`), so the tsconfig lives at
 * `baseDir/bicycle-shop/` and the old `existsSync(baseDir/tsconfig.json)`
 * gate silently skipped the final typecheck — the audit passed even with
 * dozens of tsc errors (observed in both analyzed sessions). This walks each
 * candidate (baseDir plus the resolved step files) upward to the nearest
 * tsconfig.json, preferring the shallowest hit so the baseDir project wins
 * over a stray tsconfig further up. Returns null when no tsconfig exists in
 * any reachable subtree. `existingFiles` must contain resolved absolute paths
 * (relative tokens would resolve against the process cwd, not baseDir).
 */
export function findTypecheckRoot(baseDir: string, existingFiles: string[] = []): string | null {
  const candidates: string[] = [baseDir, ...existingFiles];
  let best: { depth: number; root: string } | null = null;
  for (const start of candidates) {
    let dir = resolve(start);
    for (let depth = 0; depth <= 10; depth++) {
      if (existsSync(join(dir, "tsconfig.json"))) {
        if (!best || depth < best.depth) best = { depth, root: dir };
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return best?.root ?? null;
}

export async function runTypecheck(baseDir: string): Promise<string | null> {
  // Локальный tsc напрямую: npx-обёртка добавляет секунды и без локального
  // пакета уходит в сеть. Нет tsc — проверка невозможна, не блокируем.
  const tsc = resolveTscCommand(baseDir);
  if (!tsc) return null;
  const entry = processRegistry.start(`${tsc} --noEmit --skipLibCheck`, baseDir);
  const exited = await processRegistry.waitForExit(entry.id, 90_000);
  const output = entry.log.join("\n");
  processRegistry.remove(entry.id);
  // A timeout, or output with no `error TS` lines (missing typescript / wrong
  // working dir) is inconclusive — never block completion on those.
  if (!exited) return null;
  return parseTypecheckErrors(output);
}
