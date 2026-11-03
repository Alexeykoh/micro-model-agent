/**
 * U18 (UX-аудит WebUI 2026-11-02): пустой экран повторял подсказку поля ввода
 * («введи сообщение ниже · / — команды · …»). Подсказка должна жить только в
 * композере, а экран — не дублировать её.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const CORE = readFileSync(
  new URL("../src/modules/webui/assets/js/feed/core.ts", import.meta.url),
  "utf-8",
);

describe("empty feed state (U18)", () => {
  it("does not repeat the composer hint", () => {
    expect(CORE).toContain('t("web.empty.title")');
    expect(CORE).not.toContain("web.empty.hint");
  });
});
