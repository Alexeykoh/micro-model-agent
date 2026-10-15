import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Gate: локаль тестов изолирована между файлами.
 *
 * `setLocale` — процессный синглтон, а порядок файлов в раннере зависит от ФС
 * (на Windows один, на CI/ext4 другой). Файл, выставивший не-`en` локаль без
 * сброса, тихо ломает все файлы с английскими строками, которые выполнятся
 * после него — локально зелёно, на CI красно. Именно так упал quality на
 * Linux и Windows-раннерах (15 тестов), хотя дефолт везде "en".
 *
 * Правило: файл с `setLocale("<не-en>")` обязан сбрасывать на "en" в том же
 * файле (`afterEach`/`afterAll`). Плюс файлы с английскими строками пинят
 * "en" в `beforeEach` сами (прецедент: `cache-line.test.ts`).
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TESTS_ROOT = join(REPO_ROOT, "tests");
const SKIP_DIRS = new Set(["node_modules", "fixtures", "snapshots"]);

const SET_RE = /setLocale\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const RESET_RE = /(?:afterEach|afterAll)\(\s*\(\s*\)\s*=>\s*setLocale\(\s*["'`]en["'`]\s*\)/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(join(dir, entry.name));
  }
}

export interface LocaleSite {
  file: string;
  line: number;
  locale: string;
}

/** Все `setLocale("<x>")` с x != "en" (экспорт — для позитивного контроля). */
export function findNonDefaultLocales(source: string, file: string): LocaleSite[] {
  const sites: LocaleSite[] = [];
  const lines = source.split("\n");
  lines.forEach((line, i) => {
    SET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SET_RE.exec(line)) !== null) {
      if (m[1] !== "en") sites.push({ file, line: i + 1, locale: m[1] });
    }
  });
  return sites;
}

/** Файл сбрасывает локаль на "en" в afterEach/afterAll (включая мультистрочные). */
export function resetsLocale(source: string): boolean {
  return /(?:afterEach|afterAll)\([\s\S]{0,120}?setLocale\(\s*["']en["']\s*\)/.test(source);
}

describe("gate: test locale does not leak across files", () => {
  const files: string[] = [];
  walk(TESTS_ROOT, files);

  it("finds a non-default locale and a missing reset in fixtures (positive control)", () => {
    const dirty = 'it("x", () => {\n  setLocale("ru");\n});';
    expect(findNonDefaultLocales(dirty, "dirty.ts").map((s) => s.locale)).toEqual(["ru"]);
    expect(resetsLocale(dirty)).toBe(false);
    const clean = 'afterEach(() => setLocale("en"));\nit("x", () => {\n  setLocale("ru");\n});';
    expect(resetsLocale(clean)).toBe(true);
  });

  it("every file that sets a non-default locale resets it in the same file", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf-8");
      const sites = findNonDefaultLocales(text, f);
      if (sites.length > 0 && !resetsLocale(text)) {
        offenders.push(
          ...sites.map(
            (s) => `${relative(REPO_ROOT, f)}:${s.line} — setLocale("${s.locale}") без сброса`,
          ),
        );
      }
    }
    expect(
      offenders,
      "Файл меняет процессную локаль и не сбрасывает её: порядок файлов на CI иной, " +
        "и все английские строки после него покраснеют:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
