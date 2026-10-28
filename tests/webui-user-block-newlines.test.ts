// Guard: многострочное сообщение пользователя не схлопывается в одну строку.
//
// Регресс из стресс-теста (волна 13): длинный markdown-промпт с таблицей и
// блоком кода показывался в ленте одной строкой — `.u-text` не имел
// `white-space: pre-wrap` (у ответа агента `.ans` он есть).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="msgs"></div>`);
const core = await import("../src/modules/webui/assets/js/feed/core.js");

describe("сообщение пользователя: переносы строк", () => {
  it("текст сохраняет переводы строк в DOM", () => {
    const block = core.userBlock("первая\nвторая\nтретья");
    const body = block.querySelector(".u-text");

    expect(body?.textContent).toBe("первая\nвторая\nтретья");
  });

  it("CSS не схлопывает переносы (pre-wrap), как у ответа агента", () => {
    const css = readFileSync("src/modules/webui/assets/styles.css", "utf8");
    const start = css.indexOf(".u-text {");
    const rule = css.slice(start, css.indexOf("}", start));

    expect(start).toBeGreaterThan(-1);
    expect(rule).toContain("white-space: pre-wrap");
  });
});
