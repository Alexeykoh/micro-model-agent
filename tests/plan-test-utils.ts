import { expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { ExecutionModule } from "../src/modules/execution/module";
import {
  extractFileLikeTokens,
  stripUrls,
} from "../src/modules/hallucination/js-identifiers";

/**
 * Shared scaffolding for plan-tool unit tests. Every plan test file used to
 * repeat the same tmpdir/module setup and the same verbose
 * `tool.handler(ctx, { action: "create", ... })` blocks (flagged as
 * duplication); these helpers keep each call site to one unique line.
 *
 * NOTE: files keep their local `planTool()` lookup (3 lines, under the
 * clone threshold); only the setup and create blocks are shared.
 */

export function createTestModule(prefix: string): {
  tmpDir: string;
  execModule: ExecutionModule;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), prefix));
  return { tmpDir, execModule: new ExecutionModule(tmpDir, 8) };
}

export function cleanupTestModule(tmpDir: string): void {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
}

/** Derive the same checks a careful model would pass: file-exists per named
 *  file token, manual otherwise. Mirrors the contract, not the module code. */
export function deriveTestChecks(steps: string[]): string[] {
  return steps.map((s) => {
    const toks = extractFileLikeTokens(stripUrls(s));
    return toks.length > 0 ? `file-exists:${toks[0]}` : `manual:verify ${s.slice(0, 60)}`;
  });
}

/** Create a plan, asserting success. For expected-failure creates, call the
 *  handler directly instead. */
export async function createTestPlan(
  execModule: ExecutionModule,
  title: string,
  steps: string[],
  extra: Record<string, unknown> = {},
) {
  const tool = execModule.getToolDefinitions().find((t) => t.name === "plan")!;
  const res = await tool.handler(
    {},
    { action: "create", title, steps, checks: deriveTestChecks(steps), ...extra },
  );
  expect(res.success).toBe(true);
  return res;
}

export function writeTestFile(tmpDir: string, relPath: string, content = "export const x = 1;\n"): void {
  const full = join(tmpDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** The most common plan-test setup: one-step plan plus its file on disk.
 *  Collapses the identical create+write preamble repeated across tests. */
export async function setupSingleFilePlan(
  execModule: ExecutionModule,
  tmpDir: string,
  title = "T",
  step = "Create src/a.ts",
  content = "export const a = 1;\n",
) {
  await createTestPlan(execModule, title, [step]);
  writeTestFile(tmpDir, "src/a.ts", content);
}

/** Setup plus completed step 1 (done), asserting success. For tests that
 *  only care about the post-completion state (archive, projections). */
export async function setupCompletedStep(execModule: ExecutionModule, tmpDir: string) {
  const tool = execModule.getToolDefinitions().find((t) => t.name === "plan")!;
  await setupSingleFilePlan(execModule, tmpDir);
  const res = await tool.handler({}, { action: "update", step: 1, status: "done" });
  expect(res.success).toBe(true);
  return res;
}
