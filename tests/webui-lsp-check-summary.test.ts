// Guard: после «Проверить» панель LSP сообщает результат и время.
//
// Регресс из стресс-теста (волна 20): кнопка переводила панель в «проверяется…»,
// затем панель возвращалась к тому же виду — ни «сколько серверов ok», ни метки
// времени. Один и тот же экран до и после проверки.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`<div id="msgs"></div>`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "ru";
// Минимальный словарь: тест проверяет формат итога, а не весь набор ключей.
i18n.I18N.dicts = {
  ru: {
    "web.sidebar.lsp_checked_at": "проверено {time} · серверов {ok}/{total} ok",
    "web.sidebar.lsp_checked_counts": "серверов {ok}/{total} ok",
  },
};

const { lspCheckSummary } = await import("../src/modules/webui/assets/js/sidebar/lsp-summary.js");

const diag = {
  enabled: true,
  offline: false,
  servers: [
    { language: "typescript", reason: "ok" },
    { language: "javascript", reason: "ok" },
    { language: "json", reason: "ok" },
    { language: "css", reason: "ok" },
    { language: "python", reason: "not-applicable" },
  ],
};

describe("LSP: итог проверки", () => {
  it("считает только применимые серверы", () => {
    const now = new Date(2026, 9, 28, 14, 3).getTime();
    const text = lspCheckSummary(diag, now);

    expect(text).toBeTruthy();
    // 4 применимых из 4 ok; python (not-applicable) в счёт не входит.
    expect(String(text)).toContain("4/4");
    expect(String(text)).toContain("14:03");
  });

  it("без метки времени показывает только счётчики", () => {
    const text = lspCheckSummary(diag, null);

    expect(String(text)).toContain("4/4");
    expect(String(text)).not.toContain(":");
  });

  it("без диагноза строки нет", () => {
    expect(lspCheckSummary(null, Date.now())).toBeNull();
    expect(lspCheckSummary({ enabled: true, servers: [] }, Date.now())).toBeNull();
  });

  it("панель печатает итог проверки", async () => {
    const state = await import("../src/modules/webui/assets/js/sidebar/state.js");
    const lsp = await import("../src/modules/webui/assets/js/sidebar/lsp.js");

    state.sb.lspEl = win.document.createElement("div");
    state.sb.lspDiag = diag as never;
    state.sb.lspCheckedAt = new Date(2026, 9, 28, 14, 3).getTime();
    state.sb.lspProbing = false;
    state.sb.lspUnavailable = false;

    lsp.renderLsp();

    expect(state.sb.lspEl.textContent).toContain("4/4");
    expect(state.sb.lspEl.textContent).toContain("14:03");
  });
});
