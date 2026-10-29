// Guard: секция «изменённые» группирует диагностики по файлам и открывает
// строку во вкладке Files; пустой результат — «чисто», а не пустое место.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="box"></div>`);
const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "ru";
i18n.I18N.dicts = {
  ru: {
    "web.sidebar.lsp_file_open_line": "открыть {path} на строке {line}",
    "web.sidebar.lsp_changed_clean": "чисто: {count} файл(ов)",
    "web.sidebar.lsp_changed_failed": "проверка не удалась",
    "web.sidebar.lsp_changed_truncated": "бюджет проверки исчерпан — показана часть",
    "web.sidebar.lsp_changed_open": "открыть {path}",
    "web.sidebar.lsp_changed_git_unavailable": "нужен git-репозиторий",
  },
};
const mod = await import("../src/modules/webui/assets/js/sidebar/lsp-changed.js");
const store = await import("../src/modules/webui/assets/js/store.js");

function box(): HTMLElement {
  const el = win.document.querySelector("#box") as HTMLElement;
  el.textContent = "";
  return el;
}

describe("LSP: изменённые файлы", () => {
  it("группирует по файлам и открывает строку по клику", () => {
    const calls: Array<[string, number]> = [];
    store.hooks.openFileAtLine = (p, l) => calls.push([p, l]);
    try {
      const b = box();
      mod.renderChangedResult(b, {
        ok: true,
        files: [
          {
            ok: true,
            path: "src/a.ts",
            diagnostics: [{ line: 5, column: 2, severity: "error", message: "boom" }],
          },
          { ok: true, path: "src/b.ts", diagnostics: [] },
        ],
      });

      expect(b.querySelectorAll(".lsp-changed-file").length).toBe(1);
      expect(b.textContent).toContain("src/a.ts");
      expect(b.textContent).toContain("boom");

      (b.querySelector(".lsp-file-diag") as HTMLButtonElement).click();
      expect(calls).toEqual([["src/a.ts", 5]]);
    } finally {
      store.hooks.openFileAtLine = null;
    }
  });

  it("причина отказа объясняется, а не проглатывается", () => {
    const b = box();
    mod.renderChangedResult(b, { ok: false, error: "git-unavailable", files: [] });
    expect(b.textContent).toContain("git-репозиторий");
  });
});
