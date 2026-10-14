// Mobile session sub-header for `mma web`.
//
// Phones show a session control bar under the topbar: prev/next arrows step
// through the open tabs, ✕ closes the active tab, and the + / list tools
// relocate here (see placeTopTools) so the topbar keeps room for tabs.
// Extracted from `composer.ts` (rule 6: ≤300 lines/file).
import { tabs as tabState } from "../store.js";
import { openSessionsMenu } from "./sessions-menu.js";
import { renderQueueStrip } from "./queue.js";

/** Tab operations the sub-header calls back into (injected by the tab hub). */
interface SessBarDeps {
  openTab: (id: string, name?: string, kind?: string, server?: boolean) => void;
  closeTab: (id: string) => void;
  statusTitle: (status: unknown) => string;
}

let deps: SessBarDeps = {
  openTab: () => {},
  closeTab: () => {},
  statusTitle: () => "",
};

/** Injects the tab operations (called by `initComposer`). */
export function initSessBar(d: Partial<SessBarDeps>): void {
  deps = { ...deps, ...d };
}

const sessBar = document.getElementById("sessBar");
const sessNameBtn = document.getElementById("sessNameBtn") as HTMLButtonElement;
const sessNameEl = document.getElementById("sessName") as HTMLElement;
const sessPrevBtn = document.getElementById("sessPrev") as HTMLButtonElement;
const sessNextBtn = document.getElementById("sessNext") as HTMLButtonElement;
const sessCloseBtn = document.getElementById("sessClose") as HTMLButtonElement;
const sessTools = document.getElementById("sessTools");
const sessDD = document.getElementById("sessDD");
const barTop = document.querySelector(".bar-top");
const newChatBtn = document.getElementById("newChat");
// Anchor remembering the desktop slot of the + / list controls.
const topToolsAnchor = document.createComment("top-tools");
if (barTop && newChatBtn) barTop.insertBefore(topToolsAnchor, newChatBtn);

function stepTab(dir: number): void {
  if (tabState.tabs.length < 2) return;
  const i = tabState.tabs.findIndex((x) => x.id === tabState.activeTabId);
  const n = i === -1 ? 0 : (i + dir + tabState.tabs.length) % tabState.tabs.length;
  const tab = tabState.tabs[n];
  // Same semantics as clicking the tab in the strip.
  if (tab) deps.openTab(tab.id, tab.name, tab.kind, true);
}

export function renderSessBar(): void {
  if (!sessBar) return;
  const active = tabState.tabs.find((x) => x.id === tabState.activeTabId);
  const label = active ? active.name || String(active.id) : "—";
  sessNameEl.textContent = label;
  sessNameBtn.title = label + (active && active.status && active.status !== "idle" ? " · " + deps.statusTitle(active.status) : "");
  const has = tabState.tabs.length > 0;
  sessPrevBtn.disabled = tabState.tabs.length < 2;
  sessNextBtn.disabled = tabState.tabs.length < 2;
  sessCloseBtn.disabled = !has;
  sessNameBtn.disabled = !has;
  // Tab open/close/switch re-renders the pinned queue strip for the new active
  // tab (the last tab closing must drop its rows).
  renderQueueStrip();
}

// Nodes are relocated (not duplicated), so their listeners and the sessions
// dropdown anchoring (.dd is position:relative) survive the move.
function placeTopTools(): void {
  if (!barTop || !sessTools || !newChatBtn || !sessDD) return;
  if (window.matchMedia("(max-width: 760px)").matches) {
    sessTools.append(newChatBtn, sessDD);
  } else {
    barTop.insertBefore(newChatBtn, topToolsAnchor);
    barTop.insertBefore(sessDD, topToolsAnchor);
  }
}

if (sessPrevBtn) sessPrevBtn.addEventListener("click", () => stepTab(-1));
if (sessNextBtn) sessNextBtn.addEventListener("click", () => stepTab(1));
if (sessCloseBtn) sessCloseBtn.addEventListener("click", () => {
  if (tabState.activeTabId) deps.closeTab(tabState.activeTabId);
});
if (sessNameBtn) sessNameBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  openSessionsMenu();
});
if (typeof window.matchMedia === "function") {
  const narrowMq = window.matchMedia("(max-width: 760px)");
  if (typeof narrowMq.addEventListener === "function") narrowMq.addEventListener("change", placeTopTools);
  placeTopTools();
}
