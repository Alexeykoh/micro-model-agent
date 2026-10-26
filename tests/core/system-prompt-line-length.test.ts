// Канон системного промпта: одна директива — одна строка ≤120 символов.
// Длинную директиву маленькая модель теряет; склейка через `+` сохраняет
// текст, но не растягивает строку исходника.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE = readFileSync(join(REPO_ROOT, "src", "core", "system-prompt.ts"), "utf-8");

describe("system prompt line length", () => {
  it("has no prompt string line longer than 120 characters", () => {
    const long = SOURCE.split("\n")
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => line.trimStart().startsWith("`") && line.length > 120)
      .map(({ line, index }) => `${index}: ${line.length} chars`);
    expect(long, `Слишком длинные строки промпта: ${long.join("; ")}`).toEqual([]);
  });
});
