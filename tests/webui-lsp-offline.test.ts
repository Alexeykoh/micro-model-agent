/**
 * U13 (UX-аудит WebUI 2026-11-02): выключенный LSP был неотличим от
 * «ещё не проверяли» — вкладка молчала, а отключённая проверка в ходе
 * выглядела как поломка (красный error). Гейт держит три части:
 * флаги статуса, постоянный индикатор на вкладке + баннер, и спокойное
 * состояние маскота вместо error.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const HTML = readFileSync(
  new URL("../src/modules/webui/assets/index.html", import.meta.url),
  "utf-8",
);
const CSS = readFileSync(
  new URL("../src/modules/webui/assets/styles.css", import.meta.url),
  "utf-8",
);

const win = new Window({ url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.location = win.location;
g.localStorage = win.localStorage;

const { FACE_CLASS } = await import("../src/modules/webui/assets/js/loader-states.js");
const { lspStatusFlags } = await import("../src/modules/webui/assets/js/sidebar/lsp.js");

describe("LSP off/offline indication (U13)", () => {
  it("maps diagnosis to disabled/offline flags", () => {
    expect(lspStatusFlags(null)).toEqual({ disabled: false, offline: false });
    expect(lspStatusFlags({ enabled: false })).toEqual({ disabled: true, offline: false });
    expect(lspStatusFlags({ enabled: true, offline: true })).toEqual({
      disabled: false,
      offline: true,
    });
    expect(lspStatusFlags(null, true)).toEqual({ disabled: true, offline: false });
  });

  it("ships a steady dot for off/offline and a banner style", () => {
    expect(CSS).toMatch(/\[data-indicator="off"\][^}]*\.sb-dot[^}]*background:/);
    expect(CSS).toMatch(/\[data-indicator="offline"\][^}]*\.sb-dot/);
    expect(CSS).toContain(".lsp-banner");
    expect(CSS).toContain(".lsp-banner-btn");
    expect(HTML).toContain('data-tab="lsp"');
  });

  it("shows a disabled LSP as a calm face, not the error face", () => {
    expect(FACE_CLASS.lspoff).toContain("c-dim");
    expect(FACE_CLASS.lspoff).not.toBe(FACE_CLASS.error);
    expect(FACE_CLASS.lspoff).toContain("st-check");
  });
});
