/**
 * U14 (UX-аудит WebUI 2026-11-02): длинный список сессий без виртуализации и
 * закрепления, а предупреждение сервера о 2400+ сессиях не доходило до UI.
 * Гейт держит pin-секцию, подсказку prune и `content-visibility` для строк.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { setupHappyDom } from "./helpers/happy-dom";

const CSS = readFileSync(
  new URL("../src/modules/webui/assets/styles.css", import.meta.url),
  "utf-8",
);

const win = setupHappyDom(`
  <input id="sessSearch" />
  <div class="h" id="sessActiveHeader"></div><div id="sessActiveList"></div>
  <div class="h" id="sessPinnedHeader"></div><div id="sessPinnedList"></div>
  <div class="h" id="sessRecentHeader"></div><div id="sessRecentList"></div>
  <div id="sessPrune" hidden></div>
`);

const { session } = await import("../src/modules/webui/assets/js/store.js");
const menu = await import("../src/modules/webui/assets/js/session/sessions-menu.js");

const rows = (id: string): HTMLElement[] =>
  [...(win.document.getElementById(id)?.querySelectorAll<HTMLElement>(".si-row") || [])];

/** Exact session ids in a section (`s5` is a substring of `s50`). */
const ids = (id: string): string[] =>
  [...(win.document.getElementById(id)?.querySelectorAll<HTMLElement>(".si-row .id") || [])].map(
    (n) => n.textContent || "",
  );

describe("sessions list scale (U14)", () => {
  beforeEach(() => {
    win.localStorage.clear();
    session.activeSessionId = "s1";
    session.sessions = Array.from({ length: 65 }, (_, i) => ({
      id: "s" + (i + 1),
      name: "session " + (i + 1),
      updatedAt: new Date(Date.now() - i * 60_000).toISOString(),
    }));
    menu.renderSessionsDropdown();
  });

  it("keeps a pinned session in its own section", () => {
    expect(menu.toggleSessionPin("s5")).toBe(true);
    expect(ids("sessPinnedList")).toContain("s5");
    expect(win.document.getElementById("sessPinnedHeader")?.hidden).toBe(false);
    expect(ids("sessRecentList")).not.toContain("s5");
    expect(menu.isSessionPinned("s5")).toBe(true);

    menu.toggleSessionPin("s5");
    expect(win.document.getElementById("sessPinnedHeader")?.hidden).toBe(true);
    expect(rows("sessPinnedList").length).toBe(0);
  });

  it("shows the prune hint for a long list", () => {
    const prune = win.document.getElementById("sessPrune") as HTMLElement;
    expect(prune.hidden).toBe(false);
    expect(prune.textContent).toContain("mma session prune --dry-run");
  });

  it("virtualizes off-screen rows and styles the pin control", () => {
    expect(CSS).toMatch(/\.dd-menu \.si-row\s*\{[^}]*content-visibility:\s*auto/);
    expect(CSS).toContain(".dd-menu .pin-btn.on");
    expect(CSS).toContain(".sess-prune code");
  });

  // Follow-up from the live UI: "ЗАКРЕПЛЁННЫЕ" looked like just another row.
  it("separates section headers from session rows", () => {
    expect(CSS).toMatch(/\.dd-menu \.h\s*\{[^}]*font-weight:\s*600/);
    expect(CSS).toMatch(/\.dd-menu \.h\s*\{[^}]*letter-spacing:\s*\.09em/);
    expect(CSS).toMatch(/\.dd-menu \.h ~ \.h\s*\{[^}]*border-top:\s*1px solid/);
  });
});
