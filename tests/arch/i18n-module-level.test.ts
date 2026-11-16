/**
 * W13: i18n-аудит кэшированных строк (rule: locale — свойство запроса).
 *
 * `t()` резолвит локаль из ALS запроса, иначе из boot-локали. Строка, вычисленная
 * НА УРОВНЕ МОДУЛЯ, замирает до рестарта процесса: для демона с несколькими
 * клиентами это неверно. Гвард запрещает новый `const X = t(...)` на верхнем
 * уровне `src/**` и держит список существующих исключений пустым.
 *
 * Осознанное исключение — `src/i18n/index.ts` (сам словарь) и web-assets
 * (там собственный клиентский `t()`).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SRC = join(REPO_ROOT, "src");

/** Модульный вызов `t()` на верхнем уровне файла. */
const MODULE_LEVEL_T = /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*t\(/m;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "assets") continue;
      walk(full, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("i18n: локаль не кэшируется на уровне модуля (W13)", () => {
  it("no top-level t() in src (assets excluded)", () => {
    const offenders = walk(SRC)
      .filter((file) => MODULE_LEVEL_T.test(readFileSync(file, "utf8")))
      .map((file) => relative(REPO_ROOT, file).replace(/\\/g, "/"));
    expect(
      offenders,
      "Строки, вычисленные на старте, не переключаются вместе с локалью запроса: " +
        "резолвите t() внутри функции/рендера или пометьте исключение в комментарии к гварду.",
    ).toEqual([]);
  });
});
