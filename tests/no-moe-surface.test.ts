import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guard: MoE left no surface behind (INV-22, "one execution path").
 *
 * MoE was removed structurally (`c3bc9d3e`, spec
 * `docs/specs/2026-10-12-remove-moe-design.md`), but a follow-up grill-me showed
 * the *surface* survived: a dead `moeActive` host-state field, an unused
 * `SubtaskContext` type, a `.ws-moe` footer chip, a `moe` certification tag whose
 * scenarios still set the removed `moe.enabled` key, leftovers in test fixtures
 * and ghost comments pointing at deleted files. None of that is enforced by a
 * check, so — per the project rule "an invariant is a check, not text" — this
 * test fails the build if any of it creeps back into `src/`.
 *
 * History is kept in `docs/agents/feature-history.md`; this scan only covers
 * `src/`, so docs may still narrate the past.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCAN_ROOT = join(REPO_ROOT, "src");
const FILE_RE = /\.(ts|tsx|js|mjs|css|html|json)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

/** Standalone `moe`/`MoE` word — deliberately does not match `mode`/`model`. */
const WORD_RE = /(^|[^A-Za-z0-9_])moe([^A-Za-z0-9_]|$)/i;

/** Compound identifiers, config keys, event names and removed file names. */
export const MOE_TOKENS = [
  "moeActive",
  "moeHandled",
  "runWithMoE",
  "logMoE",
  "MoEConfig",
  "MoEPlan",
  "MoEPlanTask",
  "MoESubtask",
  "MoEVerifyResult",
  "MoEDeps",
  "moe_plan",
  "moe_subtask",
  "moe_replan",
  "moe_verify",
  "moe_",
  "moe/",
  "moe.enabled",
  "moe.maxReplanCycles",
  "moe.parallelSubtasks",
  "orchestrator.model",
  "orchestrator.provider",
  "orchestrator.contextWindow",
  "OrchestratorClient",
  "OrchestratorConfig",
  "SubtaskContext",
  "agent-moe",
  "moe-executor",
  "moe-parallelism",
  "plan-validator",
  "expert-model-check",
  "input-from",
];

/** Removed runtime files — must not come back. */
export const REMOVED_FILES = [
  "src/core/agent-moe.ts",
  "src/modules/execution/moe-executor.ts",
  "src/llm/orchestrator.ts",
  "src/modules/execution/plan-validator.ts",
  "src/modules/execution/input-from.ts",
  "src/modules/execution/expert-model-check.ts",
  "src/modules/execution/moe-parallelism.ts",
];

export interface ScanFile {
  /** Repo-relative path with forward slashes. */
  path: string;
  text: string;
}

/** Pure scanner: returns `path:line: <source line>` for every MoE surface hit. */
export function findMoESurface(files: ScanFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (WORD_RE.test(line) || MOE_TOKENS.some((token) => line.includes(token))) {
        offenders.push(`${file.path}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  return offenders;
}

function walk(dir: string, files: ScanFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), files);
      continue;
    }
    if (!entry.isFile() || !FILE_RE.test(entry.name)) continue;
    const full = join(dir, entry.name);
    files.push({
      path: relative(REPO_ROOT, full).replace(/\\/g, "/"),
      text: readFileSync(full, "utf-8"),
    });
  }
}

function scanRepo(): ScanFile[] {
  const files: ScanFile[] = [];
  walk(SCAN_ROOT, files);
  return files;
}

describe("no residual MoE surface", () => {
  it("src carries no MoE identifiers, keys, events or prose", () => {
    const offenders = findMoESurface(scanRepo());
    expect(
      offenders,
      `MoE was removed; its surface must not linger. Delete the reference or, if ` +
        `it is genuine history, move it to docs/agents/feature-history.md:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("the removed MoE runtime files stay gone", () => {
    const present = REMOVED_FILES.filter((f) => existsSync(join(REPO_ROOT, f)));
    expect(present, `Restored MoE runtime files: ${present.join(", ")}`).toEqual([]);
  });

  it("scanner flags MoE in fixture input", () => {
    const offenders = findMoESurface([
      {
        path: "src/fixture/offender.ts",
        text: [
          "const moeActive = true;",
          "// the MoE orchestrator ran the turn",
          "config.moe.enabled = true;",
          "interface MoEPlan {}",
          "config.orchestrator.model = 'x';",
        ].join("\n"),
      },
    ]);
    expect(offenders.length).toBe(5);
  });

  it("scanner ignores words that merely contain those letters", () => {
    const offenders = findMoESurface([
      {
        path: "src/fixture/innocent.ts",
        text: ["const mode = 'agent';", "const model = 'qwen';", "remodel(x);"].join("\n"),
      },
    ]);
    expect(offenders).toEqual([]);
  });
});
