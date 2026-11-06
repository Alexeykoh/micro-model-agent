import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Гейт проводки git-UI (правило 5: инвариант — это проверка).
 *
 * История дефекта: файлы `feed/git-chips.ts` и `sidebar/git.ts` существовали, а
 * вызова не было — `renderWorkspace` рисовал футер без чипов, три импорта в
 * `feed/sidebar.ts` висели мёртвыми, а контейнер `#wsGit` в разметке оставался
 * `hidden` навсегда. Ни юнит-тест билдера чипов, ни typecheck этого не видели:
 * мёртвый импорт — валидный TS, а `hidden` в HTML ничего не ломает.
 *
 * Проверяем то, что делает фичу работающей, а не то, что она скомпилировалась:
 * функция рендера вызывается из состояния, контейнер переключается, панель
 * вкладки лежит внутри `.sb` (иначе она отрисуется поверх страницы).
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FEED = join(REPO_ROOT, "src/modules/webui/assets/js/feed/sidebar.ts");
const BADGES = join(REPO_ROOT, "src/modules/webui/assets/js/feed/git-badges.ts");
const CHIPS = join(REPO_ROOT, "src/modules/webui/assets/js/feed/git-chips.ts");
const HTML = join(REPO_ROOT, "src/modules/webui/assets/index.html");

const read = (p: string): string => readFileSync(p, "utf-8");

describe("git chips wiring (INV-G3)", () => {
  it("renders the chips from the state snapshot, not only declaring them", () => {
    const feed = read(FEED);
    const badges = read(BADGES);
    // Объявленный, но не вызванный рендер — это и был дефект.
    expect(feed, "paintGitChips не вызывается из renderWorkspace").toMatch(
      /renderWorkspace[\s\S]*?paintGitChips\(h\)/,
    );
    expect(badges).toMatch(/export function paintGitChips/);
    // Снимок берётся из состояния (`h.git`), а не собирается на клиенте.
    expect(badges).toMatch(/h\.git/);
  });

  it("renders the badge inside the footer line, not in its own block", () => {
    const badges = read(BADGES);
    // Отдельный контейнер давал вторую строку — бейдж должен рисоваться
    // тем же `renderFooter`, что путь и версия.
    expect(badges, "git рисуется не в строке футера").toMatch(/renderFooter\(\s*wsLine,/);
    expect(badges).toMatch(/git:\s*snap/);
  });

  it("drives the tab indicator from the same snapshot", () => {
    const badges = read(BADGES);
    expect(badges).toMatch(/sidebarGitIndicator\(/);
  });

  it("keeps the chips builder free of DOM so it stays unit-testable", () => {
    const chips = read(CHIPS);
    expect(chips).toMatch(/export function buildGitChips/);
    expect(chips).not.toMatch(/^import .*from "\.\.\/dom/m);
  });
});

describe("git snapshot delivery (INV-G3)", () => {
  const MODULE = join(REPO_ROOT, "src/modules/webui/module.ts");

  it("peeks the cache in getState and pushes the state when the snapshot lands", () => {
    const src = read(MODULE);
    // Первый peek возвращает null (сборка только началась): без колбэка снимок
    // не доедет до клиента до следующего тика — бейдж не появится.
    expect(src, "gitPeek в getState без onUpdated").toMatch(
      /gitPeek\([\s\S]{0,120}?pushState\(state\)/,
    );
  });

  it("warms the snapshot at startup so the badge is there on first paint", () => {
    const src = read(MODULE);
    expect(src).toMatch(/createGitCache\(\)[\s\S]{0,400}?gitPeek\(/);
  });
});

describe("changes tab markup (INV-G3)", () => {
  /** Индексы открывающих/закрывающих тегов `.sb`, чтобы увидеть вложенность. */
  function sbBounds(html: string): { open: number; close: number } {
    const open = html.indexOf('<div class="sb">');
    expect(open, "контейнер .sb не найден").toBeGreaterThan(-1);
    // Закрывающий тег .sb ищем по маркеру после панелей: первая строка `</div>`
    // на нулевом отступе после начала блока.
    const rest = html.slice(open);
    const closeMatch = rest.match(/^ {0,2}<\/div>/m);
    const close = closeMatch && closeMatch.index !== undefined ? open + closeMatch.index : -1;
    expect(close, "не найден закрывающий тег .sb").toBeGreaterThan(open);
    return { open, close };
  }

  it("keeps pane-git inside the sidebar container", () => {
    const html = read(HTML);
    const { open, close } = sbBounds(html);
    const pane = html.indexOf('id="pane-git"');
    expect(pane, "панель pane-git отсутствует").toBeGreaterThan(-1);
    // Вне .sb панель не скрывается вместе с сайдбаром — она отрисуется поверх чата.
    expect(pane, "pane-git лежит вне .sb").toBeGreaterThan(open);
    expect(pane, "pane-git лежит вне .sb").toBeLessThan(close);
  });

  it("has a tab button wired to that pane", () => {
    const html = read(HTML);
    expect(html).toMatch(/data-tab="git"[^>]*aria-controls="pane-git"/);
    expect(html).toMatch(/id="gitBody"/);
  });
});
