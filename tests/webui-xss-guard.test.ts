import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guard-тесты против XSS-регрессий во фронтенде `mma web` (аудит §6.18,
 * план `2026-10-12-harness-module-audit-fixes`, W6/Task 6.8b).
 *
 * Фронтенд — единственная полностью чистая подсистема аудита: вывод идёт
 * через `createTextNode`, highlight — через инертный `DOMParser`, URL — через
 * allowlist схем. Волны 6 и 9 трогают `assets/**`, поэтому эти проверки
 * фиксируют инвариант.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ASSETS_DIR = join(REPO_ROOT, "src", "modules", "webui", "assets");

/** Вендоренные библиотеки — чужие исходники, проверке не подлежат. */
const VENDORED = new Set(["hljs.js", "smd.js"]);

/** Все .ts/.js файлы ассетов (кроме вендоренных). */
function frontendFiles(dir: string = ASSETS_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...frontendFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(ts|js)$/.test(entry.name)) continue;
    if (VENDORED.has(entry.name)) continue;
    out.push(full);
  }
  return out;
}

describe("webui frontend: guard против HTML-инъекций", () => {
  it("no inline-HTML sinks in the frontend", () => {
    const offenders: string[] = [];
    for (const file of frontendFiles()) {
      const text = readFileSync(file, "utf-8");
      if (
        /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|new Function\(|eval\(/.test(text)
      ) {
        offenders.push(relative(REPO_ROOT, file).replace(/\\/g, "/"));
      }
    }
    expect(offenders, `HTML-инъекционные стоки во фронтенде:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("markdown rendering still uses text nodes", () => {
    const dom = readFileSync(join(ASSETS_DIR, "js", "dom.ts"), "utf-8");
    expect(dom).toContain("createTextNode");
  });

  it("highlight uses an inert parser, not innerHTML", () => {
    const md = readFileSync(join(ASSETS_DIR, "md.ts"), "utf-8");
    expect(md).toContain("DOMParser");
    expect(md).not.toMatch(/\.innerHTML\s*=/);
  });

  it("url rendering keeps the scheme allowlist", () => {
    const md = readFileSync(join(ASSETS_DIR, "md.ts"), "utf-8");
    // Схемы, которые можно отдавать в разметке: http(s), mailto и data:image.
    expect(md).toMatch(/u\.protocol === "http:"/);
    expect(md).toMatch(/u\.protocol === "mailto:"/);
    expect(md).toMatch(/data:image/);
    // Опасная схема не проходит: проверка идёт по протоколу, а не по префиксу.
    expect(md).not.toMatch(/startsWith\("javascript:"\)/);
  });

  it("the guard sees the frontend files it is meant to guard", () => {
    const files = frontendFiles();
    expect(files.length).toBeGreaterThan(20);
    const names = files.map((f) => f.replace(/\\/g, "/"));
    expect(names.some((n) => n.endsWith("/assets/app.ts"))).toBe(true);
    expect(names.some((n) => n.endsWith("/assets/js/dom.ts"))).toBe(true);
    // Вендоренные исключены явно.
    expect(names.some((n) => n.endsWith("/assets/hljs.js"))).toBe(false);
  });

  it("frontend sources are not empty", () => {
    for (const file of frontendFiles().slice(0, 5)) {
      expect(statSync(file).size).toBeGreaterThan(0);
    }
  });
});
