// App shell composition root: boots the chat, wires the SSE stream to every
// surface, and hooks the tab hub back into the state projection. The projection
// itself lives in `app-state.ts` and the static-chrome localization in
// `app-i18n.ts` (both split out under file-size rule 6).
import { token } from "./js/api.js";
import { hasCachedI18n, loadI18n, t } from "./js/i18n.js";
import { settings, session, hooks } from "./js/store.js";
import { mergeUsage } from "./js/state-sync.js";
import {
  onText,
  onReasoning,
  onMeta,
  onPhase,
  onToolStart,
  onToolEnd,
  onTurnEnd,
  onErrorEvent,
  onCommandOutput,
  onLog,
  onPlan,
  onQuestion,
  onRetract,
  onCritic,
  showEmptyFeed,
  renderUsage,
} from "./js/feed.js";
import {
  renderSessionsDropdown,
  loadCommands,
  loadSessions,
  setTabStatus,
} from "./js/session/tabs.js";
import { restoreTabs } from "./js/session/restore-tabs.js";
import {
  renderSelectors,
  renderSettings,
  loadConfig,
  loadModels,
  loadProviders,
  loadMemory,
  loadSkills,
  loadPlugins,
  applyTheme,
  currentTheme,
  applyUiTheme,
  currentUiTheme,
  applyFontSize,
  setConnStatus,
  migrateThemeCache,
  postConfig,
} from "./js/settings.js";
import { initRail, setPlan as railPlan, railEvent } from "./js/rail.js";
import {
  initSidebar,
  initSidebarDrawer,
  initFiles,
  applySidebarI18n,
  openFilesTabFor,
  sidebarSessionId,
  sidebarTurnEnd,
  sidebarBusy,
  sidebarPullLog,
  sidebarSubagentEvent,
  sidebarTraceEvent,
  sidebarLspEvent,
  sidebarFilesChanged,
  sidebarPluginsEvent,
  sidebarMcpEvent,
  sidebarSecurityEvent,
} from "./js/sidebar.js";
import { insertIntoDraft, submitPrompt } from "./js/session/composer.js";
import { openMainPreview } from "./js/main-preview.js";
import { initShortcuts } from "./js/shortcuts.js";
import { drainQueuedTurn } from "./js/session/queue.js";
import { initCursor, loaderStateFor, setFaceState } from "./js/loader.js";
import {
  composerFaceElement,
  composerFaceEvent,
  composerFaceToken,
  initComposerFace,
  settleComposerFaceIdle,
} from "./js/composer-face.js";
import { initCollapsibleSections } from "./js/collapse.js";
import type { FaceState } from "./js/loader.js";
import { applyUpdateEvent } from "./js/update-ui.js";
import { connectSSE as wireSse } from "./js/sse.js";
import { initSubagentView, onSubagentEvent } from "./js/feed/subagent.js";
import {
  applyState,
  ensureTabState,
  refresh,
  renderActiveState,
  resyncAfterReconnect,
} from "./app-state.js";
import { applyStaticI18n } from "./app-i18n.js";

declare global {
  interface Window {
    MmaSetup?: { maybeOpen: () => Promise<boolean> };
  }
}

// App-shell hooks for the update chrome (`js/update-ui.ts`): MMART reaction,
// settle-back-to-idle, and a post-install chrome refresh.
const updateHooks = {
  face: (state: FaceState) => composerFaceEvent(state),
  settleIdle: () => settleComposerFaceIdle(),
  refreshChrome: () => {
    renderSettings();
    if (document.querySelector("#msgs > .empty")) showEmptyFeed();
  },
};

initCollapsibleSections();

// Lets `tabs.js` render a switched-to tab (cached snapshot or one REST fetch)
// without importing app.
hooks.ensureTabState = ensureTabState;
// Lets `tabs.js` reset the sidebar chrome when the last tab closes.
hooks.renderActive = renderActiveState;
hooks.openFileInTree = (p) => {
  openMainPreview(p);
};
hooks.openFileAtLine = (p, line) => {
  void line; // line-highlight lands with the sidebar reveal, not the main pane
  openMainPreview(p);
};
hooks.showFilesTab = () => {
  void openFilesTabFor("");
};
hooks.askAgent = (text) => submitPrompt(text);

// One live EventSource for the whole browser window (`js/sse.ts` owns the
// stream; app.ts is the composition root that injects every surface).
function connectSSE(): void {
  wireSse({
    token,
    setConnStatus,
    resyncAfterReconnect,
    onText,
    onMeta,
    onReasoning,
    onPhase,
    onToolStart,
    onToolEnd,
    onPlan,
    onQuestion,
    onTurnEnd,
    onLog,
    onRetract,
    onCritic,
    onErrorEvent,
    onCommandOutput,
    onSubagentEvent,
    drainQueuedTurn,
    sidebarSessionId,
    sidebarTurnEnd,
    sidebarBusy,
    sidebarPullLog,
    sidebarSubagentEvent,
    sidebarTraceEvent,
    sidebarLspEvent,
    sidebarFilesChanged,
    sidebarPluginsEvent,
    sidebarMcpEvent,
    sidebarSecurityEvent,
    railPlan,
    railEvent,
    faceEvent: composerFaceEvent,
    loaderStateFor,
    composerFace: composerFaceElement(),
    getComposerToken: composerFaceToken,
    setFaceState,
    applyUpdateEvent,
    updateHooks,
    setTabStatus,
    loadConfig,
    applyState,
    session,
    renderSessionsDropdown,
    mergeUsage,
    renderUsage,
  });
}

/**
 * A3 (INV-W9): стадия и заполнение на сплэше. Подпись была одной строкой
 * «connecting…», а полоса стояла на 40 % — при медленном сервере страница
 * выглядела зависшей, и непонятно, грузится она или встала.
 *
 * Маска остаётся маской (B-31: гаснет через 2 с тишины), но каждая стадия
 * продлевает кап: пока boot реально идёт, виден прогресс; при зависании
 * между стадиями маска исчезает ровно через 2 с, как и раньше.
 */
let splashHideTimer = 0;

function refreshSplashCap(): void {
  window.clearTimeout(splashHideTimer);
  splashHideTimer = window.setTimeout(hideBootSplash, 2000);
}

function bootStage(key: string, pct: number): void {
  const cap = document.getElementById("bootCap");
  if (cap) {
    cap.dataset.stage = key;
    cap.textContent = t(key);
  }
  document
    .querySelector<HTMLElement>("#bootSplash .bs-prog i")
    ?.style.setProperty("--p", `${pct}%`);
  refreshSplashCap();
}

async function boot(): Promise<void> {
  initCursor();
  // Splash is a mask, not a gate: cap it at 2 s. Arm the cap *before* the
  // setup probe, otherwise a slow /api/setup pins the splash forever.
  splashHideTimer = window.setTimeout(hideBootSplash, 2000);
  // Read the requested session before `showEmptyFeed()` → `syncUrl()` can strip it.
  const initialSession = new URLSearchParams(location.search).get("session");
  // First-run wizard owns the screen when the server reports a virgin config;
  // it reloads the page once setup completes, so skip the chat boot entirely.
  if (window.MmaSetup) {
    try {
      if (await window.MmaSetup.maybeOpen()) {
        hideBootSplash();
        return;
      }
    } catch {
      /* wizard failure must never brick the chat boot */
    }
  }
  try {
    // Paint theme + language from the local mirror before any network round-trip:
    // otherwise the splash shows EN/dark and only then switches to the saved
    // RU/light — a visible flash on every reload.
    applyTheme(currentTheme());
    applyUiTheme(currentUiTheme());
    applyFontSize();
    if (hasCachedI18n()) applyStaticI18n();
    showEmptyFeed();
    renderSelectors();
    renderSettings();
    await loadI18n();
    await loadCommands();
    // Server truth wins; with a warm cache this repaint changes nothing.
    applyStaticI18n();
    bootStage("web.loader.step.config", 25);
    await loadConfig();
    // Апгрейд: до этой версии тема жила только в localStorage. Если сервер ещё
    // на дефолте, доливаем выбор браузера в конфиг (INV-T5) и перерисовываем
    // панель, чтобы подсветка совпала с применённым значением.
    if (await migrateThemeCache((key, value) => postConfig(key, value, false))) renderSettings();
    initRail(settings.config && settings.config.ui ? settings.config.ui.activityRail : undefined);
    initComposerFace();
    initSidebar();
    initSidebarDrawer();
    initShortcuts();
    initSubagentView();
    applySidebarI18n();
    initFiles({ insertPath: (p) => insertIntoDraft("@" + p + " ") });
    bootStage("web.loader.step.models", 45);
    await loadModels();
    bootStage("web.loader.step.providers", 60);
    await loadProviders();
    bootStage("web.loader.step.sessions", 75);
    await loadSessions();
    bootStage("web.loader.step.plugins", 85);
    await loadMemory();
    await loadSkills();
    await loadPlugins();
    bootStage("web.loader.step.workspace", 93);
    // Reopen remembered tabs first; `refresh()` auto-opens the server-active
    // session only when no tab is active yet, so a restored set is not clobbered.
    restoreTabs(initialSession);
    try {
      await refresh();
    } catch (err) {
      // A render bug must never kill boot before the SSE stream connects:
      // without SSE no streamed answers, tools or loaders reach the page.
      console.error("initial refresh failed", err);
    }
  } catch (err) {
    // A failed boot must still open the SSE stream: otherwise the page stays
    // inert, and the splash/failsafe is the only thing the user sees.
    console.error("boot failed", err);
  } finally {
    hideBootSplash();
    connectSSE();
  }
}
// Fade the boot splash out and drop it from the layout. Idempotent.
function hideBootSplash(): void {
  const splash = document.getElementById("bootSplash");
  if (!splash || splash.hidden) return;
  splash.classList.add("hide");
  window.setTimeout(() => {
    splash.hidden = true;
  }, 500);
}
hooks.applyStaticI18n = applyStaticI18n;
void boot();
