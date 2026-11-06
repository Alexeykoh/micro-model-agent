import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Гейт оформления git-бейджа (спека git-workflow §6.3/§7).
 *
 * Две истории дефекта, обе невидимые для тестов логики:
 *  1) чипы были объявлены только цветом (`color`), без фона/рамки/отступов —
 *     в интерфейсе это «всё серым текстом», а не бейджи;
 *  2) бейдж жил отдельным блоком и рисовался ВТОРОЙ строкой под `dir … mma …` —
 *     просили одну строку, а не столбик.
 *
 * Проверяем вид как контракт: коробка есть, состояния различимы, и чип стоит
 * именно в строке футера (`.ws-line .gchip`), а не в отдельном контейнере.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CSS = readFileSync(join(REPO_ROOT, "src/modules/webui/assets/styles.css"), "utf-8");
const HTML = readFileSync(join(REPO_ROOT, "src/modules/webui/assets/index.html"), "utf-8");
const BADGES = readFileSync(
  join(REPO_ROOT, "src/modules/webui/assets/js/feed/git-badges.ts"),
  "utf-8",
);

/** Тело правила по селектору (первое совпадение; null — правила нет). */
function ruleBody(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  return m ? m[1] : null;
}

describe("git badge styling (INV-G4)", () => {
  it("gives the badge a visible box, not just a text colour", () => {
    const body = ruleBody(".ws-line .gchip");
    expect(body, "правило .ws-line .gchip не найдено").not.toBeNull();
    expect(body, "бейдж без фона").toMatch(/background\s*:/);
    expect(body, "бейдж без рамки").toMatch(/border\s*:/);
    expect(body, "бейдж без скругления").toMatch(/border-radius\s*:/);
    expect(body, "бейдж без горизонтальных отступов").toMatch(/padding\s*:/);
  });

  it("separates states by more than the glyph colour", () => {
    expect(ruleBody(".ws-line .gchip-branch")).toMatch(/background\s*:/);
    expect(ruleBody(".ws-line .gchip-dirty")).toMatch(/border-color\s*:/);
  });

  it("uses the interface pill language (radius + small font + tabular numbers)", () => {
    const body = ruleBody(".ws-line .gchip") ?? "";
    expect(body).toMatch(/border-radius:\s*999px/);
    expect(body).toMatch(/font-size:\s*11px/);
    expect(body).toMatch(/tabular-nums/);
  });

  it("keeps a focus ring for the clickable chip", () => {
    expect(CSS).toMatch(/\.ws-line \.gchip-link:focus-visible\s*\{[^}]*outline/);
  });
});

describe("git badge placement (INV-G4)", () => {
  it("lives in the footer line instead of its own block below it", () => {
    // Отдельный контейнер давал вторую строку под футером — то, что просили убрать.
    expect(HTML, "контейнер #wsGit вернулся отдельным блоком").not.toContain('id="wsGit"');
    expect(CSS, "правило .ws-git вернулось").not.toMatch(/(?:^|\n)\.ws-git\s*\{/);
  });

  it("renders git inside the same .ws-line element as the directory", () => {
    // Строка одна: рендер идёт в `wsLine`, а git приходит полем входа.
    expect(BADGES).toMatch(/renderFooter\(\s*wsLine,/);
    expect(BADGES).toMatch(/git:\s*snap/);
    expect(BADGES).toMatch(/gitLabels:/);
  });
});
