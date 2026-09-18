import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 13 — output-layer guard.
 *
 * Every chat line, spinner frame and diagnostic must go through the OutputBus /
 * OutputChannel so that modes (streaming/modal/quiet), the JSON sink and the
 * session sink all observe it. A stray `console.log` or `process.stdout.write`
 * silently bypasses all of that, so this test fails the build when one appears.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_ROOTS = ["src", "examples"];
const FILE_RE = /\.(ts|mjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

/**
 * The canonical forbidden pattern. Run over code with comments and string
 * literals stripped ({@link maskNonCode}) so a mention of `console.log` in a
 * prompt, hint or doc comment is not mistaken for an actual write.
 */
export const FORBIDDEN =
  /\bconsole\.(log|warn|error|info|debug|clear)\b|process\.(stdout|stderr)\.write\b/;

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

type MaskState =
  "code" | "line" | "block" | "single" | "double" | "template" | "regex" | "regexClass";

/** Keywords after which a `/` opens a regex literal rather than division. */
const REGEX_PREFIX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

function isRegexStart(prev: string, word: string): boolean {
  if (REGEX_PREFIX_KEYWORDS.has(word)) return true;
  if (prev === "") return true;
  return "(,=:[!&|?{};+-*%^~<>".includes(prev);
}

/**
 * Replace every character inside a comment, string or regex literal with a
 * space while preserving newlines, so line numbers stay aligned for reporting.
 * This lets the forbidden regex run without matching text that merely quotes
 * `console.log`. Regex detection uses the usual "previous token" heuristic,
 * which is enough to avoid quote/backtick characters inside character classes
 * (e.g. `/["']$/`) desyncing the scanner.
 */
export function maskNonCode(text: string): string {
  const out: string[] = [];
  let state: MaskState = "code";
  let prev = "";
  let word = "";

  const wordChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (state === "code") {
      if (ch === "/" && next === "/") {
        out.push(" ", " ");
        i++;
        state = "line";
      } else if (ch === "/" && next === "*") {
        out.push(" ", " ");
        i++;
        state = "block";
      } else if (ch === "/" && isRegexStart(prev, word)) {
        out.push(" ");
        state = "regex";
      } else if (ch === '"') {
        out.push(" ");
        state = "double";
      } else if (ch === "'") {
        out.push(" ");
        state = "single";
      } else if (ch === "`") {
        out.push(" ");
        state = "template";
      } else {
        out.push(ch);
        if (!/\s/.test(ch)) {
          if (wordChar(ch)) word += ch;
          else word = "";
          prev = ch;
        }
      }
      continue;
    }

    if (state === "line") {
      out.push(ch === "\n" ? "\n" : " ");
      if (ch === "\n") state = "code";
      continue;
    }

    if (state === "block") {
      if (ch === "*" && next === "/") {
        out.push(" ", " ");
        i++;
        state = "code";
      } else {
        out.push(ch === "\n" ? "\n" : " ");
      }
      continue;
    }

    if (state === "regex") {
      if (ch === "\\") {
        out.push(" ", " ");
        i++;
      } else if (ch === "[") {
        out.push(" ");
        state = "regexClass";
      } else if (ch === "/") {
        out.push(" ");
        state = "code";
      } else {
        out.push(ch === "\n" ? "\n" : " ");
      }
      continue;
    }

    if (state === "regexClass") {
      if (ch === "\\") {
        out.push(" ", " ");
        i++;
      } else if (ch === "]") {
        out.push(" ");
        state = "regex";
      } else {
        out.push(ch === "\n" ? "\n" : " ");
      }
      continue;
    }

    // Inside single/double/template string.
    if (ch === "\\") {
      if (next === "\n") {
        out.push(" ", "\n");
        i++;
      } else {
        out.push(" ", " ");
        i++;
      }
      continue;
    }
    const closes =
      (state === "double" && ch === '"') ||
      (state === "single" && ch === "'") ||
      (state === "template" && ch === "`");
    if (closes) {
      out.push(" ");
      state = "code";
      continue;
    }
    out.push(ch === "\n" ? "\n" : " ");
  }

  return out.join("");
}

/** True when a masked line contains a global write (not `obj.console.clear()`). */
function isDirectWrite(maskedLine: string): boolean {
  const scan = new RegExp(FORBIDDEN.source, "g");
  for (const match of maskedLine.matchAll(scan)) {
    const index = match.index ?? 0;
    if (maskedLine[index - 1] !== ".") return true;
  }
  return false;
}

/**
 * Pure scanner: returns `path:line: <source line>` for every direct write.
 * Kept filesystem-free so the scanner itself can be unit-tested with fixtures.
 */
export function findDirectWrites(
  files: ScanFile[],
  allowlist: ReadonlySet<string> = ALLOWLIST,
): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const path = file.path.replace(/\\/g, "/");
    if (allowlist.has(path)) continue;
    const rawLines = file.text.split(/\r?\n/);
    const maskedLines = maskNonCode(file.text).split(/\r?\n/);
    for (let line = 0; line < maskedLines.length; line++) {
      if (isDirectWrite(maskedLines[line])) {
        offenders.push(`${path}:${line + 1}: ${rawLines[line].trim()}`);
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

  it("ignores member access, comments and quoted mentions", () => {
    const offenders = findDirectWrites([
      {
        path: "src/fixture/innocent.ts",
        text: [
          "// console.log('in a comment')",
          "/* process.stdout.write('in a block comment') */",
          'const hint = "call console.log to print";',
          "this.console.clear();",
          "// process.stderr.write('nope')",
        ].join("\n"),
      },
    ]);
    expect(offenders).toEqual([]);
  });
});
