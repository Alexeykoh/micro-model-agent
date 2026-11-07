// Tab strip: renders the tab model into `#tabstrip` and reconciles per-tab
// status badges with the server-side `state`. Extracted from `session/tabs.ts`
// (file-size rule 6): the hub owns the model, this module owns the strip DOM.
// `openTab`/`closeTab` are injected via `initTabstrip`, so this leaf never
// imports back into `tabs.ts` and the frontend DAG stays acyclic.
import { tabstripEl, el, icon } from "../dom.js";
import { t } from "../i18n.js";
import { tabs as tabState, session } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { renderSessBar } from "./composer.js";
import { notifyTabStatus } from "../sounds.js";
import { refreshPauseButton } from "./pause.js";
import { nextTabStatus, statusTitle as statusTitleOf, TAB_DOT } from "./tab-status.js";

type OpenTab = (id: string, name?: string, kind?: string, server?: boolean, activate?: boolean) => void;
type CloseTab = (id: string) => void;

let openTabImpl: OpenTab | null = null;
let closeTabImpl: CloseTab | null = null;

/** Wires the tab operations the strip calls back into (set once by `tabs.ts`). */
export function initTabstrip(deps: { openTab: OpenTab; closeTab: CloseTab }): void {
  openTabImpl = deps.openTab;
  closeTabImpl = deps.closeTab;
}

export function renderTabstrip(): void {
  tabstripEl.textContent = "";
  tabState.tabs.forEach((item: Dict) => {
    const on = item.id === tabState.activeTabId;
    const label = item.name || item.id;
    // The id lives in the tooltip (and the sidebar copy button), not inline,
    // so the session name keeps the tab width.
    const tip = item.kind === "session" ? String(item.id) : label;
    const tab = el("div", "stab" + (on ? " on" : ""));
    tab.setAttribute("role", "tab");
    tab.setAttribute("tabindex", on ? "0" : "-1");
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.setAttribute("aria-label", label);
    tab.title = tip;
    if (item.status && item.status !== "idle") {
      const dot = el("span", "dot st-" + item.status, TAB_DOT[item.status] || "●");
      dot.title = statusTitleOf(item.status);
      dot.setAttribute("aria-label", statusTitleOf(item.status));
      tab.appendChild(dot);
    }
    const nameEl = el("span", "name", label);
    nameEl.title = tip;
    tab.appendChild(nameEl);
    const x = el("button", "stab-x");
    x.type = "button";
    x.title = t("web.topbar.close");
    x.setAttribute("aria-label", t("web.topbar.close") + ": " + label);
    x.appendChild(icon("x"));
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTabImpl?.(item.id);
    });
    tab.appendChild(x);
    const open = () => openTabImpl?.(item.id, item.name, item.kind, true);
    tab.addEventListener("click", open);
    tab.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
    tabstripEl.appendChild(tab);
  });
  scrollActiveTabIntoView();
  renderSessBar();
  // Кнопка паузы живёт в рельсе и зависит от активной вкладки + статуса хода:
  // перерисовка полоски — та же точка синхронизации (pause.ts сам не знает
  // про вкладки, DAG остаётся ацикличным).
  refreshPauseButton();
}

// Keep the active tab visible, aligned to its START so the beginning of the
// session name stays readable (aligning the end would cut the name off,
// which is exactly what phones showed when tapping a tab on the right).
function scrollActiveTabIntoView(): void {
  const active = tabstripEl.querySelector<HTMLElement>(".stab.on");
  if (!active) return;
  const left = Math.max(0, active.offsetLeft - 4);
  if (left < tabstripEl.scrollLeft || left + active.offsetWidth > tabstripEl.scrollLeft + tabstripEl.clientWidth) {
    tabstripEl.scrollLeft = left;
  }
}

tabstripEl.addEventListener(
  "wheel",
  (e) => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    tabstripEl.scrollLeft += e.deltaY;
  },
  { passive: false },
);

/**
 * Сверяет бейджи вкладок с серверным per-session статусом (SSE `state`):
 * бегущая → working, в очереди → queued, прочие working/queued → idle.
 * `waiting` дольше STALE_WAITING_MS без подтверждения — зависший вопрос
 * (аудит §6.16).
 */
export function reconcileTabStatuses(): void {
  const running = session.runningSessionIds || [];
  const queued = session.queued || {};
  const now = Date.now();
  let changed = false;
  tabState.tabs.forEach((tab: Dict) => {
    if (tab.kind !== "session") return;
    const next = nextTabStatus(tab, running, queued, now);
    if (!next) return;
    const prev = tab.status;
    tab.status = next;
    // Сверка с серверным `state` — вторая (и последняя) точка сигнала: звук
    // не может разойтись с фактическим статусом вкладки.
    notifyTabStatus(prev, next);
    changed = true;
  });
  if (changed) renderTabstrip();
}
