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
    expect(js(a)).toMatch(/data\.diagnostic && verbosity\(\) !== "verbose"\)\s*return;/);
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
    expect(js(a)).toMatch(/kind === "tool" && verbosity\(\) === "quiet"\)\s*return;/);
  });

  it("compares the context probe against the configured window, not the history budget", () => {
    const a = loadAssets();
    const sidebar = a.jsModules?.["js/feed/sidebar.js"] || "";
    expect(sidebar).toContain("const configured = h.contextWindow || cfg.contextWindow");
    expect(sidebar).not.toContain("const configured = h.contextLimit");
  });

  it("persists open session tabs and restores them on boot", () => {
    const a = loadAssets();
    expect(js(a)).toContain("replaceState");
    expect(js(a)).toContain('searchParams.set("session"');
    expect(js(a)).toContain('searchParams.delete("session")');
    expect(js(a)).toContain('URLSearchParams(location.search).get("session")');
    // The set of open tabs survives a reload (localStorage) and is restored
    // before `refresh()`; the URL `?session=` wins as the active tab.
    const tabs = a.jsModules?.["js/session/tabs.js"] || "";
    expect(a.js).toContain("readSavedTabs");
    expect(a.js).toContain("restoreTabs");
    expect(tabs).toContain("mma-open-tabs");
    expect(js(a)).toMatch(/openTab\(ids\[0\]/);
    expect(js(a)).toMatch(/!feedHasContent\(tab\.feed\) \|\| tab\.historyFailed\)\s*tab\.historyLoaded = false;/);
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

  it("answer typography has breathing room and normal soft breaks", () => {
    const a = loadAssets();
    expect(a.mdJs).toContain('from "./js/md-normalize.js"');
    expect(a.jsModules["js/md-normalize.js"]).toContain("MdNormalizer");
    expect(a.css).toContain(".md { color: var(--ans); overflow-wrap: anywhere; line-height: 1.62; }");
    expect(a.css).toContain(".md p { margin: 9px 0; }");
    expect(a.css).toContain(".md ul, .md ol { margin: 8px 0; padding-left: 24px; }");
    // Soft breaks must flow as spaces (CommonMark), not preserved as hard newlines.
    expect(a.css).not.toMatch(/\.md p \{[^}]*white-space: pre-wrap/);
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
    expect(js(a)).toContain("settings.providerPresets");
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
    expect(js(a)).toContain("setBusy(session.busy)");
  });

  it("wires the ui.fontSize setting to body[data-font]", () => {
    const a = loadAssets();
    expect(js(a)).toContain('"ui.fontSize"');
    expect(js(a)).toContain("applyFontSize(");
    expect(js(a)).toContain("data-font");
    expect(a.css).toContain('body[data-font="compact"]');
    expect(a.css).toContain('body[data-font="large"]');
  });

  it("scopes /api/state to the active tab and renders from per-tab snapshots", () => {
    const a = loadAssets();
    const tabs = a.jsModules?.["js/session/tabs.js"] || "";
    expect(a.js).toContain("/api/state?session=");
    expect(a.js).toContain("hooks.ensureTabState = ensureTabState");
    // Switch sets the client-active session immediately and resets Trace.
    expect(tabs).toContain("session.activeSessionId = id");
    expect(tabs).toContain("sidebarSessionChanged(id)");
    expect(tabs).toContain("hooks.ensureTabState?.(id)");
    // Guard against a stale response clobbering a newer tab.
    expect(a.js).toMatch(/tabState\.activeTabId !== sid\)\s*return;/);
  });

  it("resets the session when the last tab is closed", () => {
    const a = loadAssets();
    const tabs = a.jsModules?.["js/session/tabs.js"] || "";
    const composer = a.jsModules?.["js/session/composer.js"] || "";
    // Closing the last tab resets the client session projection and deactivates
    // the server session (otherwise the next turn / reload reuse the closed
    // context and the sidebar keeps hanging on it).
    expect(tabs).toContain("resetToEmpty");
    expect(tabs).toContain('"/api/sessions/deactivate"');
    expect(tabs).toContain("hooks.renderActive?.()");
    expect(a.js).toContain("hooks.renderActive = renderActiveState");
    // Closing the active tab switches the server active session to the next tab.
    expect(tabs).toContain("hooks.ensureTabState?.(next.id)");
    // Composing on the empty screen starts a fresh session.
    expect(composer).toContain("await deps.newChatTab()");
    // A slash command has no session to create: its output lands in the
    // transcript container instead of being dropped.
    const turn = a.jsModules?.["js/feed/turn.js"] || "";
    expect(turn).toContain("feedForEvent(sid) || msgs");
  });

  it("updates the sidebar from SSE events, with no client polling timers", () => {
    const a = loadAssets();
    const src = js(a);
    // The state event carries the full snapshot; sessions arrive as their own event.
    expect(src).toContain("applyState(d)");
    expect(src).toContain('es.addEventListener("sessions"');
    // The old 2s /api/state and 15s sessions polls are gone.
    expect(src).not.toMatch(/setInterval\([^)]*refresh/);
    expect(src).not.toContain("setInterval(() => void loadSessions()");
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
    expect(a.js).toMatch(/if \(sidebarOwns\(d\)\) \{\s*sidebarTurnEnd\(/);
  });

  it("wires the sidebar tabs (session / files / lsp / trace) with master-detail", () => {
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
    // Sidebar has a fixed width; opening a detail never resizes it, and the
    // detail sits on the left of the list (row-reverse).
    expect(a.css).toContain("width: 679px");
    expect(a.css).toContain("#pane-trace { flex-direction: row-reverse;");
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

    // Tab order has one source of truth: `TABS` drives the visible order, the
    // `Alt+1..6` hotkeys and `←/→`, so index.html must follow it. Reordering the
    // buttons alone would silently detach the hotkeys from the visible row.
    const state = a.jsModules?.["js/sidebar/state.js"] || "";
    const order = (state.match(/export const TABS = \[([^\]]*)\]/)?.[1] || "")
      .split(",")
      .map((s) => s.trim().replace(/"/g, ""))
      .filter(Boolean);
    expect(order).toEqual(["session", "files", "lsp", "trace", "plugins", "map"]);
    const htmlOrder = [...a.html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
    expect(htmlOrder).toEqual(order);
  });

  it("keeps the Files tree beside the viewer (split, resizable, with history)", () => {
    const a = loadAssets();
    const sidebar = sidebarSources(a);
    expect(a.html).toContain('id="pane-files"');
    expect(a.html).toContain('class="files-body"');
    expect(a.html).toContain('id="filesSide"');
    expect(a.html).toContain('class="files-splitter"');
    expect(a.html).toContain('id="filesBar"');
    expect(a.html).toContain('id="filesCrumbs"');
    expect(a.html).toContain('id="filesBack"');
    expect(a.html).toContain('id="filesFwd"');
    expect(a.html).toContain('id="filesExpandAll"');
    expect(a.html).toContain('id="filesCollapseAll"');
    // Opening a file used to hide the tree (`:has()` rule) — guard the split.
    expect(a.css).not.toContain(":has(.files-detail");
    expect(a.css).toContain(".files-body");
    expect(a.css).toContain(".files-splitter");
    // Icon controls are real buttons with a 24px target, not small glyph links.
    expect(a.css).toContain(".fbtn {");
    expect(a.html).not.toContain('title="attach path"');
    expect(a.html).not.toContain('title="close"');
    // Tree cursor/selection: background only. An accent bar or border here read
    // as foreign decoration next to the other sidebar tabs (STYLE.md).
    expect(a.css).not.toMatch(/\.frow\.cursor \{[^}]*box-shadow/);
    expect(a.css).not.toMatch(/\.frow\.cursor \{[^}]*border/);
    expect(a.css).toContain(".frow.cursor { background: var(--hover-bg); }");
    // Tree indentation: one source of truth. An inline `padding-left` from JS
    // overrode the `padding` shorthand, so the left gutter drifted from the right.
    expect(a.css).toContain("padding-left: calc(var(--files-gutter) + var(--indent, 0) * var(--files-indent));");
    const filesTreeSource = a.jsModules?.["js/sidebar/files/tree.js"] || "";
    expect(filesTreeSource).not.toContain("style.paddingLeft");
    expect(filesTreeSource).toContain("--indent");
    expect(sidebar).toContain("web.files.expand_all");
    expect(sidebar).toContain("goBack");
    expect(sidebar).toContain("toggleViewerFull");
  });

  it("wires the Plugins sidebar tab (toggles + details popup)", () => {
    const a = loadAssets();
    expect(a.html).toContain('data-tab="plugins"');
    expect(a.html).toContain('id="pane-plugins"');
    expect(a.html).toContain('id="pluginsBody"');
    const sidebar = sidebarSources(a);
    // Live toggle goes through the single write path (setConfigValue behind
    // POST /api/plugins/:name), not through /api/config.
    expect(sidebar).toContain('"/api/plugins/"');
    expect(sidebar).toContain("makeToggle");
    // Details live in the existing nested overlay — no new modal chrome.
    expect(sidebar).toContain("openSubDialog");
    expect(sidebar).toContain("sidebarPluginsState(");
    expect(sidebar).toContain("sidebarPluginsEvent(");
    // Imports of the tab come through the barrel only (see DAG guard).
    expect(a.js).toContain("sidebarPluginsState,");
    expect(a.css).toContain(".plg-row");
    expect(a.css).toContain(".plg-tag");
    // Alt+6 reaches the sixth tab.
    expect(sidebar).toContain('"6"');
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
    const sigIdx = src.indexOf("feed.lastUsageSig");
    expect(sigIdx).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, sigIdx - 700), sigIdx)).toContain("h.contextBreakdown");
  });

  it("animates the segmented bar across live re-renders (seeds old widths)", () => {
    // renderUsage пересобирает панель целиком; без сидирования прежних ширин
    // новые сегменты прыгали в финальный flex-grow без анимации (бар «замирал»).
    const a = loadAssets();
    const src = js(a);
    expect(src).toContain("lastBarParts");
    expect(src).toContain("applyBarStep(");
    expect(src).toContain("requestAnimationFrame");
    expect(a.css).toContain("transition: flex-grow");
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

  // The sidebar used to be one shape: a fixed 679px column down to 760px, then a
  // drawer with a hardcoded `top: 41px` that ignored the phone sub-bar. Now the
  // drawer covers everything that cannot fit beside the chat (≤1024px) and owns
  // a measured inset.
  it("turns the sidebar into a drawer below 1024px, not 760px", () => {
    const a = loadAssets();
    const sidebar = sidebarSources(a);
    expect(a.html).toContain('id="sbBackdrop"');
    expect(a.css).toContain("@media (max-width: 1024px)");
    expect(a.css).toContain("body.sb-open .sb {");
    expect(a.css).toContain("padding-top: var(--sb-inset, 0px)");
    // A scroll lock would be dead code: the shell is `body { overflow: hidden }`
    // already, and only `#msgs` scrolls behind the drawer.
    expect(a.css).not.toContain("body.sb-open { overflow: hidden; }");
    expect(a.css).toContain("body.sb-open .bar-top { z-index: 46; }");
    // No hardcoded bar height: the drawer used to sit at `top: 41px` and tuck
    // itself under the phone sub-bar that appears below the same breakpoint.
    expect(a.css).not.toContain("top: 41px");
    // The backdrop must be shown by `body.sb-open` only. Displayed
    // unconditionally it sat over the whole viewport above the topbar (44 > 40)
    // and swallowed every click, including its own toggle.
    expect(a.css).toContain("body.sb-open .sb-backdrop {");
    // Anchored at line start: the rule must not apply to `.sb-backdrop` itself,
    // only under `body.sb-open`.
    expect(a.css).not.toMatch(/^\s*\.sb-backdrop \{[^}]*display: block;/m);
    // Master-detail goes vertical in a drawer — 340px of detail beside a list
    // leaves neither readable.
    expect(a.css).toContain("#pane-trace { flex-direction: column-reverse;");
    expect(a.css).toContain(".files-side { flex: 1 1 45%; width: auto; }");
    expect(a.css).toContain(".files-splitter { display: none; }");
    // The tree width is a custom property, so the drawer can ignore it.
    expect(a.css).toContain("width: var(--files-tree-w, 240px);");
    expect(sidebar).toContain("setProperty(\"--files-tree-w\"");
    expect(sidebar).not.toContain('nodes.side.style.width');
  });

  // The drawer is a modal surface: a class toggle alone left no backdrop, no
  // click-outside, no Escape, and — the real defect — no breakpoint sync, so a
  // rotated tablet kept `sb-open` over a layout that no longer had a drawer.
  it("gives the drawer a modal contract and keeps it in sync with the viewport", () => {
    const a = loadAssets();
    const src = a.jsModules?.["js/sidebar/drawer.js"] || "";
    expect(src).toContain("initSidebarDrawer");
    expect(src).toContain('addEventListener("change", syncToViewport)');
    expect(src).toContain('setAttribute("role", "dialog")');
    expect(src).toContain('aria-modal');
    expect(src).toContain("trapTab(");
    expect(src).toContain("overlayOpen()");
    expect(src).toContain("--sb-inset");
    // The toggle button is wired in the drawer module now, not in app.ts.
    expect(a.js).toContain("initSidebarDrawer();");
    expect(a.js).not.toContain('classList.toggle("sb-open")');
    // One breakpoint constant, shared with the CSS (1024px drawer / 760px phone).
    expect(src).toContain("NARROW_MQ");
    const state = a.jsModules?.["js/sidebar/state.js"] || "";
    expect(state).toContain('export const NARROW_MQ = "(max-width: 1024px)"');
    expect(state).toContain('export const PHONE_MQ = "(max-width: 760px)"');
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
