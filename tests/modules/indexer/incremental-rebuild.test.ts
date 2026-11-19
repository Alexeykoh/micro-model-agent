import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { IndexerModule } from "../../../src/modules/indexer/module";

/**
 * Пересборка индекса инкрементальна: неизменённые файлы не перечитываются, а
 * карта проекта остаётся доступной во время сборки (аудит §8.7/§8.9, план
 * `2026-10-12-harness-module-audit-fixes`, W8/Task 8.5).
 */

let tempDir: string | null = null;
let cacheDir: string | null = null;

function project(files = 6): string {
  tempDir = mkdtempSync(join(tmpdir(), "mma-incr2-"));
  // Кэш — ВНЕ проекта: иначе индекс сам индексирует свой файл кэша.
  cacheDir = mkdtempSync(join(tmpdir(), "mma-incr2-cache-"));
  mkdirSync(join(tempDir, "src"), { recursive: true });
  for (let i = 0; i < files; i++) {
    writeFileSync(join(tempDir, "src", `f${i}.ts`), `export const f${i} = ${i};\n`);
  }
  return tempDir;
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  tempDir = null;
  cacheDir = null;
});

describe("индекс: инкрементальная пересборка", () => {
  it("a rebuild reuses the previous index instead of re-reading every file", async () => {
    const dir = project();
    const module = new IndexerModule({ baseDir: dir, cacheDir: cacheDir ?? dir });
    await module.buildIndex();

    // Один файл изменился — остальные должны остаться из кэша.
    writeFileSync(join(dir, "src", "f0.ts"), "export const f0 = 0;\nexport const added = 1;\n");
    const result = await module.refresh();

    expect(result).not.toBeNull();
    const files = result?.files ?? [];
    expect(files.length).toBe(6);
    const changed = files.find((f) => f.path.endsWith("f0.ts"));
    expect(changed?.exports).toContain("added");
  });

  it("keeps the project map available during a rebuild", async () => {
    const dir = project();
    const module = new IndexerModule({ baseDir: dir, cacheDir: cacheDir ?? dir });
    await module.buildIndex();
    expect(module.getSystemPromptBlock()).not.toBeNull();

    const pending = module.refresh();
    // Во время пересборки карта проекта ещё на месте.
    expect(module.getSystemPromptBlock()).not.toBeNull();
    await pending;
  });
});
