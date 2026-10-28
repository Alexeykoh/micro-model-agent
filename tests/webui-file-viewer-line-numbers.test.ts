// Guard: просмотр файла показывает номера строк.
//
// Регресс из стресс-теста (волна 20): агент в отчётах ссылается на «строка 184»,
// а во вьюере номеров не было вообще, зато длинные строки рвались по словам
// (`white-space: pre-wrap`). Номера — отдельный жёлоб с тем же шрифтом; код
// идёт `pre`, чтобы номер не уезжал от своей строки.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="body"></div>`);

const view = await import("../src/modules/webui/assets/js/sidebar/files/view.js");

describe("просмотр файла: номера строк", () => {
  it("жёлоб нумерует строки, код не меняется", () => {
    const body = win.document.querySelector("#body") as HTMLElement;
    view.paintFile(body, "a.ts", { ok: true, mime: "text/plain", text: "a\nb\nc" });

    const gutter = body.querySelector(".fv-gutter") as HTMLElement | null;
    const code = body.querySelector(".fcode") as HTMLElement | null;

    expect(gutter).toBeTruthy();
    expect(gutter?.textContent).toBe("1\n2\n3");
    expect(code?.textContent).toBe("a\nb\nc");
  });

  it("жёлоб служебный: aria-hidden и без копирования", () => {
    const body = win.document.querySelector("#body") as HTMLElement;
    view.paintFile(body, "b.ts", { ok: true, mime: "text/plain", text: "x" });

    const gutter = body.querySelector(".fv-gutter") as HTMLElement | null;

    expect(gutter?.getAttribute("aria-hidden")).toBe("true");
  });

  it("markdown рендерится как раньше, без жёлоба", () => {
    const body = win.document.querySelector("#body") as HTMLElement;
    view.paintFile(body, "readme.md", { ok: true, mime: "text/plain", text: "# Заголовок" });

    expect(body.querySelector(".fmd")).toBeTruthy();
    expect(body.querySelector(".fv-gutter")).toBeNull();
  });

  it("стили: жёлоб не копируется и выровнен с кодом", () => {
    const css = readFileSync("src/modules/webui/assets/styles.css", "utf8");
    const gutter = css.slice(css.indexOf(".fv-gutter"), css.indexOf(".fpre {"));
    const code = css.slice(css.indexOf(".fpre .fcode"), css.indexOf(".fmd {"));

    expect(gutter).toContain("user-select: none");
    expect(gutter).toContain("font-size: 11.5px");
    expect(code).toContain("white-space: pre;");
    expect(code).toContain("font-size: 11.5px");
  });
});
