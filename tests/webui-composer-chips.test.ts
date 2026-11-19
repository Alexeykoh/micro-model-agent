/**
 * U19 (UX-аудит WebUI 2026-11-02): на телефоне четыре чипа композера
 * (провайдер / модель / контекст / рассуждения) ложились в 2–4 ряда и съедали
 * экран. Один ряд: подписи скрыты, значения остаются, полное «label: value» —
 * в title/aria-label, модель забирает остаток ширины и усекается.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const CSS = readFileSync(
  new URL("../src/modules/webui/assets/styles.css", import.meta.url),
  "utf-8",
);
const WRITE = readFileSync(
  new URL("../src/modules/webui/assets/js/settings/selectors-write.ts", import.meta.url),
  "utf-8",
);

describe("composer chips on a phone (U19)", () => {
  it("keeps the selector row on one line", () => {
    expect(CSS).toMatch(/@media \(max-width: 640px\)[\s\S]*\.selectors\s*\{[^}]*flex-wrap:\s*nowrap/);
    expect(CSS).toMatch(/\.sel\[data-sel="model"\]\s*\{\s*flex:\s*1 1 0/);
    expect(CSS).toMatch(/\.sel > button\s*\{\s*font-size:\s*0/);
  });

  it("moves the hidden label into title and aria-label", () => {
    expect(WRITE).toContain('btn.title = label + ": " + value');
    expect(WRITE).toContain('btn.setAttribute("aria-label", btn.title)');
  });
});
