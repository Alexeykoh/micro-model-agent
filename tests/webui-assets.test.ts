import { describe, it, expect } from "vitest";
import { loadAssets } from "../src/modules/webui/assets";
import type { WebUiAssets } from "../src/modules/webui/state";

// Frontend is split into ES modules (`app.js` + `js/*.js`); source-level
// guards search the combined bundle source, mirroring the browser import graph.
function js(a: WebUiAssets): string {
  return [a.js, ...Object.values(a.jsModules ?? {})].join("\n");
}

// Sidebar is split into `js/sidebar.js` (barrel) + `js/sidebar/*.js`; combine
// them so the source guards below match regardless of which submodule holds a
// given symbol.
function sidebarSources(a: WebUiAssets): string {
  return Object.entries(a.jsModules ?? {})
    .filter(([k]) => k === "js/sidebar.js" || k.startsWith("js/sidebar/"))
    .map(([, v]) => v)
    .join("\n");
}

describe("webui assets", () => {
  it("loads html/css/js from disk", () => {
    const a = loadAssets();
    expect(a.html).toContain("<!DOCTYPE html>");
    expect(a.css.length).toBeGreaterThan(10);
    expect(js(a)).toContain("EventSource");
  });

  // No DOM harness is available in the unit test env, so this is a source-level
  // guard: the feed renders the plan card from a dedicated SSE `plan` event.
  it("wires the plan event to the .planblock feed card", () => {
    const a = loadAssets();
    expect(js(a)).toContain('["plan", onPlan]');
    expect(js(a)).toContain("planblock");
    expect(a.css).toContain(".planblock");
  });

  it("wires the question event to an interactive .q block posting /api/answer", () => {
    const a = loadAssets();
    expect(js(a)).toContain('["question", onQuestion]');
    expect(js(a)).toContain("/api/answer");
    expect(js(a)).toContain("qopt");
    expect(a.css).toContain(".q .qopt");
  });

  it("wires the OutputBus log event and the immediate busy indicator", () => {
    const a = loadAssets();
    expect(js(a)).toContain('["log", onLog]');
    expect(js(a)).toContain("showBusy(");
    expect(a.css).toContain(".busy .busytime");
  });

  it("renders diagnostic log lines only in verbose mode", () => {
    const a = loadAssets();
    expect(js(a)).toContain('if (data.diagnostic && verbosity() !== "verbose") return;');
  });

  it("renders file actions as quiet filerow lines with viewer link and icon copy", () => {
    const a = loadAssets();
    const src = js(a);
    expect(src).toContain('"filerow');
    expect(src).toContain('icon("copy")');
    expect(src).toContain('"check"');
    expect(src).toMatch(/el\("a", "path"[\s\S]{0,200}?target = "_blank"/);
    expect(src).toContain('openLink.rel = "noopener noreferrer"');
    expect(src).not.toContain("&token=");
    expect(src).not.toContain("download=1");
    expect(src).not.toContain("fc-open");
    expect(src).not.toContain("fc-actions");
    expect(a.css).toContain(".filerow");
    expect(a.css).not.toContain(".filecard");
  });

  it("always expands file rows (no grouping) with full root-relative links", () => {
    const a = loadAssets();
    const src = js(a);
    expect(src).toContain("displayPathFromRoot");
    expect(src).not.toContain("filegroup");
    expect(src).not.toContain("maybeGroupFilerow");
    expect(src).not.toContain("fc-hint");
    expect(a.css).not.toContain(".filegroup");
  });

  it("keeps consecutive file/action rows compact", () => {
    const a = loadAssets();
    expect(a.css).toContain(".filerow + .filerow");
    expect(a.css).toContain("margin-top: -7px");
  });

  it("glues scroll edge fades to the transcript edges", () => {
    const a = loadAssets();
    // Breathing lives on `.feed`, so sticky fades stick to the exact
    // scrollport edges instead of floating on scroller padding.
    expect(a.css).toContain(".msgs::before");
    expect(a.css).toContain(".msgs::after");
    expect(a.css).toContain("margin-bottom: -33px");
    expect(a.css).toContain("margin-top: -33px");
    expect(a.css).toMatch(/\.feed \{[^}]*padding: 18px 0/);
  });

  it("marks the finished answer apart from the work process", () => {
    const a = loadAssets();
    expect(a.css).toContain(".feed > .md");
    expect(a.css).toContain("border-left: 2px solid var(--accent)");
  });

  it("renders reasoning blocks collapsed by default", () => {
    const a = loadAssets();
    expect(js(a)).toContain('"think-body hidden"');
  });

  it("listens for the dedicated reasoning event", () => {
    const a = loadAssets();
    expect(js(a)).toContain('["reasoning", (d) => onReasoning(d.chunk || "", d.sessionId)]');
    expect(js(a)).toContain('["meta", (d) => onMeta(d.chunk || "", d.sessionId, d.kind)]');
    expect(js(a)).not.toContain("finishMeta");
  });

  it("renders generic meta as always-visible lines", () => {
    const a = loadAssets();
    expect(js(a)).toContain("metaln");
    expect(a.css).toContain(".metaln");
    expect(a.css).toContain(".metaln.warn");
  });

  it("quiet-gates tool-body meta in the feed, keeping status visible", () => {
    const a = loadAssets();
    expect(js(a)).toContain('if (kind === "tool" && verbosity() === "quiet") return;');
  });

  it("persists the active session in the URL and restores it on boot", () => {
    const a = loadAssets();
    expect(js(a)).toContain("replaceState");
    expect(js(a)).toContain('searchParams.set("session"');
    expect(js(a)).toContain('searchParams.delete("session")');
    expect(js(a)).toContain('URLSearchParams(location.search).get("session")');
    expect(js(a)).toMatch(/openTab\(initialSession/);
    expect(js(a)).toContain("if (!feedHasContent(tab.feed) || tab.historyFailed) tab.historyLoaded = false;");
  });

  it("marks tabs of server-deleted sessions dead instead of retry-looping", () => {
    const a = loadAssets();
    // 404 activate/history → dead card, no silent desync.
    expect(js(a)).toContain("markTabDead");
    expect(js(a)).toContain('r.status === 404');
    // Status dots know the dead state.
    expect(js(a)).toContain('dead: "✗"');
    expect(js(a)).toContain("web.session.gone");
    expect(js(a)).toContain("web.tab.gone");
    expect(a.css).toContain(".st-dead");
  });

  it("ships the first-run setup gate and wizard assets", () => {
    const a = loadAssets();
    expect(a.html).toContain('id="setupGate"');
    expect(a.html).toContain('src="/setup.js"');
    expect(a.setupJs).toBeTruthy();
    expect(a.css).toContain(".setup-gate");
    expect(a.css).toContain("body.setup-active");
  });

  it("wires the setup wizard to the /api/setup endpoints and app boot hook", () => {
    const a = loadAssets();
    expect(a.setupJs).toContain('window.MmaSetup');
    expect(a.setupJs).toContain('"/api/setup"');
    expect(a.setupJs).toContain('"/api/setup/scan"');
    expect(a.setupJs).toContain('"/api/setup/models"');
    expect(a.setupJs).toContain('"/api/setup/test"');
    expect(a.setupJs).toContain('"/api/setup/locale"');
    expect(js(a)).toContain("window.MmaSetup");
  });

  it("wires the Agent settings panel (MoE + critic keys) without a critic SSE handler", () => {
    const a = loadAssets();
    expect(js(a)).not.toContain('["critic"');
    expect(js(a)).not.toContain("onCritic");
    expect(js(a)).toContain("critic.enabled");
    expect(js(a)).toContain("moe.enabled");
    expect(a.html).toContain('data-p="agent"');
    expect(a.html).toContain('data-panel="agent"');
  });

  it("ships the streaming markdown renderer with vendored smd + highlight.js", () => {
    const a = loadAssets();
    expect(a.mdJs).toBeTruthy();
    expect(a.mdJs).toContain("mountMarkdown");
    expect(a.mdJs).toContain("renderMarkdown");
    expect(a.mdJs).toContain("copyText");
    expect(a.mdJs).toContain('from "./smd.js"');
    expect(a.mdJs).toContain("hljs");
    expect(a.smdJs).toContain("parser_write");
    expect(a.hljsJs.length).toBeGreaterThan(1000);
  });

  it("renders answers through the streaming markdown module", () => {
    const a = loadAssets();
    expect(js(a)).toMatch(/from "(?:\.\.\/)+md\.js"/);
    expect(js(a)).toContain("mountMarkdown(");
    expect(js(a)).toContain("renderMarkdown(");
    expect(js(a)).not.toContain("parseFences");
    expect(js(a)).toContain("appendActionsRow");
  });

  it("loads hljs and the module app, and styles code blocks + copy actions", () => {
    const a = loadAssets();
    expect(a.html).toContain('src="/hljs.js"');
    expect(a.html).toContain('type="module" src="/app.js"');
    expect(a.css).toContain(".codeblock");
    expect(a.css).toContain(".cb-copy");
    expect(a.css).toContain(".hljs-keyword");
    expect(a.css).toContain(".msg-actions");
  });

  it("groups the model/provider settings into sections with an add affordance", () => {
    const a = loadAssets();
    expect(js(a)).toContain("settingsSection(");
    expect(js(a)).toContain("web.settings.section_providers");
    expect(js(a)).toContain("provider_make_active");
    expect(js(a)).toContain("provider_advanced");
    expect(a.html).toContain('data-panel="model"');
    expect(a.css).toContain(".settings-section");
    expect(a.css).toContain(".provider-item");
    expect(a.css).toContain(".sec-add");
    expect(a.css).toContain(".pform-adv");
  });

  it("offers one-click builtin provider presets in the form", () => {
    const a = loadAssets();
    expect(js(a)).toContain("state.providerPresets");
    expect(js(a)).toContain("provider_preset");
    expect(js(a)).toContain("provider_custom");
    expect(a.css).toContain(".pform-field select");
  });

  it("renders provider type and base URL as real dropdowns, not datalist hints", () => {
    const a = loadAssets();
    const src = js(a);
    expect(src).toContain("PROVIDER_TYPES");
    expect(src).toContain("providerBaseField(");
    expect(src).toContain("provider_baseurl_custom");
    expect(src).not.toContain("providerTypes");
    expect(src).not.toContain("providerBaseUrls");
    expect(src).not.toContain('el("datalist"');
    expect(a.css).toContain(".pform-base");
  });

  it("wires the mobile session sub-header and start-aligned tab scrolling", () => {
    const a = loadAssets();
    const src = js(a);
    expect(a.html).toContain('id="sessBar"');
    expect(a.html).toContain('id="sessPrev"');
    expect(a.html).toContain('id="sessNext"');
    expect(a.html).toContain('id="sessClose"');
    expect(a.html).toContain('id="sessTools"');
    expect(src).toContain("renderSessBar(");
    expect(src).toContain("stepTab(");
    expect(src).toContain("placeTopTools(");
    expect(src).toContain("chevron-left");
    expect(a.css).toContain(".bar-sub");
    expect(a.css).toContain(".sess-tools .dd-menu");
  });

  it("wires the activity rail above the composer", () => {
    const a = loadAssets();
    expect(a.html).toContain('id="railWrap"');
    expect(a.html).toContain('role="status" aria-live="polite"');
    expect(a.css).toContain(".rail-wrap.l-line");
    expect(a.css).toContain(".rl-track");
    expect(a.css).toContain(".rl-scan");
    expect(js(a)).toContain("initRail(");
    expect(js(a)).toContain("railEvent(");
    expect(js(a)).toContain('["tool_start", "tool_end", "text", "plan"]');
    expect(js(a)).toContain('"ui.activityRail"');
    expect(js(a)).toContain("setBusy(S.state.busy)");
  });

  it("wires the ui.fontSize setting to body[data-font]", () => {
    const a = loadAssets();
    expect(js(a)).toContain('"ui.fontSize"');
    expect(js(a)).toContain("applyFontSize(");
    expect(js(a)).toContain("data-font");
    expect(a.css).toContain('body[data-font="compact"]');
    expect(a.css).toContain('body[data-font="large"]');
  });

  it("scopes /api/state to the active tab and refreshes fully on switch", () => {
    const a = loadAssets();
    const tabs = a.jsModules?.["js/session/tabs.js"] || "";
    expect(a.js).toContain("/api/state?session=");
    expect(a.js).toContain("hooks.applyState = renderState");
    expect(a.js).toContain("hooks.refreshState = refresh");
    // Switch sets the client-active session immediately and resets Trace.
    expect(tabs).toContain("S.state.activeSessionId = id");
    expect(tabs).toContain("sidebarSessionChanged(id)");
    expect(tabs).toContain("hooks.refreshState?.()");
    // Guard against a stale response clobbering a newer tab.
    expect(a.js).toContain("if (S.activeTabId !== sid) return;");
  });

  it("uses one shared EventSource so all tabs stream live (no per-session reconnect)", () => {
    const a = loadAssets();
    expect(a.js).toContain('new EventSource(sseUrl)');
    expect(a.js).not.toContain("syncSseSession");
    expect(a.js).not.toContain('params.push("session="');
  });

  it("shows a loading indicator for the session sidebar section", () => {
    const a = loadAssets();
    const sidebar = sidebarSources(a) || "";
    const tabs = a.jsModules?.["js/session/tabs.js"] || "";
    expect(sidebar).toContain("setSessionLoading");
    expect(tabs).toContain("setSessionLoading(true)");
    expect(a.js).toContain("setSessionLoading(false)");
    expect(a.css).toContain(".sb.sb-loading #pane-session");
  });

  it("filters the sidebar Trace by its own session", () => {
    const a = loadAssets();
    const sidebar = sidebarSources(a) || "";
    expect(sidebar).toContain("sidebarSessionId");
    expect(a.js).toContain("sidebarOwns(");
    expect(a.js).toContain("sidebarSessionId()");
    // Background sessions must not advance the sidebar turn counter or clear
    // its live indicator.
    expect(a.js).toContain("if (sidebarOwns(d)) { sidebarTurnEnd(");
  });

  it("wires the sidebar tabs (session / map / trace) with master-detail", () => {
    const a = loadAssets();
    expect(a.html).toContain('class="sb-tabs"');
    expect(a.html).toContain('data-tab="session"');
    expect(a.html).toContain('data-tab="map"');
    expect(a.html).toContain('data-tab="trace"');
    expect(a.html).toContain('id="sbNameText"');
    expect(a.html).toContain('id="traceList"');
    expect(a.html).toContain('id="traceDetail"');
    expect(a.html).toContain('id="mapBody"');
    expect(a.css).toContain(".sb-tab.on");
    expect(a.css).toContain(".sb.sb-expanded");
    expect(a.css).toContain(".trc-detail");
    expect(a.js).toContain("initSidebar()");
    expect(a.js).toContain("sidebarTraceEvent(");
    expect(a.js).toContain("sidebarMapState(");
    expect(sidebarSources(a)).toContain("/api/index");
    expect(sidebarSources(a)).toBeTruthy();
    // No horizontal scroll in any tab: sidebar panes clip on x, values wrap.
    expect(a.css).toContain("overflow-x: hidden");
    expect(a.css).toContain(".kv > span:first-child");
    // Trace detail collapses on tab switch; the long map root stacks vertically.
    expect(sidebarSources(a)).toContain("collapseDetail()");
    expect(sidebarSources(a)).toContain("mapPathRow(");
    expect(a.css).toContain(".map-path");
    // Trace rows must not shrink: flex-column otherwise squeezes hundreds
    // of events into the visible height (no scrollbar, dotted-line mush).
    expect(a.css).toContain(".trace-list > *");
  });

  it("imports every sidebar helper it calls (no undefined render crash)", () => {
    const a = loadAssets();
    const src = a.js;
    const importMatch = src.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/js\/sidebar\.js"/);
    expect(importMatch).toBeTruthy();
    const imported = new Set(
      importMatch![1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    // Locally declared `sidebarXxx` (const/let/function) are not imports.
    const locals = new Set(
      [...src.matchAll(/(?:const|let|function)\s+(sidebar[A-Z]\w*)/g)].map((m) => m[1]),
    );
    const body = src.replace(importMatch![0], "");
    const used = [...body.matchAll(/\b(sidebar[A-Z]\w*)\b/g)].map((m) => m[1]);
    const missing = [...new Set(used)].filter((n) => !imported.has(n) && !locals.has(n));
    expect(missing).toEqual([]);
  });

  it("wires the LSP sidebar tab (doctor) with an on-demand check", () => {
    const a = loadAssets();
    const sidebar = sidebarSources(a) || "";
    expect(a.html).toContain('data-tab="lsp"');
    expect(a.html).toContain('id="lspBody"');
    expect(sidebar).toContain("/api/lsp/doctor");
    expect(sidebar).toContain("sidebarLspState(");
    expect(sidebar).toContain("sidebarLspEvent(");
    expect(sidebar).toContain("web.sidebar.lsp_reason_");
    expect(a.js).toContain("sidebarLspEvent(");
    expect(a.js).toContain("sidebarLspState(");
    expect(a.css).toContain(".lsp-g.fail");
  });

  it("renders the context breakdown as a segmented bar with a legend", () => {
    const a = loadAssets();
    const src = js(a);
    expect(src).toContain("contextSegBar(");
    expect(src).toContain("contextLegend(");
    expect(src).toContain("web.usage.part_system");
    expect(src).toContain("seg-free");
    expect(a.css).toContain(".bar.segbar");
    expect(a.css).toContain(".seglegend");
    expect(a.css).toContain("--seg-system");
  });

  it("includes the breakdown in the usage re-render signature (ses_mup6p61q)", () => {
    // Без h.contextBreakdown в sig смена частей при тех же used/limit
    // не перерисовывала полосу и легенду (stale UI).
    const a = loadAssets();
    const src = js(a);
    const sigIdx = src.indexOf("S.lastUsageSig");
    expect(sigIdx).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, sigIdx - 700), sigIdx)).toContain("h.contextBreakdown");
  });

  it("renders a stale-translations banner driven by i18nStale (ses_mup6p61q)", () => {
    const a = loadAssets();
    const src = js(a);
    expect(src).toContain("setStaleBar(");
    expect(src).toContain("web.i18n.stale");
    expect(a.html).toContain('id="staleBar"');
  });

  it("hides the Trace tab on mobile and applies sidebar i18n on boot", () => {
    const a = loadAssets();
    expect(a.css).toContain('.sb-tab[data-tab="trace"]');
    expect(a.js).toContain("applySidebarI18n(");
    expect(a.js).toContain('sidebarTraceEvent("error"');
    expect(a.js).toContain("sidebarTurnEnd(");
  });

  it("filters the composer model dropdown through a search field", () => {
    const a = loadAssets();
    const src = js(a);
    expect(src).toContain("selModelSearch");
    expect(src).toContain("web.selectors.search_models");
    expect(src).toContain("model-menu-list");
    expect(src).toContain("matchesQuery(");
    expect(a.css).toContain(".menu .searchbox");
    expect(a.css).toContain(".model-menu-list");
  });

  it("filters the sessions dropdown by name and id through a static search field", () => {
    const a = loadAssets();
    const src = js(a);
    expect(a.html).toContain('id="sessSearch"');
    expect(src).toContain("sessSearch");
    expect(src).toContain("web.sessions.search");
    expect(src).toContain("sessQuery");
    expect(src).toContain("ensureSessSearch(");
    expect(a.css).toContain(".dd-menu .searchbox");
  });
});
