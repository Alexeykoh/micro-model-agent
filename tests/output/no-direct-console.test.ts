import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Task 13 — output-layer guard.
 *
 * Every chat line, spinner frame and diagnostic must go through the OutputBus /
 * OutputChannel so that modes (streaming/modal/quiet), the JSON sink and the
 * session sink all observe it. A stray `console.log` or `process.stdout.write`
 * silently bypasses all of that, so this test fails the build when one appears.
 *
 * Detection uses the TypeScript parser instead of a hand-rolled text masker.
 * A regex/masking approach cannot reliably tell a regex literal from division
 * (`if (x) /console\.log/.test(s)` vs `(a + b) / c`), and quote characters
 * inside regex character classes (e.g. `/["'']$/`, `/[...][^"'\s]+"?/`) desync
 * string masking for the rest of the file. The AST is unambiguous: only real
 * `console.<method>` and `process.<stdout|stderr>.write` member accesses match,
 * including ones nested inside template interpolations such as
 * `` `${console.log(x)}` ``, while comments, string literals, regex literals and
 * unrelated member accesses like `this.console.clear()` are ignored.
 *
 * Known limitations (accepted): computed access (`console["log"]`) and writes
 * through an alias (`const c = console; c.log(...)`) are not detected, and only
 * the global `console`/`process` identifiers are considered — `foo.console.log`
 * is intentionally not a match.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_ROOTS = ["src", "examples"];
const FILE_RE = /\.(ts|mjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

export const CONSOLE_METHODS = new Set(["log", "warn", "error", "info", "debug", "clear"]);
export const WRITE_STREAMS = new Set(["stdout", "stderr"]);

/**
 * Files with a genuine, justified exception. Keep this list tiny and always
 * explain why the file cannot route through the output layer.
 */
export const ALLOWLIST = new Set([
  "src/output/machine.ts", // the one legal raw-stdout JSON contract
  "src/core/crash-handler.ts", // crash reporting must survive a broken output layer
  "src/modules/browser/bridge-server.mjs", // separate child process; stdout is a JSON-RPC pipe
  "src/cli/repl.ts", // documented non-TTY printAbove fallback (single line)
]);

export interface ScanFile {
  /** Repo-relative path with forward slashes. */
  path: string;
  text: string;
}

function isIdentifier(node: ts.Node, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name;
}

/** `console.log` / `console.warn` … where `console` is the global identifier. */
function isConsoleWrite(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    isIdentifier(node.expression, "console") &&
    CONSOLE_METHODS.has(node.name.text)
  );
}

/** `process.stdout.write` / `process.stderr.write`. */
function isProcessStreamWrite(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "write") return false;
  const stream = node.expression;
  return (
    ts.isPropertyAccessExpression(stream) &&
    WRITE_STREAMS.has(stream.name.text) &&
    isIdentifier(stream.expression, "process")
  );
}

/**
 * Pure scanner: returns `path:line: <source line>` for every direct write.
 * Kept filesystem-free so the scanner itself can be unit-tested with fixtures.
 */
export function findDirectWrites(
  files: ScanFile[],
  allowlist: ReadonlySet<string> = ALLOWLIST,
): string[] {
  const offenders = new Set<string>();
  for (const file of files) {
    const path = file.path.replace(/\\/g, "/");
    if (allowlist.has(path)) continue;

    const kind = path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const source = ts.createSourceFile(path, file.text, ts.ScriptTarget.Latest, false, kind);
    const rawLines = file.text.split(/\r?\n/);

    const visit = (node: ts.Node): void => {
      if (isConsoleWrite(node) || isProcessStreamWrite(node)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        offenders.add(`${path}:${line + 1}: ${rawLines[line].trim()}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...offenders];
}

function walk(dir: string, files: ScanFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), files);
      continue;
    }
    if (!entry.isFile() || !FILE_RE.test(entry.name)) continue;
    if (/\.(test|spec)\./.test(entry.name)) continue;
    const full = join(dir, entry.name);
    files.push({
      path: relative(REPO_ROOT, full).replace(/\\/g, "/"),
      text: readFileSync(full, "utf-8"),
    });
  }
}

function scanRepo(): ScanFile[] {
  const files: ScanFile[] = [];
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), files);
  return files;
}

describe("no direct terminal writes", () => {
  it("src and examples route all output through the output layer", () => {
    const offenders = findDirectWrites(scanRepo());
    expect(
      offenders,
      `Direct terminal writes bypass OutputBus/OutputChannel. Route them through ` +
        `getDefaultChannel(), defaultOutputBus, or writeMachineJson() — or add a ` +
        `justified allowlist entry in tests/output/no-direct-console.test.ts:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("flags a raw console.log in fixture input", () => {
    const offenders = findDirectWrites([
      {
        path: "src/fixture/offender.ts",
        text: 'export function f() {\n  console.log("x");\n}\n',
      },
    ]);
    expect(offenders).toEqual(['src/fixture/offender.ts:2: console.log("x");']);
  });

  it("flags a write inside a template interpolation", () => {
    const offenders = findDirectWrites([
      { path: "src/fixture/template.ts", text: "const s = `${console.log(x)}`;\n" },
    ]);
    expect(offenders).toEqual(["src/fixture/template.ts:1: const s = `${console.log(x)}`;"]);
  });

  it("ignores regex literals (no regex-vs-division guessing)", () => {
    const offenders = findDirectWrites([
      {
        path: "src/fixture/regex.ts",
        text: "if (x) /console\\.log/.test(s);\nif (y) /console.log/.test(s);\n",
      },
    ]);
    expect(offenders).toEqual([]);
  });

  it("ignores member access, comments, strings and aliased process streams", () => {
    const offenders = findDirectWrites([
      {
        path: "src/fixture/innocent.ts",
        text: [
          "// console.log('in a comment')",
          "/* process.stdout.write('in a block comment') */",
          'const hint = "call console.log to print";',
          "this.console.clear();",
          "other.process.stdout.write('not the global process');",
          "// process.stderr.write('nope')",
        ].join("\n"),
      },
    ]);
    expect(offenders).toEqual([]);
  });
});
