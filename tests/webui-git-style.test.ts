import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Гейт оформления git-бейджей (спека git-workflow §6.3/§7).
 *
 * История дефекта: чипы были объявлены только цветом текста
 * (`color: var(--dim-a)`), без фона, рамки и отступов — в интерфейсе это
 * читалось как «всё серым текстом», а не как бейджи состояния. Ни один тест
 * этого не видел: селектор на месте, рендер на месте, а вид — нет.
 *
 * Проверяем вид как контракт: у `.gchip` есть коробка (фон/рамка/радиус/отступ),
 * а состояния отличаются не только цветом символа.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CSS = readFileSync(join(REPO_ROOT, "src/modules/webui/assets/styles.css"), "utf-8");

/** Тело правила по селектору (первое совпадение; null — правила нет). */
function ruleBody(selector: string): string | null {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = re.exec(CSS);
  return m ? m[1] : null;
}

describe("git chip styling (INV-G4)", () => {
  it("gives every chip a visible box, not just a text colour", () => {
    const body = ruleBody(".gchip");
    expect(body, "правило .gchip не найдено").not.toBeNull();
    // Без коробки «бейдж» неотличим от обычного серого текста — это и был дефект.
    expect(body, ".gchip без фона").toMatch(/background\s*:/);
    expect(body, ".gchip без рамки").toMatch(/border\s*:/);
    expect(body, ".gchip без скругления").toMatch(/border-radius\s*:/);
    expect(body, ".gchip без горизонтальных отступов").toMatch(/padding\s*:/);
  });

  it("separates states by more than the glyph colour", () => {
    // Ветка — акцентная плашка, dirty/sync/tag — своя рамка: иначе всё сливается.
    expect(ruleBody(".gchip-branch")).toMatch(/background\s*:/);
    expect(ruleBody(".gchip-dirty")).toMatch(/border-color\s*:/);
    expect(ruleBody(".gchip-sync")).toMatch(/border-color\s*:/);
  });

  it("uses the interface pill language (radius + small font + tabular numbers)", () => {
    const body = ruleBody(".gchip") ?? "";
    expect(body).toMatch(/border-radius:\s*999px/);
    expect(body).toMatch(/font-size:\s*11px/);
    expect(body).toMatch(/tabular-nums/);
  });

  it("keeps a focus ring for the clickable chip", () => {
    expect(CSS).toMatch(/\.gchip-link:focus-visible\s*\{[^}]*outline/);
  });
});
