import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Gate: у каждого условного пропуска теста есть ПРИЧИНА, и список объявлен (W6, D4).
 *
 * Половина набора — Windows-only или требуeт браузера/симлинков/сети. Такие
 * тесты не удаляют и не «чинят»: они проверяют платформенное поведение на своей
 * платформе. Но `it.skip("...")` без причины неотличим от «тест не работает и
 * его спрятали». Здесь каждое место пропуска объявлено в `SKIP_MANIFEST` с
 * причиной; гейт падает на необъявленном пропуске и на протухшей записи —
 * ровно как `UNCOVERED_CONTEXT_METHODS` в W9.
 *
 * `tests/integration/**` и `tests/e2e/**` исключены: они не в гейте (нужен
 * живой LLM/браузер) и пропускаются целиком.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TESTS_ROOT = join(REPO_ROOT, "tests");
const SKIP_DIRS = new Set(["integration", "e2e", "fixtures", "node_modules"]);

/** Место условного пропуска: `ключ` — заголовок теста или имя skip-хелпера. */
export interface SkipSite {
  file: string;
  key: string;
  line: number;
  kind: "conditional-skip" | "skip-helper" | "platform-guard";
}

const STRING_RE = /["'`]([^"'`\n]+)["'`]/;
const SKIP_CALL_RE = /^\s*(?:it|describe)\.(?:skipIf|skip)\b/;
const HELPER_RE = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*\?\s*it\s*:\s*it\.skip\b/;
const GUARD_RE = /(?:process\.)?platform(?:\(\))?\s*(?:!==|===)\s*["']win32["']/;
const TEST_HEAD_RE = /^\s*(?:it|describe)(?:\.\w+)*(?:\(\s*)?["'`]/;

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(join(dir, entry.name));
  }
}

/** Находит все условные пропуски в исходнике (экспорт — для позитивного контроля). */
export function findSkipSites(source: string, file: string): SkipSite[] {
  const lines = source.split("\n");
  const sites: SkipSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const near = line + "\n" + (lines[i + 1] ?? "");
    const helper = HELPER_RE.exec(line);
    if (helper) {
      sites.push({ file, key: helper[1], line: i + 1, kind: "skip-helper" });
      continue;
    }
    if (SKIP_CALL_RE.test(line)) {
      const title = STRING_RE.exec(near)?.[1];
      if (title) sites.push({ file, key: title, line: i + 1, kind: "conditional-skip" });
      continue;
    }
    if (GUARD_RE.test(line) && /\breturn\b/.test(line)) {
      let title = "";
      for (let j = i - 1; j >= 0 && j > i - 40; j--) {
        if (TEST_HEAD_RE.test(lines[j])) {
          title = STRING_RE.exec(lines[j])?.[1] ?? "";
          break;
        }
      }
      if (title) sites.push({ file, key: title, line: i + 1, kind: "platform-guard" });
    }
  }
  return sites;
}

/**
 * Объявленные пропуски. `key` — заголовок теста (для `skipIf`/`skip`/guard) или
 * имя skip-хелпера. Причина обязательна и содержательна.
 */
export const SKIP_MANIFEST: Array<{ file: string; key: string; reason: string }> = [
  {
    file: "tests/browser-bridge.test.ts",
    key: "pings the node bridge over stdio",
    reason: "CI не держит node-bridge-процесс живым — проверяется на dev-машине",
  },
  {
    file: "tests/browser-bridge.test.ts",
    key: "one-shot restart: a dead bridge is respawned on the next send",
    reason: "то же: respawn мёртвого bridge требует локального процесса",
  },
  {
    file: "tests/browser-bridge.test.ts",
    key: "close() does not respawn a dead bridge",
    reason: "то же: наблюдаемый child_process — только на dev-машине",
  },
  {
    file: "tests/hallucination-factual.test.ts",
    key: "passes when absolute Windows path matches an existing file",
    reason: "зависит от абсолютного пути хоста — проверяется на dev-машине",
  },
  {
    file: "tests/install-dryrun.test.ts",
    key: "install.sh prints the macOS/Linux plan",
    reason: "POSIX-установщик запускается только на не-Windows хосте",
  },
  {
    file: "tests/install-dryrun.test.ts",
    key: "install.ps1 prints the Windows plan",
    reason: "PowerShell-установщик запускается только на Windows хосте",
  },
  {
    file: "tests/browser-session.test.ts",
    key: "opens a page and returns snapshot (requires browser)",
    reason: "нужен реальный Chromium — вне гейта",
  },
  {
    file: "tests/webui-file.test.ts",
    key: "refuses a symlink that escapes the workspace",
    reason: "симлинки требуют прав на ОС (на Windows без developer mode недоступны)",
  },
  {
    file: "tests/webui-file.test.ts",
    key: "refuses a file reached through a linked directory",
    reason: "junction/симлинк каталога требует прав на ОС",
  },
  {
    file: "tests/webui-smoke.test.ts",
    key: "smoke",
    reason: "нужен Chromium и Node-vitest (Bun не держит динамический skip)",
  },
  {
    file: "tests/bash-process-hint.test.ts",
    key: "winOnly",
    reason: "POSIX-workdir на Windows — поведение существует только на win32",
  },
  {
    file: "tests/bash.test.ts",
    key: "hard-blocks a command after repeated consecutive failures (win32 only)",
    reason: "`head` блокируется только на win32 (на POSIX он работает)",
  },
  {
    file: "tests/bash.test.ts",
    key: "hints on the ORIGINAL first word even when it was translated (cat→type)",
    reason: "трансляция `cat`→`type` — платформенный факт win32",
  },
  {
    file: "tests/lsp-command.test.ts",
    key: "spawns a .cmd shim through the shell on win32 (no EINVAL)",
    reason: ".cmd-шим и shell-путь spawn существуют только на win32",
  },
];

describe("gate: platform-conditional skips are declared with a reason (W6)", () => {
  const files: string[] = [];
  walk(TESTS_ROOT, files);
  const sites = files.flatMap((f) =>
    findSkipSites(readFileSync(f, "utf-8"), relative(REPO_ROOT, f).replace(/\\/g, "/")),
  );
  const declared = new Set(SKIP_MANIFEST.map((m) => `${m.file}::${m.key}`));

  it("scanned enough tests and found the known skip sites (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(sites.length).toBeGreaterThanOrEqual(SKIP_MANIFEST.length);
  });

  it("detects an undeclared conditional skip (positive control)", () => {
    const synthetic = 'it.skipIf(Boolean(process.env.CI))("hidden", () => {});';
    expect(findSkipSites(synthetic, "synthetic.ts").map((s) => s.key)).toEqual(["hidden"]);
  });

  it("every conditional skip in the gated tree is declared", () => {
    const undeclared = sites
      .filter((s) => !declared.has(`${s.file}::${s.key}`))
      .map((s) => `${s.file}:${s.line} (${s.kind}) — ${s.key}`);
    expect(
      undeclared,
      "Пропуск без объявления: добавь его в SKIP_MANIFEST с причиной, " +
        `либо не пропускай тест:\n${undeclared.join("\n")}`,
    ).toEqual([]);
  });

  it("every declared skip still exists (no stale manifest row)", () => {
    const found = new Set(sites.map((s) => `${s.file}::${s.key}`));
    const stale = SKIP_MANIFEST.map((m) => `${m.file}::${m.key}`).filter((k) => !found.has(k));
    expect(stale, `Запись объявляет пропуск, которого нет: ${stale.join(", ")}`).toEqual([]);
  });

  it("every declared skip carries a real reason", () => {
    const weak = SKIP_MANIFEST.filter((m) => m.reason.trim().length < 20).map((m) => m.key);
    expect(weak, `Пропуск без причины: ${weak.join(", ")}`).toEqual([]);
  });
});
