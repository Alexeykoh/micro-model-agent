// AQC-8: сообщение о блокировке обязано содержать доступную моделью альтернативу.
import { describe, it, expect } from "vitest";
import { t } from "../../src/i18n/index";
import { blockAlternativeHint } from "../../src/modules/security/block-alternatives";

describe("AQC-8: actionable-подсказки при блокировке", () => {
  it("shell wrapper → dedicated file tools", () => {
    const hint = blockAlternativeHint('Shell wrapper "powershell" is blocked');
    expect(hint.toLowerCase()).toMatch(/grep|read_file|glob/);
  });

  it("URL-блок объясняет, как включить loopback", () => {
    const msg = t("tool.url_blocked", {
      url: "http://127.0.0.1:3000",
      reason: ' — Private address "127.0.0.1" is blocked (SSRF)',
    });
    expect(msg).toMatch(/allowLoopback|web_fetch/);
  });
});
