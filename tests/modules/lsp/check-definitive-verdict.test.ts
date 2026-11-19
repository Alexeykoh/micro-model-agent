// Guard: lsp_check даёт дефинитивный вердикт с заменой, а не совет
// «повтори через несколько секунд» (сессия ses_mwmeoln9: 3 таймаута LSP).
import { describe, it, expect } from "vitest";
import { setLocale, t } from "../../../src/i18n/index";
import { renderCheckReport, type CheckAccumulator } from "../../../src/modules/lsp/check-report";

setLocale("en");

function acc(cold: number): CheckAccumulator {
  return {
    baseDir: "/workspace",
    errors: [],
    warnings: [],
    notes: [],
    checkedFiles: [],
    checked: 0,
    inconclusive: 0,
    suppressed: 0,
    cold,
    unsupported: [],
  };
}

describe("lsp_check: дефинитивный verdict", () => {
  it("холодный старт называет конкретную замену", () => {
    const out = renderCheckReport(acc(2)).output;
    expect(out).toContain("tsc --noEmit");
    expect(out.toLowerCase()).not.toContain("retry in a few seconds");
  });

  it("пауза после падений тоже называет замену", () => {
    const out = t("lsp.check_paused", { sec: "60" });
    expect(out).toContain("tsc --noEmit");
    expect(out.toLowerCase()).not.toContain("next attempt in");
  });

  it("молчание сервера не предлагает просто повторить", () => {
    const out = t("lsp.check_silent", { silent: "1", total: "3" });
    expect(out).toContain("tsc --noEmit");
    expect(out.toLowerCase()).not.toContain("re-run");
  });
});
