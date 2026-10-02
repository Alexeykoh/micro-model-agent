// Real DOM coverage for the sidebar leaf module (the source-string guards in
// webui-assets.test.ts can't exercise runtime behaviour). `bun test` doesn't
// apply vitest's environment docblock, so happy-dom is wired manually.
import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";

const HTML = `
  <div class="sb">
    <div class="sb-tabs" role="tablist">
      <button class="sb-tab" type="button" role="tab" data-tab="session"><span class="sb-ico"></span></button>
      <button class="sb-tab" type="button" role="tab" data-tab="map"><span class="sb-ico"></span></button>
      <button class="sb-tab" type="button" role="tab" data-tab="trace"><span class="sb-ico"></span></button>
    </div>
    <div class="sb-name" id="sbName"><span class="sb-ico"></span><span id="sbNameText"></span></div>
    <div class="sb-pane" id="pane-session" role="tabpanel">
      <div class="sec"><div class="sec-body" id="plan"></div></div>
      <div class="sec"><div class="sec-body" id="usage"></div></div>
      <div class="sec"><div class="sec-body" id="env"></div></div>
    </div>
    <div class="sb-pane" id="pane-map" role="tabpanel" hidden><div class="sec-body" id="mapBody"></div></div>
    <div class="sb-pane" id="pane-trace" role="tabpanel" hidden>
      <div class="trace-list" id="traceList"></div>
      <div class="trc-detail" id="traceDetail" hidden>
        <span id="detailGlyph"></span><span id="detailTitle"></span>
        <button id="detailClose" type="button"></button><div id="detailBody"></div>
      </div>
    </div>
  </div>`;

const win = new Window({ url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.location = win.location;
g.localStorage = win.localStorage;
win.document.body.innerHTML = HTML;

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.dicts = {
  en: {
    "web.sidebar.trace_empty": "no events yet",
    "web.sidebar.trace_turn": "turn {n}",
    "web.sidebar.trace_text": "composing… {count} chars",
  },
};
const sidebar = await import("../src/modules/webui/assets/js/sidebar.js");
sidebar.initSidebar();

const rows = () => win.document.getElementById("traceList").querySelectorAll(".trc");

describe("sidebar DOM behaviour", () => {
  it("tracks the sidebar session and clears the trace on switch", () => {
    sidebar.sidebarSessionChanged("ses_A");
    sidebar.sidebarTraceEvent("tool_start", {
      toolCallId: "c1",
      name: "read_file",
      args: { path: "x" },
    });
    expect(rows().length).toBe(1);

    sidebar.sidebarSessionChanged("ses_B");
    expect(sidebar.sidebarSessionId()).toBe("ses_B");
    expect(win.document.querySelector(".sb").dataset.sid).toBe("ses_B");
    expect(rows().length).toBe(0);
  });

  it("does not clear the trace when the session is unchanged", () => {
    sidebar.sidebarSessionChanged("ses_C");
    sidebar.sidebarTraceEvent("tool_start", { toolCallId: "c2", name: "grep", args: {} });
    sidebar.sidebarSessionChanged("ses_C");
    expect(rows().length).toBe(1);
  });

  it("toggles the session loading indicator", () => {
    sidebar.setSessionLoading(true);
    expect(win.document.querySelector(".sb").classList.contains("sb-loading")).toBe(true);
    expect(win.document.getElementById("pane-session").getAttribute("aria-busy")).toBe("true");
    sidebar.setSessionLoading(false);
    expect(win.document.querySelector(".sb").classList.contains("sb-loading")).toBe(false);
    expect(win.document.getElementById("pane-session").getAttribute("aria-busy")).toBe("false");
  });

  it("collapses streamed text into a single row with a char count", () => {
    sidebar.sidebarSessionChanged("ses_D");
    sidebar.sidebarTraceEvent("text", { chunk: "hello" });
    sidebar.sidebarTraceEvent("text", { chunk: " world" });
    expect(rows().length).toBe(1);
    expect(rows()[0].textContent).toContain("11");
  });
});
