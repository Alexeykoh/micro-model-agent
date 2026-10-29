// Guard: секция «файл» вкладки LSP показывает диагностику, пустоту и отказы,
// а клик по строке открывает файл на этой строке (W3 спеки).
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
    "web.sidebar.lsp_file_title": "файл",
    "web.sidebar.lsp_file_desc": "файл из вкладки «Файлы»",
    "web.sidebar.lsp_file_no_selection": "Выбери файл во вкладке «Файлы» — покажу его диагностику.",
    "web.sidebar.lsp_file_open_files": "Открыть «Файлы»",
    "web.sidebar.lsp_file_not_checked_yet": "нажми «проверить снова»",
    "web.sidebar.lsp_file_refresh": "проверить снова",
    "web.sidebar.lsp_file_clean": "ошибок нет",
    "web.sidebar.lsp_file_ms": "{secs} с",
    "web.sidebar.lsp_file_failed": "проверка не удалась",
    "web.sidebar.lsp_file_outside_workspace": "путь вне проекта — не проверяю",
    "web.sidebar.lsp_file_lsp_timeout": "сервер LSP не ответил за {secs} с - попробуй ещё раз",
    "web.sidebar.lsp_file_unsupported": "для этого типа файла нет LSP-сервера",
    "web.sidebar.lsp_file_more": "ещё {count} диагностик(и) не показано",
    "web.sidebar.lsp_file_open_line": "открыть {path} на строке {line}",
    "web.sidebar.lsp_sev_error": "ошибка",
    "web.sidebar.lsp_sev_warning": "предупреждение",
    "web.sidebar.lsp_sev_info": "информация",
  },
};

const mod = await import("../src/modules/webui/assets/js/sidebar/lsp-file.js");
const state = await import("../src/modules/webui/assets/js/sidebar/state.js");
const store = await import("../src/modules/webui/assets/js/store.js");

function box(): HTMLElement {
  const el = win.document.querySelector("#box") as HTMLElement;
  el.textContent = "";
  return el;
}

describe("LSP: секция проверки файла", () => {
  it("без выбранного файла — подсказка и переход в «Файлы», без поля ввода", () => {
    state.sb.files.selectedPath = null;
    const b = box();
    mod.renderLspFile(b);

    expect(b.querySelector("input")).toBeNull();
    expect(b.textContent).toContain("Файлы");
    expect(b.querySelector(".lsp-file-go")).toBeTruthy();
  });

  it("берёт путь из вкладки «Файлы» и даёт кнопку проверки", () => {
    state.sb.files.selectedPath = "src/a.ts";
    try {
      const b = box();
      mod.renderLspFile(b);

      expect(b.querySelector("input")).toBeNull();
      expect(b.querySelector(".lsp-file-name")?.textContent).toBe("src/a.ts");
      expect(b.querySelector(".lsp-file-refresh")).toBeTruthy();
    } finally {
      state.sb.files.selectedPath = null;
    }
  });

  it("отличает «нет сервера для формата» от «проверка не удалась»", () => {
    const b = box();
    mod.renderLspFileResult(b, { ok: false, path: "docs/readme.md", error: "unsupported", ms: 3 });

    expect(b.textContent).toContain("нет LSP-сервера");
    expect(b.textContent).not.toContain("проверка не удалась");
  });
  it("показывает строку, колонку и текст диагностики", () => {
    const b = box();
    mod.renderLspFileResult(b, {
      ok: true,
      path: "src/a.ts",
      ms: 640,
      diagnostics: [{ line: 5, column: 3, severity: "error", message: "Property 'has' missing" }],
    });

    expect(b.textContent).toContain("5:3");
    expect(b.textContent).toContain("Property 'has' missing");
    expect(b.querySelectorAll(".lsp-file-diag").length).toBe(1);
  });

  it("различает уровень: warning — «!», error — «✗»", () => {
    const b = box();
    mod.renderLspFileResult(b, {
      ok: true,
      path: "src/a.ts",
      diagnostics: [
        { line: 1, column: 1, severity: "error", message: "bad" },
        { line: 2, column: 1, severity: "warning", message: "meh" },
      ],
    });

    const sev = [...b.querySelectorAll(".lsp-diag-sev")].map((n) => n.textContent);
    expect(sev).toEqual(["✗", "!"]);
  });

  it("клик по диагностике открывает файл на этой строке", () => {
    const calls: Array<[string, number]> = [];
    store.hooks.openFileAtLine = (path, line) => calls.push([path, line]);
    try {
      const b = box();
      mod.renderLspFileResult(b, {
        ok: true,
        path: "src/components/Products.tsx",
        diagnostics: [{ line: 41, column: 7, severity: "error", message: "Property 'has'" }],
      });
      (b.querySelector(".lsp-file-diag") as HTMLButtonElement).click();
      expect(calls).toEqual([["src/components/Products.tsx", 41]]);
    } finally {
      store.hooks.openFileAtLine = null;
    }
  });

  it("пустой результат — «ошибок нет» и время проверки", () => {
    const b = box();
    mod.renderLspFileResult(b, { ok: true, path: "src/a.ts", diagnostics: [], ms: 640 });

    expect(b.textContent).toContain("ошибок нет");
    expect(b.textContent).toContain("0.6");
  });

  it("отказ вне workspace объясняется", () => {
    const b = box();
    mod.renderLspFileResult(b, { ok: false, path: "../x", diagnostics: [], error: "outside-workspace" });

    expect(b.textContent).toContain("путь вне проекта");
  });

  it("таймаут показывает, сколько ждали, и причину", () => {
    const b = box();
    mod.renderLspFileResult(b, {
      ok: false,
      path: "src/a.ts",
      diagnostics: [],
      error: "lsp-timeout",
      ms: 15000,
    });

    expect(b.textContent).toContain("не ответил за 15");
  });

  it("неизвестная причина падает в общий текст, а не в ключ", () => {
    const b = box();
    mod.renderLspFileResult(b, { ok: false, path: "src/a.ts", diagnostics: [], error: "boom" });

    expect(b.textContent).toContain("проверка не удалась");
    expect(b.textContent).not.toContain("web.sidebar.lsp_file_boom");
  });
});
