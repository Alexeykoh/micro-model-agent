// Guard: секция «файл» вкладки LSP показывает диагностику, пустоту и отказы.
//
// B-41: панель раньше умела только «серверы живы»; теперь у неё есть проверка
// конкретного файла, и результат обязан быть виден (включая пустой и отказы).
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="box"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "ru";
i18n.I18N.dicts = {
  ru: {
    "web.sidebar.lsp_file_clean": "ошибок нет: {path}",
    "web.sidebar.lsp_file_failed": "проверка не удалась",
    "web.sidebar.lsp_file_outside_workspace": "путь вне проекта — не проверяю",
    "web.sidebar.lsp_file_more": "ещё {count} диагностик(и) не показано",
  },
};

const mod = await import("../src/modules/webui/assets/js/sidebar/lsp-file.js");

function box(): HTMLElement {
  const el = win.document.querySelector("#box") as HTMLElement;
  el.textContent = "";
  return el;
}

describe("LSP: секция проверки файла", () => {
  it("показывает строку, колонку и текст диагностики", () => {
    const b = box();
    mod.renderLspFileResult(b, {
      ok: true,
      path: "src/a.ts",
      diagnostics: [{ line: 5, column: 3, severity: "error", message: "Property 'has' missing" }],
    });

    expect(b.textContent).toContain("5:3");
    expect(b.textContent).toContain("Property 'has' missing");
    expect(b.querySelectorAll(".lsp-file-diag").length).toBe(1);
  });

  it("пустой результат — «ошибок нет» с путём", () => {
    const b = box();
    mod.renderLspFileResult(b, { ok: true, path: "src/a.ts", diagnostics: [] });

    expect(b.textContent).toContain("src/a.ts");
    expect(b.textContent).toContain("ошибок нет");
  });

  it("отказ вне workspace объясняется", () => {
    const b = box();
    mod.renderLspFileResult(b, { ok: false, path: "../x", diagnostics: [], error: "outside-workspace" });

    expect(b.textContent).toContain("путь вне проекта");
  });

  it("неизвестная причина падает в общий текст, а не в ключ", () => {
    const b = box();
    mod.renderLspFileResult(b, { ok: false, path: "src/a.ts", diagnostics: [], error: "boom" });

    expect(b.textContent).toContain("проверка не удалась");
    expect(b.textContent).not.toContain("web.sidebar.lsp_file_boom");
  });
});
