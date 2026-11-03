/**
 * U16 (UX-аудит WebUI 2026-11-02): не было глобальных горячих клавиш и подсказки
 * о них. Гейт держит разбор сочетаний (Ctrl/Cmd+K — сессии, Ctrl/Cmd+P — файлы,
 * Alt+цифры не перехватываются), подсказку и её скрытие на тач.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { setupHappyDom } from "./helpers/happy-dom";

const HTML = readFileSync(
  new URL("../src/modules/webui/assets/index.html", import.meta.url),
  "utf-8",
);
const CSS = readFileSync(
  new URL("../src/modules/webui/assets/styles.css", import.meta.url),
  "utf-8",
);
const APP = readFileSync(
  new URL("../src/modules/webui/assets/app.ts", import.meta.url),
  "utf-8",
);

setupHappyDom("<div></div>");

const { shortcutFor } = await import("../src/modules/webui/assets/js/shortcuts.js");


describe("global shortcuts (U16)", () => {
  it("maps Ctrl/Cmd+K and Ctrl/Cmd+P, and nothing else", () => {
    expect(shortcutFor({ key: "k", ctrlKey: true })).toBe("sessions");
    expect(shortcutFor({ key: "K", metaKey: true })).toBe("sessions");
    expect(shortcutFor({ key: "p", ctrlKey: true })).toBe("files");
    expect(shortcutFor({ key: "p", ctrlKey: true, shiftKey: true })).toBeNull();
    expect(shortcutFor({ key: "k", altKey: true })).toBeNull();
    expect(shortcutFor({ key: "k" })).toBeNull();
    // Alt+1..9 stays the tab switcher; `/` stays the composer palette.
    expect(shortcutFor({ key: "1", altKey: true })).toBeNull();
    expect(shortcutFor({ key: "/" })).toBeNull();
  });

  it("is wired at boot and shows a desktop-only hint", () => {
    expect(APP).toContain("initShortcuts()");
    expect(HTML).toContain('id="hintShort"');
    expect(CSS).toMatch(/@media \(pointer: coarse\), \(max-width: 760px\)[\s\S]*#hintShort\s*\{\s*display:\s*none/);
  });
});
