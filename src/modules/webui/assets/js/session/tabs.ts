// Tabs hub: tab model/strip/status, openTab/closeTab, session loaders.
// Owns session-state hydration (loaders render their own chrome). The session
// dropdown, composer and slash-autocomplete are siblings under `./session/`;
// they receive the tab operations they need via their `init*` functions, so
// this hub is the only importer and the frontend DAG stays acyclic.
import { msgs, inp, tabstripEl, el, icon, link } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { tabs as tabState, session, hooks } from "../store.js";
import type { Dict } from "../core/store/types.js";
import {
  makeFeed, showEmptyFeed, activeFeed, appendTo, feedHasContent,
  loadHistory, syncUrl, scrollToBottom,
} from "../feed.js";
import { setIndicator } from "../dialog.js";
import { sidebarSessionChanged, setSessionLoading } from "../sidebar.js";
import { setSessOpen } from "../core/menus.js";
import { closeCmdk } from "./cmdk.js";
import {
  saveComposer, restoreComposer, renderAttachments, renderSessBar,
  initComposer,
} from "./composer.js";
import { renderSessionsDropdown, initSessionsMenu } from "./sessions-menu.js";

export { reflectBusy } from "./composer.js";
export { loadCommands } from "./cmdk.js";
export { renderSessionsDropdown } from "./sessions-menu.js";

// Статусы вкладок: working — идёт ход, waiting — ждёт ответа (question),
// queued — стоит в per-session очереди, failed — ход упал, dead — сессии нет
// на сервере (удалена/подчищена: activate и history отвечают 404).
// Рендерится точкой в табстрипе; завершение в чужой вкладке фокус не крадёт,
// только бейдж.
const TAB_DOT: Record<string, string> = { working: "●", waiting: "◉", queued: "○", failed: "✗", dead: "✗" };

function statusTitle(status: unknown): string {
  if (status === "working") return t("web.tab.working");
  if (status === "waiting") return t("web.tab.waiting");
  if (status === "queued") return t("web.tab.queued");
  if (status === "failed") return t("web.tab.failed");
  if (status === "dead") return t("web.tab.gone");
  return "";
}

// Per-tab composer + status (общепринято: черновик свой у каждой сессии).
// `draft`/`attachments` живут на табе и переживают переключения (single `#inp`
// остаётся один на весь браузер, но ощущается как свой за счёт save/restore).
// `status`: idle | working | waiting | queued | failed (done схлопывается в idle).
export function activeTab(): Dict | null {
  return tabState.tabs.find((x) => x.id === tabState.activeTabId) || null;
}

export function setTabStatus(id: string | null | undefined, status: string): void {
  if (!id) return;
  const tab = tabState.tabs.find((x) => x.id === id);
  if (!tab || tab.status === status || tab.dead) return;
  tab.status = status;
  renderTabstrip();
}

/**
 * Помечает вкладку мёртвой: сессии нет на сервере (удалена, подчищена
 * pruneEmpty, другая директория) — activate и history отвечают 404.
 * Лента заменяется честной карточкой с кнопкой закрытия; ретраи и очередь
 * больше её не трогают, сайдбар остаётся на последней живой сессии.
 * Идемпотентна (повторные 404 её же вкладки — no-op).
 */
export function markTabDead(id: string): void {
  const tab = tabState.tabs.find((x) => x.id === id);
  if (!tab || tab.dead) return;
  tab.dead = true;
  tab.status = "dead";
  tab.historyLoaded = true;
  tab.historyFailed = false;
  tab.planCard = null;
  setSessionLoading(false);
  tab.feed.replaceChildren();
  const card = el("div", "warnline", "✗ " + t("web.session.gone"));
  appendTo(tab.feed, card);
  const closer = link(t("web.topbar.close"), "", () => closeTab(id));
  appendTo(tab.feed, closer);
  if (tab.feed === activeFeed()) scrollToBottom();
  renderTabstrip();
}

function renderTabstrip(): void {
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
      dot.title = statusTitle(item.status);
      dot.setAttribute("aria-label", statusTitle(item.status));
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
      closeTab(item.id);
    });
    tab.appendChild(x);
    const open = () => openTab(item.id, item.name, item.kind, true);
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

// Mirror the active session into `?session=` so a page refresh restores it.
// Only the active tab is persisted; the token param is preserved as-is.
export function updateTabName(id: string, name: string): void {
  if (!id || !name) return;
  const tab = tabState.tabs.find((x) => x.id === id);
  if (tab && tab.name !== name) {
    tab.name = name;
    renderTabstrip();
  }
  // Patch the session list too, otherwise the dropdown keeps the stale name
  // until the next `sessions` event.
  const sess = session.sessions.find((s) => s.id === id);
  if (sess && sess.name !== name) {
    sess.name = name;
    renderSessionsDropdown();
  }
}

export function openTab(id: string, name?: string, kind?: string, server?: boolean): void {
  saveComposer();
  let tab = tabState.tabs.find((x) => x.id === id);
  if (!tab) {
    tab = {
      id,
      name: name || id,
      kind: kind || "session",
      feed: makeFeed(),
      historyLoaded: false,
      historyLoading: false,
      historyFailed: false,
      dead: false,
      planCard: null,
      draft: "",
      attachments: [],
      status: "idle",
    };
    tabState.tabs.push(tab);
  } else if (name) {
    tab.name = name;
  }
  tabState.activeTabId = id;
  tabState.liveTabId = id;
  // Сайдбар следует за вкладкой сразу: активная сессия — эта, Trace сбрасывается
  // синхронно (не ждём activate/полл). Новые (ещё не серверные) вкладки — мимо.
  if ((kind || "session") === "session") {
    session.activeSessionId = id;
    sidebarSessionChanged(id);
    // Render the tab's cached snapshot instantly (or fetch it once from REST).
    hooks.ensureTabState?.(id);
  }
  msgs.replaceChildren(tab.feed);
  restoreComposer(tab);
  renderTabstrip();
  renderSessionsDropdown();
  scrollToBottom();
  if (tab.kind === "session" && !server) {
    // Auto-opened live session: SSE fills the feed, no transcript fetch.
    tab.historyLoaded = true;
  }
  if (server && tab.kind === "session") {
    // Мёртвую вкладку (сессии нет на сервере) не дёргаем: карточка уже
    // показана, ретраи бесполезны.
    if (tab.dead) {
      syncUrl();
      return;
    }
    // A tab auto-opened as "live" (server=false) sets historyLoaded=true; when
    // it is opened from the server afterward we must actually fetch the
    // transcript, or a reload of the active session shows an empty feed.
    // historyFailed (транзиентная ошибка прошлого захода) — тоже повод
    // повторить; мёртвые (404) сюда не доходят — их держит tab.dead выше.
    if (!feedHasContent(tab.feed) || tab.historyFailed) tab.historyLoaded = false;
    // Индикатор загрузки секции Session до первого полного снапшота.
    setSessionLoading(true);
    // План следует за сессией: сервер переключает трекер на activate. 404 —
    // сессия исчезла: помечаем вкладку мёртвой вместо рассинхрона сайдбара.
    api("/api/sessions/activate", { method: "POST", body: { id } }).then((r) => {
      if (r.status === 404) {
        markTabDead(id);
        void loadSessions();
        return;
      }
      void loadSessions();
    });
    loadHistory(tab).then((st) => {
      if (st && st.gone) markTabDead(tab.id);
    });
  }
  syncUrl();
}

export function closeTab(id: string): void {
  const i = tabState.tabs.findIndex((x) => x.id === id);
  if (i === -1) return;
  const closingActive = tabState.activeTabId === id;
  if (closingActive) saveComposer();
  tabState.tabs = tabState.tabs.filter((x) => x.id !== id);
  if (closingActive) {
    const next = tabState.tabs[Math.min(i, tabState.tabs.length - 1)];
    if (next) {
      tabState.activeTabId = next.id;
      tabState.liveTabId = next.id;
      msgs.replaceChildren(next.feed);
      restoreComposer(next);
      // Сервер и сайдбар следуют за новой активной вкладкой. Раньше переключение
      // при закрытии не доезжало: висел план/контекст закрытой сессии.
      if (next.kind === "session") {
        session.activeSessionId = next.id;
        sidebarSessionChanged(next.id);
        hooks.ensureTabState?.(next.id);
        void api("/api/sessions/activate", { method: "POST", body: { id: next.id } });
      }
      scrollToBottom();
    } else {
      resetToEmpty();
    }
  }
  renderTabstrip();
  renderSessionsDropdown();
  syncUrl();
}

/**
 * Вкладок не осталось: сбрасываем клиентскую проекцию сессии и серверно-
 * активную. Иначе следующий ход и перезагрузка уходили в закрытую сессию, а
 * сайдбар висел на её контексте («контекст остаётся висеть»).
 */
function resetToEmpty(): void {
  tabState.activeTabId = null;
  tabState.liveTabId = null;
  session.activeSessionId = null;
  session.host = {};
  if (inp) inp.value = "";
  tabState.attachments = [];
  renderAttachments();
  hooks.renderActive?.();
  showEmptyFeed();
  void api("/api/sessions/deactivate", { method: "POST", body: {} });
}

async function newChatTab(): Promise<void> {
  const r = await api<{ session?: Dict }>("/api/sessions", { method: "POST", body: {} });
  if (r.ok && r.data && r.data.session && r.data.session.id) {
    const meta = r.data.session;
    openTab(meta.id, meta.name || String(meta.id), "session", false);
    await loadSessions();
    // Новая сессия — без плана: снапшот под ?session=<id> чистит сайдбар.
    setSessionLoading(true);
    return;
  }
  // Server-side creation failed (no manager / offline): keep a local-only tab
  // so the user is not blocked, but surface the failure.
  tabState.newSeq++;
  openTab("new" + tabState.newSeq, t("web.empty.title"), "new", false);
  setIndicator(t("web.sessions.create_failed"), true);
}

document.getElementById("newChat")?.addEventListener("click", () => void newChatTab());

/**
 * Сверяет бейджи вкладок с серверным per-session статусом (SSE `state`):
 * бегущая → working, в очереди → queued, прочие working/queued → idle.
 * `waiting` (висит question) и `failed` не трогаем — их снимают только
 * события хода (ответ/turn_end) или новый send.
 */
export function reconcileTabStatuses(): void {
  const running = session.runningSessionIds || [];
  const queued = session.queued || {};
  let changed = false;
  tabState.tabs.forEach((tab: Dict) => {
    if (tab.kind !== "session") return;
    if (tab.status === "waiting" || tab.status === "failed" || tab.status === "dead") return;
    const next = running.includes(tab.id) ? "working" : queued[tab.id] > 0 ? "queued" : "idle";
    if (tab.status !== next) {
      tab.status = next;
      changed = true;
    }
  });
  if (changed) renderTabstrip();
}

export async function loadSessions(): Promise<void> {
  const r = await api<{ sessions?: Dict[] }>("/api/sessions");
  if (!r.ok || !r.data) return;
  session.sessions = Array.isArray(r.data.sessions) ? r.data.sessions : [];
  renderSessionsDropdown();
}

document.addEventListener("click", () => {
  document.querySelectorAll("[data-sel]").forEach((s) => s.classList.remove("open"));
  setSessOpen(false);
  closeCmdk();
});

// Wire the sibling modules with the tab operations they call back into.
initComposer({
  activeTab,
  setTabStatus,
  newChatTab,
  markTabDead,
  openTab,
  closeTab,
  statusTitle,
});
initSessionsMenu({ openTab, closeTab, loadSessions, newChatTab });
