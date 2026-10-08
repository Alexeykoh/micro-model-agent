// DOM coverage for the narrow-viewport sidebar drawer (`js/sidebar/drawer.js`):
// the modal contract a CSS class toggle cannot give on its own — backdrop,
// Escape, click-outside, measured bar inset, and staying in sync with the
// viewport breakpoint. `bun test` doesn't apply vitest's environment docblock,
// so happy-dom is wired manually and `matchMedia` is a controllable stub
// (happy-dom reports `matches: false` and never fires `change`).
import { describe, it, expect, beforeEach } from "vitest";
import { Window } from "happy-dom";

const HTML = `
  <div class="bar-top">
    <button class="icon-btn" id="toggleSidebar" type="button" aria-expanded="false">▤</button>
    <button class="icon-btn" id="openSettings" type="button">⚙</button>
  </div>
  <div class="bar-sub" id="sessBar"><span>session</span></div>
  <div class="layout">
    <div class="chat"><div id="inp"></div></div>
    <div class="sb">
      <div class="sb-tabs" role="tablist">
        <button class="sb-tab on" type="button" role="tab" data-tab="session"><span class="sb-ico"></span></button>
        <button class="sb-tab" type="button" role="tab" data-tab="map"><span class="sb-ico"></span></button>
      </div>
      <div class="sb-pane" id="pane-session" role="tabpanel"></div>
      <div class="sb-pane" id="pane-map" role="tabpanel" hidden></div>
      <div class="sb-pane" id="pane-trace" role="tabpanel" hidden></div>
    </div>
  </div>
  <div class="sb-backdrop" id="sbBackdrop"></div>
  <div class="overlay" id="overlay"></div>`;

const win = new Window({ url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.location = win.location;
g.localStorage = win.localStorage;
g.HTMLElement = win.HTMLElement;
win.document.body.innerHTML = HTML;

/** Viewport stub: tests flip the two breakpoints and fire their listeners.
    happy-dom reports `matches: false` for everything and never fires `change`. */
const mqs: Array<{ query: string; mql: MediaQueryList }> = [];
let narrow = true;
let phone = false;
function matches(query: string): boolean {
  return query.includes("1024") ? narrow : phone;
}
function makeMql(query: string): MediaQueryList {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    media: query,
    get matches() {
      return matches(query);
    },
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
  (mql as unknown as { fire: () => void }).fire = () =>
    listeners.forEach((fn) => fn({ matches: matches(query) } as MediaQueryListEvent));
  return mql;
}
(win as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (q: string) => {
  const mql = makeMql(q);
  mqs.push({ query: q, mql });
  return mql;
};

const fire = (query: string): void =>
  mqs.filter((m) => m.query === query).forEach((m) =>
    (m.mql as unknown as { fire: () => void }).fire(),
  );

const doc = (id: string) => win.document.getElementById(id) as HTMLElement;
const panel = () => win.document.querySelector(".sb") as HTMLElement;
const btn = () => doc("toggleSidebar");

// happy-dom has no layout: heights are zero, so the measured inset would always
// be "0px" and the test could not tell measurement from a hardcoded constant.
const height = (el: HTMLElement, px: number): void => {
  Object.defineProperty(el, "offsetHeight", { value: px, configurable: true });
};

const drawer = await import("../src/modules/webui/assets/js/sidebar/drawer.js");
drawer.initSidebarDrawer();

function press(key: string): void {
  doc("toggleSidebar").ownerDocument.dispatchEvent(
    new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

beforeEach(() => {
  narrow = true;
  phone = false;
  win.document.body.classList.remove("sb-open");
  panel().removeAttribute("role");
  panel().removeAttribute("aria-modal");
  panel().style.removeProperty("--sb-inset");
  btn().setAttribute("aria-expanded", "false");
  height(doc("toggleSidebar").closest(".bar-top") as HTMLElement, 41);
  height(doc("sessBar"), 0);
  drawer.setSidebarDrawer(false);
});

describe("sidebar drawer (narrow viewports)", () => {
  it("toggles the drawer from the topbar button", () => {
    btn().click();
    expect(win.document.body.classList.contains("sb-open")).toBe(true);
    expect(btn().getAttribute("aria-expanded")).toBe("true");
    expect(drawer.sidebarDrawerOpen()).toBe(true);

    btn().click();
    expect(win.document.body.classList.contains("sb-open")).toBe(false);
    expect(btn().getAttribute("aria-expanded")).toBe("false");
    expect(drawer.sidebarDrawerOpen()).toBe(false);
  });

  // The old drawer hardcoded `top: 41px`, which ignored the phone sub-bar that
  // appears below the same breakpoint and tucked the drawer under it.
  it("insets the drawer by the measured bar heights", () => {
    btn().click();
    expect(panel().style.getPropertyValue("--sb-inset")).toBe("41px");

    height(doc("sessBar"), 38);
    drawer.initSidebarDrawer();
    expect(panel().style.getPropertyValue("--sb-inset")).toBe("79px");

    win.dispatchEvent(new win.Event("resize"));
    height(doc("sessBar"), 0);
    win.dispatchEvent(new win.Event("resize"));
    expect(panel().style.getPropertyValue("--sb-inset")).toBe("41px");

    drawer.setSidebarDrawer(false);
    expect(panel().style.getPropertyValue("--sb-inset")).toBe("");
  });

  it("is a dialog only while open, and returns focus to the toggle", () => {
    expect(panel().getAttribute("role")).toBe(null);
    btn().focus();
    btn().click();
    expect(panel().getAttribute("role")).toBe("dialog");
    expect(panel().getAttribute("aria-modal")).toBe("true");
    // Focus moves into the drawer (the active tab), so Tab cycles inside it.
    expect(win.document.activeElement?.className).toContain("sb-tab");

    drawer.setSidebarDrawer(false);
    expect(panel().getAttribute("role")).toBe(null);
    expect(panel().getAttribute("aria-modal")).toBe(null);
    expect(win.document.activeElement?.id).toBe("toggleSidebar");
  });

  it("closes on Escape and on a click outside", () => {
    btn().click();
    press("Escape");
    expect(drawer.sidebarDrawerOpen()).toBe(false);

    btn().click();
    doc("sbBackdrop").click();
    expect(drawer.sidebarDrawerOpen()).toBe(false);
  });

  // An open overlay (settings, confirm) is modal itself: Esc belongs to the
  // topmost surface, not to the drawer underneath it.
  it("leaves Escape to an open overlay", () => {
    btn().click();
    doc("overlay").classList.add("open");
    press("Escape");
    expect(drawer.sidebarDrawerOpen()).toBe(true);
    doc("overlay").classList.remove("open");
    press("Escape");
    expect(drawer.sidebarDrawerOpen()).toBe(false);
  });

  it("closes itself when the viewport grows past the breakpoint", () => {
    btn().click();
    expect(win.document.body.classList.contains("sb-open")).toBe(true);

    narrow = false;
    fire("(max-width: 1024px)");
    // The column is back; a stale sb-open would have re-armed the drawer on the
    // way back down.
    expect(win.document.body.classList.contains("sb-open")).toBe(false);
    expect(drawer.sidebarDrawerOpen()).toBe(false);
    expect(btn().getAttribute("aria-expanded")).toBe("false");
    expect(panel().getAttribute("role")).toBe(null);
    expect(panel().style.getPropertyValue("--sb-inset")).toBe("");
  });

  it("keeps a closed drawer closed across breakpoint changes", () => {
    narrow = false;
    fire("(max-width: 1024px)");
    expect(win.document.body.classList.contains("sb-open")).toBe(false);
    expect(drawer.sidebarDrawerOpen()).toBe(false);
  });
});

describe("sidebar tabs vs. the phone breakpoint", () => {
  it("leaves no orphaned pane when the viewport shrinks past the Trace tab", async () => {
    // `bun test` shares the module registry across test files, so another file's
    // `initSidebar()` may already have claimed the shared `sb.el` with its own
    // (different) window. Reset it so this file's DOM is the one being driven.
    const state = await import("../src/modules/webui/assets/js/sidebar/state.js");
    state.sb.el = null;
    const core = await import("../src/modules/webui/assets/js/sidebar/core.js");
    core.initSidebar();
    phone = false;
    // Trace is reachable on a tablet-sized viewport.
    core.setSidebarTab("trace", false);
    expect(doc("pane-trace").hidden).toBe(false);

    // Shrinking to a phone hides the Trace tab button; the pane must go with it,
    // or the drawer shows Trace with no visible tab to switch away from.
    phone = true;
    fire("(max-width: 760px)");
    expect(doc("pane-trace").hidden).toBe(true);
    expect(doc("pane-session").hidden).toBe(false);

    core.setSidebarTab("session", false);
  });
});