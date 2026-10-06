// Sidebar core for `mma web`: tab switching, indicators, i18n and init. Wires
// the Trace/Map/LSP submodules; `sidebar.js` is the public barrel.
import { icon } from "../dom.js";
import { session } from "../store.js";
import { t } from "../i18n.js";
import { sb, TABS, ICON_NAME, paneEl, mqMobile, readStored, storeTab, type TraceEntry } from "./state.js";
import { collapseDetail, renderList, renderDetail } from "./trace.js";
import { sidebarMapState, sidebarMapIndicator } from "./map.js";
import { renderLsp, sidebarLspState } from "./lsp.js";
import { renderFilesTree, refreshFilesTree } from "./files.js";

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
  if (nic) { nic.textContent = ""; nic.appendChild(icon(ICON_NAME[effective])); }
  if (effective === "lsp") sidebarLspState();
  if (effective === "files") renderFilesTree();
}

export function sidebarBusy(on: unknown): void {
  const tab = sb.el && sb.el.querySelector<HTMLElement>('.sb-tab[data-tab="trace"]');
  if (tab) tab.dataset.indicator = on ? "live" : "";
}

export function applySidebarI18n(): void {
  if (!sb.el) return;
  TABS.forEach((id) => {
    const tab = sb.el?.querySelector<HTMLElement>('.sb-tab[data-tab="' + id + '"]');
    if (tab) { const label = t("web.sidebar.tab_" + id); tab.title = label; tab.setAttribute("aria-label", label); }
  });
  setSidebarTab(sb.active, false);
  renderList();
  if (sb.selected) {
    const entry = sb.trace.find((x: TraceEntry) => x.id === sb.selected);
    if (entry) renderDetail(entry);
  }
  sidebarMapState(session.host);
  renderLsp();
  refreshFilesTree();
}

export function initSidebar(): void {
  if (sb.el) return;
  sb.el = document.querySelector(".sb");
  if (!sb.el) return;
  const root = sb.el;
  sb.nameEl = document.getElementById("sbName");
  sb.nameTextEl = document.getElementById("sbNameText");
  sb.mapEl = document.getElementById("mapBody");
  sb.lspEl = document.getElementById("lspBody");
  sb.listEl = document.getElementById("traceList");
  sb.detailEl = document.getElementById("traceDetail");
  sb.detailGlyph = document.getElementById("detailGlyph");
  sb.detailTitle = document.getElementById("detailTitle");
  sb.detailBody = document.getElementById("detailBody");
  sb.detailClose = document.getElementById("detailClose");
  if (sb.detailClose) sb.detailClose.addEventListener("click", collapseDetail);

  root.querySelectorAll<HTMLElement>(".sb-tab .sb-ico").forEach((span) => {
    const id = span.closest<HTMLElement>(".sb-tab")?.dataset.tab || "session";
    span.textContent = "";
    span.appendChild(icon(ICON_NAME[id]));
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
    if (!e.altKey || !["1", "2", "3", "4", "5"].includes(e.key)) return;
    const tag = document.activeElement ? String(document.activeElement.tagName) : "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    setSidebarTab(TABS[Number(e.key) - 1]);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sb.selected) collapseDetail();
  });

  const stored = readStored();
  setSidebarTab(stored && TABS.includes(stored) ? stored : "session");
  renderList();
}

// Keep the public helper surface explicit in the core module too, so callers
// importing it directly (tests) don't need the barrel.
export { sidebarMapState, sidebarMapIndicator, renderLsp, sidebarLspState };
