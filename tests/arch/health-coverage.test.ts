import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Гейт долга observability-health-coverage (§5 спеки 2026-11-05): шесть
 * подсистем обязаны отдавать честный `health()`. Модуль без `health()` в
 * lifecycle-контракте или класс без метода `health()` — молчаливое «сделано»
 * без проверки (правило 5).
 */
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const MODULES = ["lsp", "mcp", "browser", "indexer", "skills", "memory"] as const;

describe("health coverage (observability §3.6)", () => {
  for (const name of MODULES) {
    it(`${name}: lifecycle declares health`, () => {
      const text = readFileSync(join(ROOT, "src", "modules", name, "lifecycle.ts"), "utf-8");
      expect(text, `${name}/lifecycle.ts: missing health:`).toContain("health:");
    });

    it(`${name}: class implements health()`, () => {
      // Класс живёт в module.ts у всех шести, кроме skills (там module.ts тоже).
      const text = readFileSync(join(ROOT, "src", "modules", name, "module.ts"), "utf-8");
      expect(text, `${name}/module.ts: missing health()`).toContain("health()");
      // Честность: health не должен быть константным `ok` без условий.
      const healthIdx = text.indexOf("health()");
      const snippet = text.slice(healthIdx, healthIdx + 800);
      expect(snippet, `${name}: health() looks constant-ok`).toMatch(/degraded|failed/);
    });
  }
});
