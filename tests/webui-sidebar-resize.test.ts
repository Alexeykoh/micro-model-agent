/**
 * U7 (UX-аудит WebUI 2026-11-02): иконочные вкладки сайдбара были нечитаемы,
 * а ширина колонки зафиксирована. Гейт держит обе части: подпись в каждой
 * вкладке и рабочий resize колонки (clamp, persist, reset, CSS-переменная).
 */
import { describe, it, expect, beforeEach } from "vitest";
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
const CORE = readFileSync(
  new URL("../src/modules/webui/assets/js/sidebar/core.ts", import.meta.url),
  "utf-8",
);

describe("sidebar resize + labels (U7)", () => {
  it("sizes the column from --sb-w with the old clamp as fallback", () => {
    expect(CSS).toMatch(/\.sb\s*\{[^}]*width:\s*var\(--sb-w,\s*clamp\(340px,\s*38vw,\s*679px\)\)/);
  });

  it("ships a labelled separator and hides it in the drawer", () => {
    expect(HTML).toContain('id="sbResizer"');
    expect(HTML).toMatch(/id="sbResizer"[^>]*role="separator"[^>]*aria-orientation="vertical"/);
    expect(CSS).toMatch(/@media \(max-width: 1024px\)[\s\S]*\.sb-resizer\s*\{\s*display:\s*none/);
  });

  it("renders a text label inside each tab", () => {
    expect(CORE).toContain('className = "sb-lab"');
    expect(CORE).toContain("web.sidebar.tab_");
  });
});

describe("sidebar resize behaviour (U7)", () => {
  let resize: typeof import("../src/modules/webui/assets/js/sidebar/resize.js");
  let win: Window;
  let sb: HTMLElement;
  let sep: HTMLElement;

  beforeEach(async () => {
    win = new Window({ url: "http://localhost/" });
    const g = globalThis as Record<string, unknown>;
    g.window = win;
    g.document = win.document;
    g.localStorage = win.localStorage;
    g.location = win.location;
    win.document.body.innerHTML =
      '<div class="sb" id="sb"><div class="sb-resizer" id="sbResizer"></div></div>';
    sb = win.document.getElementById("sb") as HTMLElement;
    sep = win.document.getElementById("sbResizer") as HTMLElement;
    // Fresh module per test: `wired` is module-level.
    resize = await import(`../src/modules/webui/assets/js/sidebar/resize.js?t=${Math.random()}`);
  });

  it("clamps a dragged width into [min, viewport max]", () => {
    expect(resize.clampSidebarWidth(100, 1600)).toBe(resize.SIDEBAR_MIN);
    expect(resize.clampSidebarWidth(400, 1600)).toBe(400);
    expect(resize.clampSidebarWidth(2000, 1600)).toBe(resize.SIDEBAR_MAX);
    // A 900px viewport cannot give 760px to the sidebar.
    expect(resize.clampSidebarWidth(2000, 900)).toBe(900 - resize.CHAT_MIN);
  });

  it("persists a dragged width and applies it as --sb-w", () => {
    resize.initSidebarResize(sb, sep);
    expect(resize.setSidebarWidth(520)).toBe(520);
    expect(sb.style.getPropertyValue("--sb-w")).toBe("520px");
    expect(localStorage.getItem(resize.SIDEBAR_WIDTH_KEY)).toBe("520");
    expect(sep.getAttribute("aria-valuenow")).toBe("520");
  });

  it("resets to the responsive default and clears the stored value", () => {
    resize.initSidebarResize(sb, sep);
    resize.setSidebarWidth(520);
    resize.resetSidebarWidth();
    expect(sb.style.getPropertyValue("--sb-w")).toBe("");
    expect(localStorage.getItem(resize.SIDEBAR_WIDTH_KEY)).toBeNull();
  });

  it("resizes from the keyboard (ArrowLeft widens, Home resets)", () => {
    resize.initSidebarResize(sb, sep);
    resize.setSidebarWidth(400);
    const press = (key: string): void => {
      sep.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }) as unknown as Event,
      );
    };
    press("ArrowLeft");
    expect(resize.sidebarWidth()).toBe(412);
    press("ArrowRight");
    press("ArrowRight");
    expect(resize.sidebarWidth()).toBe(388);
    press("Home");
    expect(resize.sidebarWidth()).toBe(0);
  });
});
