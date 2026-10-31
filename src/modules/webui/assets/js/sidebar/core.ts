// Sidebar core for `mma web`: tab switching, indicators, i18n and init. Wires
// the Trace/Map/LSP submodules; `sidebar.js` is the public barrel.
import { icon } from "../dom.js";
import { hooks, session } from "../store.js";
import { t } from "../i18n.js";
import {
  sb,
  TABS,
  ICON_NAME,
  paneEl,
  mqMobile,
  mqNarrow,
  PHONE_MQ,
  readStored,
  storeTab,
  type TraceEntry,
} from "./state.js";
import { collapseDetail, renderList, renderDetail } from "./trace.js";
import { initTraceScroll, traceScrollI18n } from "./trace-scroll.js";
import { sidebarDrawerOpen, setSidebarDrawer } from "./drawer.js";
import { sidebarMapState, sidebarMapIndicator } from "./map.js";
import { renderLsp, sidebarLspState } from "./lsp.js";
import { renderFilesTree, refreshFilesTree, openFileInTree } from "./files.js";
import { renderPlugins, sidebarPluginsState } from "./plugins.js";
import { renderSubagents, sidebarSubagentsState } from "./subagents.js";
import { renderMcp, sidebarMcpState } from "./mcp.js";
import { applyPromptI18n, initPromptPopup } from "./prompt.js";

/**
 * Куда ведёт контекстная кнопка настроек из полосы вкладок. Одна кнопка
 * вместо шести дублей: пользователь всегда видит настройки текущей вкладки.
 */
const SETTINGS_PANEL: Record<string, string> = {
  session: "sessions",
  files: "context",
  lsp: "plugins",
  trace: "ui",
  subagents: "agent",
  plugins: "plugins",
  mcp: "plugins",
  map: "context",
};

/** Якоря внутри панели: LSP и MCP — разные группы одной «Plugins · MCP». */
const SETTINGS_ANCHOR: Record<string, string> = {
  lsp: "settings-lsp",
  mcp: "settings-mcp",
};

let settingsBtn: HTMLElement | null = null;

/**
 * Icon for a sidebar tab. Subagents uses the robot head (`bot`) rather than
 * Lucide `users`: the latter read as an account/multi-user feature, not as
 * agents. Kept as one helper so the tab strip and the pane title cannot drift.
 */
export function tabIcon(id: string): Element {
  return icon(ICON_NAME[id]);
}

/** Подпись кнопки: «открыть настройки · <имя панели>» на языке интерфейса. */
function syncSettingsShortcut(tab: string): void {
  if (!settingsBtn) return;
  const panel = SETTINGS_PANEL[tab] || "general";
  const key = "web.settings." + panel;
  const label = t(key);
  const title = t("web.sidebar.open_settings") + (label !== key ? " · " + label : "");
  settingsBtn.title = title;
  settingsBtn.setAttribute("aria-label", title);
}

export function setSidebarTab(id: string, persist = true): void {
  if (!TABS.includes(id)) id = "session";
  if (persist) storeTab(id);
  const effective = id === "trace" && mqMobile() ? "session" : id;
  if (effective !== sb.active) collapseDetail();
  sb.active = effective;
  TABS.forEach((name) => {
    const pane = paneEl(name);
    if (pane) pane.hidden = name !== effective;
    const tab = sb.el && sb.el.querySelector<HTMLElement>('.sb-tab[data-tab="' + name + '"]');
    if (tab) {
      const on = name === effective;
      tab.classList.toggle("on", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    }
  });
  if (sb.nameTextEl) sb.nameTextEl.textContent = t("web.sidebar.tab_" + effective);
  const nic = sb.nameEl && sb.nameEl.querySelector<HTMLElement>(".sb-ico");
  if (nic) {
    nic.textContent = "";
    nic.appendChild(tabIcon(effective));
  }
  syncSettingsShortcut(effective);
  if (effective === "lsp") sidebarLspState();
  if (effective === "files") renderFilesTree();
  if (effective === "plugins") sidebarPluginsState();
  if (effective === "subagents") sidebarSubagentsState();
  if (effective === "mcp") sidebarMcpState();
}

/**
 * Открыть файл из чата во вкладке Files: переключить вкладку (и раскрыть
 * дровер на узком экране) и раскрыть дерево до файла. Единственная точка входа
 * для ссылок чата — сам `files.js` не знает про вкладки.
 */
export async function openFilesTabFor(raw: string, line?: number): Promise<void> {
  setSidebarTab("files");
  if (mqNarrow() && !sidebarDrawerOpen()) setSidebarDrawer(true);
  await openFileInTree(raw, line);
}

export function sidebarBusy(on: unknown): void {
  const tab = sb.el && sb.el.querySelector<HTMLElement>('.sb-tab[data-tab="trace"]');
  if (tab) tab.dataset.indicator = on ? "live" : "";
}

export function applySidebarI18n(): void {
  if (!sb.el) return;
  TABS.forEach((id) => {
    const tab = sb.el?.querySelector<HTMLElement>('.sb-tab[data-tab="' + id + '"]');
    if (tab) {
      const label = t("web.sidebar.tab_" + id);
      tab.title = label;
      tab.setAttribute("aria-label", label);
    }
  });
  setSidebarTab(sb.active, false);
  renderList();
  traceScrollI18n();
  if (sb.selected) {
    const entry = sb.trace.find((x: TraceEntry) => x.id === sb.selected);
    if (entry) renderDetail(entry);
  }
  sidebarMapState(session.host);
  renderLsp();
  refreshFilesTree();
  renderPlugins();
  renderSubagents();
  renderMcp();
  applyPromptI18n();
}

export function initSidebar(): void {
  if (sb.el) return;
  sb.el = document.querySelector(".sb");
  if (!sb.el) return;
  const root = sb.el;
  sb.nameEl = document.getElementById("sbName");
  sb.nameTextEl = document.getElementById("sbNameText");
  settingsBtn = document.getElementById("sbSettings");
  if (settingsBtn) {
    // `sliders`, not `settings`: the global settings gear sits in the topbar
    // above this row, and two identical gears read as the same destination.
    settingsBtn.appendChild(icon("sliders"));
    settingsBtn.addEventListener("click", () => {
      hooks.openSettingsAt?.(SETTINGS_PANEL[sb.active] || "general", SETTINGS_ANCHOR[sb.active]);
    });
  }
  sb.mapEl = document.getElementById("mapBody");
  sb.lspEl = document.getElementById("lspBody");
  sb.plugins.bodyEl = document.getElementById("pluginsBody");
  sb.listEl = document.getElementById("traceList");
  sb.detailEl = document.getElementById("traceDetail");
  sb.detailGlyph = document.getElementById("detailGlyph");
  sb.detailTitle = document.getElementById("detailTitle");
  sb.detailBody = document.getElementById("detailBody");
  sb.detailClose = document.getElementById("detailClose");
  if (sb.detailClose) sb.detailClose.addEventListener("click", collapseDetail);
  initTraceScroll();
  initPromptPopup();

  root.querySelectorAll<HTMLElement>(".sb-tab .sb-ico").forEach((span) => {
    const id = span.closest<HTMLElement>(".sb-tab")?.dataset.tab || "session";
    span.textContent = "";
    span.appendChild(tabIcon(id));
  });

  root.querySelectorAll<HTMLElement>(".sb-tab").forEach((tab) => {
    tab.addEventListener("click", () => setSidebarTab(tab.dataset.tab || "session"));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const i = TABS.indexOf(tab.dataset.tab || "session");
      const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
      setSidebarTab(next);
      const focus = root.querySelector<HTMLElement>('.sb-tab[data-tab="' + next + '"]');
      if (focus) focus.focus();
    });
  });

  document.addEventListener("keydown", (e) => {
    const n = Number(e.key);
    if (!e.altKey || !Number.isInteger(n) || n < 1 || n > TABS.length) return;
    const tag = document.activeElement ? String(document.activeElement.tagName) : "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    setSidebarTab(TABS[n - 1]);
  });

  document.addEventListener("keydown", (e) => {
    // One Esc, one action: while the drawer is open it is the modal surface and
    // owns Escape (see sidebar/drawer.ts).
    if (e.key === "Escape" && sb.selected && !sidebarDrawerOpen()) collapseDetail();
  });

  // Trace has no tab below 760px. Crossing into phone width with `trace` active
  // left its pane on screen behind a hidden tab button — no visible way back —
  // because the coercion in `setSidebarTab` only ran on a tab click. Re-apply it
  // when the viewport changes instead.
  if (typeof window.matchMedia === "function") {
    const phone = window.matchMedia(PHONE_MQ);
    if (typeof phone.addEventListener === "function") {
      phone.addEventListener("change", (e) => {
        if ((e as MediaQueryListEvent).matches) setSidebarTab(sb.active, false);
      });
    }
  }

  const stored = readStored();
  setSidebarTab(stored && TABS.includes(stored) ? stored : "session");
  renderList();
}

// Keep the public helper surface explicit in the core module too, so callers
// importing it directly (tests) don't need the barrel.
export { sidebarMapState, sidebarMapIndicator, renderLsp, sidebarLspState };
