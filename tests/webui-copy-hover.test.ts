/**
 * U17 (UX-аудит WebUI 2026-11-02): две текстовые ссылки копирования под каждым
 * ответом делали ленту шумной (10 строк на 5 сообщений). Гейт держит
 * hover/focus-видимость и тач-исключение (на тач hover нет).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const CSS = readFileSync(
  new URL("../src/modules/webui/assets/styles.css", import.meta.url),
  "utf-8",
);

describe("copy actions are quiet until needed (U17)", () => {
  it("hides the row and reveals it on hover/focus", () => {
    expect(CSS).toMatch(/\.msg-actions\s*\{[^}]*opacity:\s*0/);
    expect(CSS).toMatch(/\.feed:hover \.msg-actions[^{]*\{[^}]*opacity:\s*1/);
    expect(CSS).toMatch(/\.msg-actions:focus-within[^{]*\{[^}]*opacity:\s*1/);
  });

  it("keeps the actions visible on touch", () => {
    expect(CSS).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.msg-actions\s*\{\s*opacity:\s*1/);
  });
});
