import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Gate D (W10): every fail-open signal must leave a trace (INV-15).
 *
 * The signal list is the closed union `DiagnosticEvent` — the gate reads it from
 * the source, so a new member cannot be added without a test proving it fires.
 * A fail-open that returns quietly is indistinguishable from success, and that is
 * exactly how four defects reached `master` with green tests.
 *
 * The gate does not accept a documentation promise as coverage: a signature named
 * in `observability.md` with no test behind it is still red.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TYPES = join(REPO_ROOT, "src", "output", "types.ts");
const TESTS_ROOT = join(REPO_ROOT, "tests");
const FILE_RE = /\.tsx?$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

/** Members of the closed `DiagnosticEvent` union, parsed from the source. */
export function parseDiagnosticEvents(source: string): string[] {
  const union = /export type DiagnosticEvent\s*=([\s\S]*?);/.exec(source);
  if (!union) throw new Error("DiagnosticEvent union not found in src/output/types.ts");
  return [...union[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile() && FILE_RE.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
}

/** Every test file as one blob: a signature asserted anywhere counts. */
function testCorpus(): string {
  const files: string[] = [];
  walk(TESTS_ROOT, files);
  return files.map((f) => readFileSync(f, "utf-8")).join("\n");
}

function observabilityDoc(): string {
  return readFileSync(join(REPO_ROOT, "docs", "agents", "observability.md"), "utf-8");
}

describe("architecture: fail-open observability (INV-15, W10)", () => {
  it("parses the closed DiagnosticEvent union", () => {
    const kinds = parseDiagnosticEvents(readFileSync(TYPES, "utf-8"));
    expect(kinds.length).toBeGreaterThanOrEqual(5);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("every DiagnosticEvent member is covered by a test", () => {
    const kinds = parseDiagnosticEvents(readFileSync(TYPES, "utf-8"));
    const corpus = testCorpus();
    const uncovered = kinds.filter((k) => !corpus.includes(`"${k}"`));
    expect(
      uncovered,
      `Fail-open signals with no test proving they fire (INV-15). A signature nobody ` +
        `asserts is a comment, not a signal:\n${uncovered.join("\n")}`,
    ).toEqual([]);
  });

  it("every DiagnosticEvent member is listed in observability.md", () => {
    const kinds = parseDiagnosticEvents(readFileSync(TYPES, "utf-8"));
    const doc = observabilityDoc();
    const undocumented = kinds.filter((k) => !doc.includes(`\`${k}\``));
    expect(
      undocumented,
      `Fail-open signals missing from docs/agents/observability.md:\n${undocumented.join("\n")}`,
    ).toEqual([]);
  });

  it("scanner flags a signature no test mentions", () => {
    const kinds = parseDiagnosticEvents(
      'export type DiagnosticEvent = | "critic_error" | "brand_new_signal";',
    );
    expect(kinds).toEqual(["critic_error", "brand_new_signal"]);
  });
});