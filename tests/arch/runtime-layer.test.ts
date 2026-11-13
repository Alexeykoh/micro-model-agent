import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture gate: нейтральный runtime-слой (monolith split, W0).
 *
 * `src/runtime/**` — общий слой транспорта и пула прогонов. Он не знает про
 * веб-модуль и не тянет `core/agent`; `service` и `core` больше не зависят от
 * `modules/webui`. Правило без гейта живёт до следующего большого изменения
 * (AGENTS.md, правило 5).
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SRC_ROOT = join(REPO_ROOT, "src");
const FILE_RE = /\.(ts|tsx)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
const IMPORT_SPEC_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const WEBUI_RE = /(?:^|\/)webui(?:\/|$)/;

export interface ScanFile {
  path: string;
  text: string;
}

/** Рекурсивно собирает `.ts`/`.tsx` под каталогом (repo-relative пути). */
export function collectSourceFiles(dir: string = SRC_ROOT, root: string = REPO_ROOT): ScanFile[] {
  const files: ScanFile[] = [];
  const walk = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!FILE_RE.test(entry.name)) continue;
      files.push({
        path: relative(root, abs).replace(/\\/g, "/"),
        text: readFileSync(abs, "utf-8"),
      });
    }
  };
  walk(dir);
  return files;
}

/** Импорты `modules/webui` в файлах, чей путь подпадает под `prefixes`. */
export function findWebuiImports(files: ScanFile[], prefixes: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (!prefixes.some((p) => file.path.startsWith(p))) continue;
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      IMPORT_SPEC_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMPORT_SPEC_RE.exec(lines[i])) !== null) {
        if (WEBUI_RE.test(m[1])) offenders.push(`${file.path}:${i + 1}: ${m[1]}`);
      }
    }
  }
  return offenders;
}

describe("runtime layer boundaries", () => {
  it("service does not import the web module", () => {
    const offenders = findWebuiImports(collectSourceFiles(), ["src/modules/service/"]);
    expect(offenders, `service -> webui:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("core does not import the web module", () => {
    const offenders = findWebuiImports(collectSourceFiles(), ["src/core/"]);
    expect(offenders, `core -> webui:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("runtime layer does not import the web module", () => {
    const offenders = findWebuiImports(collectSourceFiles(), ["src/runtime/"]);
    expect(offenders, `runtime -> webui:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("detects a forbidden import (gate is not vacuous)", () => {
    const files: ScanFile[] = [
      {
        path: "src/modules/service/example.ts",
        text: 'import { apiGuard } from "../webui/egress";\nconst x = await import("../../modules/webui/util");',
      },
    ];
    const offenders = findWebuiImports(files, ["src/modules/service/"]);
    expect(offenders).toHaveLength(2);
    expect(offenders[0]).toContain("src/modules/service/example.ts:1");
  });
});
