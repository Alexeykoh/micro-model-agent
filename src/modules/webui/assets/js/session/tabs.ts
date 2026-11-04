// Tabs hub: tab model, openTab/closeTab, session loaders. The strip DOM lives
// in `tabs-strip.ts` and open-tab persistence in `tabs-persist.ts` (file-size
// rule 6); both are leaves, wired back through `initTabstrip`.
// Owns session-state hydration (loaders render their own chrome). The session
// dropdown, composer and slash-autocomplete are siblings under `./session/`;
// they receive the tab operations they need via their `init*` functions, so
// this hub is the only importer and the frontend DAG stays acyclic.
import { inp, el, link } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { tabs as tabState, session, hooks } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { makeFeed, showEmptyFeed, activeFeed, appendTo, feedHasContent, syncUrl, scrollToBottom, clearBusy, mountFeed } from "../feed.js";
import { setIndicator } from "../dialog.js";
import { sidebarSessionChanged, setSessionLoading } from "../sidebar.js";
import { setSessOpen } from "../core/menus.js";
import { notifyTabStatus } from "../sounds.js";
import { closeCmdk } from "./cmdk.js";
import { saveComposer, restoreComposer, renderAttachments, initComposer } from "./composer.js";
import { renderSessionsDropdown, initSessionsMenu } from "./sessions-menu.js";
import { persistTabs } from "./tabs-persist.js";
import { renderTabstrip, initTabstrip } from "./tabs-strip.js";
import { activateServerSession, nextSwitchSeq } from "./tab-switch.js";

export { reflectBusy } from "./composer.js";
export { loadCommands } from "./cmdk.js";
export { renderSessionsDropdown } from "./sessions-menu.js";
export { readSavedTabs } from "./tabs-persist.js";
export type { SavedTabs } from "./tabs-persist.js";
export { reconcileTabStatuses } from "./tabs-strip.js";

// Статусы вкладок: working — идёт ход, waiting — ждёт ответа (question),
// queued — стоит в очереди, failed — ход упал, dead — сессии нет.
import { statusTitle as statusTitleOf } from "./tab-status.js";

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
  const prev = tab.status;
  tab.status = status;
  // Метка «с какого момента ждём»: по ней зависший вопрос помечается failed.
  if (status === "waiting") tab.waitingSince = Date.now();
  else tab.waitingSince = 0;
  renderTabstrip();
  // Единственная точка звукового сигнала для переходов из SSE (INV-S1/S2).
  notifyTabStatus(prev, status);
}

/**
 * Помечает вкладку мёртвой: сессии нет на сервере (удалена, подчищена
 * pruneEmpty, другая директория) — activate и history отвечают 404.
 * Лента заменяется честной карточкой с кнопкой закрытия; идемпотентна.
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

export function openTab(id: string, name?: string, kind?: string, server?: boolean, activate = true): void {
  if (activate) saveComposer();
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
  // Background restore (F5 with several tabs): create the tab but leave the
  // active one untouched — the remembered active tab is opened separately.
  if (!activate) {
    renderTabstrip();
    renderSessionsDropdown();
    persistTabs();
    return;
  }
  const seq = nextSwitchSeq();
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
  mountFeed(tab.feed);
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
      persistTabs();
      return;
    }
    // A tab auto-opened as "live" (server=false) sets historyLoaded=true; when
    // it is opened from the server afterward we must actually fetch the
    // transcript, or a reload of the active session shows an empty feed.
    // historyFailed (транзиентная ошибка прошлого захода) — тоже повод
    // повторить; мёртвые (404) сюда не доходят — их держит tab.dead выше.
    if (!feedHasContent(tab.feed) || tab.historyFailed) tab.historyLoaded = false;
    // Индикатор — только пока снапшота нет (INV-W8): данные уже на руках,
    // блокировать ввод и рисовать скелетон нечего. Снимает его первый полный
    // снапшот (`renderActiveState`) либо догрузка истории ниже.
    if (!tab.state) setSessionLoading(true);
    // План следует за сессией: сервер переключает трекер на activate. 404 —
    // сессия исчезла: помечаем вкладку мёртвой вместо рассинхрона сайдбара.
    activateServerSession(tab, seq, {
      loadSessions,
      markTabDead,
      afterHistory: (id) => hooks.afterHistory?.(id),
    });
  }
  syncUrl();
  persistTabs();
}

export function closeTab(id: string): void {
  const i = tabState.tabs.findIndex((x) => x.id === id);
  if (i === -1) return;
  const closing = tabState.tabs[i];
  const closingActive = tabState.activeTabId === id;
  if (closingActive) saveComposer();
  // Таймеры закрываемой вкладки гасим явно: иначе «раздумка» продолжает
  // тикать в закрытом feed (аудит §6.14).
  if (closing.feed) clearBusy(closing.feed as HTMLElement);
  // Вкладка уходит, а ход/вопрос — нет: прерываем ход ДО деактивации (§6.8).
  if (closing.kind === "session" && (closing.status === "working" || closing.status === "waiting")) {
    void api("/api/interrupt", { method: "POST", body: { sessionId: closing.id } });
  }
  tabState.tabs = tabState.tabs.filter((x) => x.id !== id);
  if (closingActive) {
    // Переключение: activate ответившей вкладки уже неактуален.
    nextSwitchSeq();
    const next = tabState.tabs[Math.min(i, tabState.tabs.length - 1)];
    if (next) {
      tabState.activeTabId = next.id;
      tabState.liveTabId = next.id;
      mountFeed(next.feed);
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
  persistTabs();
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
  persistTabs();
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

// The strip renders the model we own; it gets the tab operations it calls back
// into (no import back into this hub). Wired first, before any consumer that
// might redraw the strip.
initTabstrip({ openTab, closeTab });
// Wire the sibling modules with the tab operations they call back into.
initComposer({
  activeTab,
  setTabStatus,
  newChatTab,
  markTabDead,
  openTab,
  closeTab,
  statusTitle: statusTitleOf,
});
initSessionsMenu({ openTab, closeTab, loadSessions, newChatTab });
