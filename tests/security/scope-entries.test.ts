/**
 * Контракт записи скоупа субагента (спека
 * `docs/specs/2026-11-02-subagent-scope-entries-design.md`, A1):
 * путь / glob / абсолютная запись / `**` = весь workspace.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "path";
import {
  formatScopeEntries,
  isAbsoluteScopeEntry,
  matchesScopeEntry,
  normalizeScopeEntries,
  normalizeScopeEntry,
} from "../../src/modules/security/scope";
import { globToRegExp } from "../../src/modules/security/path-glob";

const BASE = resolve("/workspace");
const at = (rel: string) => resolve(BASE, rel);

describe("scope entries: нормализация", () => {
  it("снимает ./, хвостовой /, схлопывает // и бэкслэши", () => {
    expect(normalizeScopeEntry("./src/")).toBe("src");
    expect(normalizeScopeEntry("src\\lib\\")).toBe("src/lib");
    expect(normalizeScopeEntry("src//lib")).toBe("src/lib");
    expect(normalizeScopeEntry("  docs  ")).toBe("docs");
  });

  it("сохраняет UNC-префикс", () => {
    expect(normalizeScopeEntry("\\\\srv\\share\\dir")).toBe("//srv/share/dir");
  });

  it("отличает абсолютные записи", () => {
    expect(isAbsoluteScopeEntry("/opt/data")).toBe(true);
    expect(isAbsoluteScopeEntry("C:/data")).toBe(true);
    expect(isAbsoluteScopeEntry("//srv/share")).toBe(true);
    expect(isAbsoluteScopeEntry("src")).toBe(false);
  });

  it("пустая запись и . невалидны, абсолютная — легальна", () => {
    expect(normalizeScopeEntries(["", "."]).invalid).toHaveLength(2);
    expect(normalizeScopeEntries(["../escape", "src/../out"]).invalid).toHaveLength(2);
    expect(normalizeScopeEntries(["/opt/data/report.txt"]).invalid).toHaveLength(0);
  });

  it("дедуплицирует и сохраняет порядок", () => {
    const { entries } = normalizeScopeEntries(["./src/", "src", "docs"]);
    expect(entries).toEqual(["src", "docs"]);
  });
});

describe("scope entries: матчинг", () => {
  it("каталог — сам и всё внутри (прежняя семантика)", () => {
    expect(matchesScopeEntry(at("src/a.ts"), "src", BASE)).toBe(true);
    expect(matchesScopeEntry(at("src/deep/a.ts"), "src", BASE)).toBe(true);
    expect(matchesScopeEntry(at("docs/a.md"), "src", BASE)).toBe(false);
  });

  it("glob в скоупе сопоставляется (A1: раньше не работал вообще)", () => {
    expect(matchesScopeEntry(at("src/a.ts"), "src/**/*.ts", BASE)).toBe(true);
    expect(matchesScopeEntry(at("src/x/y.ts"), "src/**/*.ts", BASE)).toBe(true);
    expect(matchesScopeEntry(at("src/a.md"), "src/**/*.ts", BASE)).toBe(false);
    expect(matchesScopeEntry(at("docs/a.md"), "src/**/*.ts", BASE)).toBe(false);
  });

  it("glob без префикса — по имени файла в любом каталоге", () => {
    expect(matchesScopeEntry(at("README.md"), "**/*.md", BASE)).toBe(true);
    expect(matchesScopeEntry(at("docs/a.md"), "**/*.md", BASE)).toBe(true);
    expect(matchesScopeEntry(at("package.json"), "*.json", BASE)).toBe(true);
    expect(matchesScopeEntry(at("src/package.json"), "*.json", BASE)).toBe(true);
  });

  it("** = весь workspace", () => {
    expect(matchesScopeEntry(at("src/deep/a.ts"), "**", BASE)).toBe(true);
    expect(matchesScopeEntry(at("README.md"), "**", BASE)).toBe(true);
  });

  it("абсолютная запись сверяется как абсолютный путь", () => {
    const entry = resolve("/opt/data/report.txt");
    expect(matchesScopeEntry(entry, entry, BASE)).toBe(true);
    expect(matchesScopeEntry(resolve("/opt/data/other.txt"), entry, BASE)).toBe(false);
    expect(matchesScopeEntry(resolve("/opt/data/report.txt"), "/opt/data/*.txt", BASE)).toBe(true);
    expect(matchesScopeEntry(resolve("/opt/data/report.md"), "/opt/data/*.txt", BASE)).toBe(false);
  });
});

describe("scope entries: состав в причине отказа (INV-S4)", () => {
  it("капнут до 5 записей", () => {
    const entries = ["a", "b", "c", "d", "e", "f", "g"];
    const text = formatScopeEntries(entries);
    expect(text).toContain("a, b, c, d, e");
    expect(text).toContain("+2 more");
    expect(text).not.toContain("f");
  });
});

describe("globToRegExp: грамматика", () => {
  it("понимает ** с суффиксным шаблоном (прежний матчер — нет)", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/x/y.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/a.md")).toBe(false);
  });

  it("**/ в середине допускает ноль сегментов", () => {
    expect(globToRegExp("a/**/b").test("a/b")).toBe(true);
    expect(globToRegExp("a/**/b").test("a/x/y/b")).toBe(true);
  });

  it("src/** ловит сам каталог и детей", () => {
    expect(globToRegExp("src/**").test("src")).toBe(true);
    expect(globToRegExp("src/**").test("src/a.ts")).toBe(true);
  });

  it("**/secrets/** ловит каталог и всё под ним", () => {
    expect(globToRegExp("**/secrets/**").test("a/secrets/b.txt")).toBe(true);
    expect(globToRegExp("**/secrets/**").test("secrets")).toBe(true);
    expect(globToRegExp("**/secrets/**").test("src/a.ts")).toBe(false);
  });

  it("* не переходит через сегмент, ? — один символ", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/x/a.ts")).toBe(false);
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
  });
});
