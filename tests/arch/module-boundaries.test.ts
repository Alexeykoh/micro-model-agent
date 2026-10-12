import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture gate (rules INV-3/INV-4, W1.4).
 *
 * A module must not reach into the core's internals: it talks to the core
 * through the declared API (`src/core/api/**`, W4). The allowlist is now empty —
 * any module import of `core/agent` fails the build, so the contract cannot
 * silently rot.
 *
 * INV-4 (a module must not call another module's `tool.handler`) is clean and
 * enforced with an empty allowlist.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MODULES_ROOT = join(REPO_ROOT, "src", "modules");
const FILE_RE = /\.(ts|tsx)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
/** Спецификатор импорта, ведущий внутрь ядра: `core/agent` или `core/agent/*`. */
const CORE_AGENT_RE = /(?:^|\/)core\/agent(?:\/|$)/;
const IMPORT_SPEC_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const FOREIGN_HANDLER_RE = /\.handler\s*\(/;

/**
 * Разрешённые импорты модулей в `core/agent*`. **Пусто** (W4): модуль ходит в
 * ядро только через публичный `src/core/api/**`. Любой новый прямой импорт
 * `core/agent` из модуля — падение.
 */
export const CORE_AGENT_ALLOWLIST: Record<string, string> = {};

/** Разрешённые вызовы чужого `tool.handler` (INV-4). Сейчас — пусто. */
export const FOREIGN_HANDLER_ALLOWLIST: Record<string, string> = {};

export interface ScanFile {
  /** Repo-relative path with forward slashes. */
  path: string;
  text: string;
}

/** Возвращает `path:line: <specifier>` для каждого импорта в `core/agent*`. */
export function findCoreAgentImports(
  files: ScanFile[],
  allowlist: Readonly<Record<string, string>> = CORE_AGENT_ALLOWLIST,
): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (allowlist[file.path]) continue;
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      IMPORT_SPEC_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMPORT_SPEC_RE.exec(lines[i])) !== null) {
        if (CORE_AGENT_RE.test(m[1])) {
          offenders.push(`${file.path}:${i + 1}: ${m[1]}`);
        }
      }
    }
  }
  return offenders;
}

/** Возвращает `path:line: <text>` для вызовов `.handler(` вне allowlist. */
export function findForeignHandlerCalls(
  files: ScanFile[],
  allowlist: Readonly<Record<string, string>> = FOREIGN_HANDLER_ALLOWLIST,
): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (allowlist[file.path]) continue;
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (FOREIGN_HANDLER_RE.test(lines[i])) offenders.push(`${file.path}:${i + 1}: ${lines[i].trim()}`);
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

function scanModules(): ScanFile[] {
  const files: ScanFile[] = [];
  walk(MODULES_ROOT, files);
  return files;
}

describe("architecture: module boundaries (INV-3/INV-4)", () => {
  it("modules import the core only via the allowlisted set", () => {
    const offenders = findCoreAgentImports(scanModules());
    expect(
      offenders,
      `Module reached into core/agent internals (INV-3). Talk to the core via its ` +
        `public API, or add a justified allowlist entry in ` +
        `tests/arch/module-boundaries.test.ts:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("modules do not call another module's tool.handler (INV-4)", () => {
    const offenders = findForeignHandlerCalls(scanModules());
    expect(
      offenders,
      `Module called a tool handler directly (INV-4). Go through ToolExecutor:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("scanner flags a new core/agent import in fixture input", () => {
    const offenders = findCoreAgentImports([
      { path: "src/modules/foo/module.ts", text: 'import { Agent } from "../../core/agent";\n' },
    ]);
    expect(offenders).toEqual(['src/modules/foo/module.ts:1: ../../core/agent']);
  });

  it("scanner ignores unrelated imports", () => {
    const offenders = findCoreAgentImports([
      { path: "src/modules/foo/module.ts", text: 'import { X } from "../../config/types";\n' },
    ]);
    expect(offenders).toEqual([]);
  });
});
