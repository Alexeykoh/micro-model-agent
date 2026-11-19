// Settings write funnel + config/model loaders. `postConfig` is the single
// write path used by the panels and the provider form; the settings shell
// (modal) registers the render callbacks via `setWriteHooks`, so this module
// never imports upward. The composer selector chips/menus were split out into
// `selectors-write.ts` (rule 6); they register their renderer here instead of
// this funnel importing them, so the frontend graph stays acyclic.
import { api } from "../api.js";
import { t, loadI18n } from "../i18n.js";
import { settings, session, setPath, hooks } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { closeAllMenus } from "../core/menus.js";
import { setIndicator } from "../dialog.js";
import { saveErrorText } from "./save-error.js";
import { setLayout } from "../rail.js";
import { syncThemeFromConfig, loadOsTheme } from "./theme.js";
import { setSwitching } from "../session/switch-state.js";
import { loadModels, setModelsLoadHooks } from "./models-load.js";

// Re-export the loader from its new home so existing importers of `write.js`
// (SSE, selectors, panels) keep working unchanged.
export { loadModels, ensureModelsLoaded } from "./models-load.js";

// The composer selector chips/menus live in `selectors-write.ts`. It imports
// this funnel (and `paintSelectorPending`), so the edge back must be a
// registered callback, not an import — otherwise the graph would cycle.
let renderSelectorChips: (() => void) | null = null;

/** `selectors-write.ts` registers its render entry point on module load. */
export function setSelectorRenderer(fn: () => void): void {
  renderSelectorChips = fn;
}

function renderSelectors(): void {
  renderSelectorChips?.();
}

// `loadModels` живёт в `models-load.ts`; отрисовка остаётся здесь и передаётся
// хуками, чтобы не тянуть импорт обратно в загрузчик (цикл).
setModelsLoadHooks({
  renderSelectors,
  renderSettings: () => writeHooks.renderSettings?.(),
});

// Selector keys (`provider/model/context/contextAuto/reasoning`) share the switch treatment:
// pending paint + single-flight + parallel re-reads. Settings-panel writes
// bypass it (plain POST + save toast).
const SELECTOR_KEYS = [
  "provider.active",
  "model",
  "contextWindow",
  "contextAuto",
  "reasoning.mode",
];

// Monotonic id for selector switches: a slow A→B→A pair must not let the
// stale reply repaint over the fresh one.
let switchSeq = 0;
// Key of the in-flight selector switch, if any. While set, every selector
// button carries the pending mark and all selector menus are inert (CSS gates
// on `.selectors[data-pending]`), so a double-click is answered with a toast
// instead of a second concurrent switch.
let pendingKey: string | null = null;

interface WriteHooks {
  renderSettings: (() => void) | null;
  openSettingsAt: ((id: string) => void) | null;
}

// UI callbacks registered by the settings shell (`settings/modal.js`). Kept as
// a hook so this write funnel never imports the panels/shell (no cycle).
let writeHooks: WriteHooks = { renderSettings: null, openSettingsAt: null };

/** Settings shell injects its render entry points; keeps the module DAG acyclic. */
export function setWriteHooks(d: Partial<WriteHooks>): void {
  writeHooks = { ...writeHooks, ...d };
}

/** Deep-link into a settings panel (reasoning selector menu → settings shell). */
export function openSettingsPanel(id: string): void {
  writeHooks.openSettingsAt?.(id);
}

// Paint the pending mark (`⋯` via CSS `::after`, no label rewrites) and the
// `aria-busy` flag. Boot (`config === null`) paints the same mark, so the
// skeleton state is visible while `boot()` loads config/models/providers.
// Exported for `selectors-write.ts`, which paints after every re-render.
export function paintSelectorPending(): void {
  const show = pendingKey !== null || !settings.config;
  const wrap = document.querySelector(".selectors");
  if (wrap) {
    if (show) wrap.setAttribute("data-pending", pendingKey || "boot");
    else wrap.removeAttribute("data-pending");
  }
  ["selProviderBtn", "selModelBtn", "selContextBtn", "selReasoningBtn"].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.toggle("pending", show);
    btn.setAttribute("aria-busy", show ? "true" : "false");
  });
}

export async function postConfig(
  key: string,
  value: unknown,
  refreshSettings?: boolean,
): Promise<boolean> {
  const isSelector = SELECTOR_KEYS.indexOf(key) !== -1;
  if (isSelector && pendingKey !== null) {
    setIndicator(t("web.selectors.switch_busy"), true);
    return false;
  }
  // Non-selector writes must not touch the sequence: otherwise a settings
  // write landing mid-switch would orphan `pendingKey` (stale-guard skips the
  // only `finally` that clears it).
  let seq = 0;
  if (isSelector) {
    seq = ++switchSeq;
    pendingKey = key;
    closeAllMenus();
    paintSelectorPending();
    // Возможности принадлежат сменяемой паре: старый чип нельзя показывать
    // новому бэкенду. Прячем его сразу, не дожидаясь асинхронной пробы.
    if (key === "model" || key === "provider.active") {
      session.capabilities = null;
      renderSelectors();
    }
    // Пока идёт свитч (пробы контекста/capabilities + пересборка провайдера),
    // ввод и отправка заблокированы: сообщение, ушедшее в старую пару, — это
    // ход не на той модели. Снимается в `finally` после применения конфига.
    setSwitching(true);
  }
  try {
    const r = await api<Dict>("/api/config", { method: "POST", body: { key, value } });
    if (!r.ok || !r.data || !r.data.ok) {
      const err =
        (r.data && (r.data.error || r.data.reason)) || r.status || t("web.settings.save_failed");
      setIndicator(saveErrorText(err, key), true);
      return false;
    }
    const persisted = r.data.persisted !== false;
    // auto включён, но провайдер промолчал — говорим об этом явно, а не
    // рисуем «saved» рядом с числом, которое так и не изменилось.
    if (key === "contextAuto" && r.data.probed === false) {
      setIndicator(t("web.selectors.auto_failed"), true);
    } else {
      setIndicator(
        persisted ? t("web.settings.saved") : r.data.warning || "not persisted",
        !persisted,
      );
    }
    if (settings.config && r.data.value !== undefined) setPath(settings.config, key, r.data.value);
    // Смена провайдера инвалидирует список моделей: старый список принадлежит
    // прошлому бэкенду и не должен мелькать под новым. Свежий придёт SSE
    // `models` после фонового refresh; до него честно показываем «грузится».
    if (key === "provider.active") {
      settings.models = [];
      settings.modelsByProvider = {};
      settings.modelsStatus = "loading";
      settings.modelsReady = false;
    }
    // Итог пробы едет в ответе — подложим в локальную копию сразу, не дожидаясь
    // GET (сбой реконфига не должен оставить меню с устаревшим окном). В auto
    // это бывает и на смене модели/провайдера, а не только на contextAuto.
    if (settings.config && typeof r.data.contextWindow === "number") {
      setPath(settings.config, "contextWindow", r.data.contextWindow);
    }
    // Capabilities новой пары: сервер отдаёт их прямо в ответе свитча.
    // Если ключа нет (старый сервер) — подстрахуемся обычным GET.
    const switchedIdentity = key === "model" || key === "provider.active";
    if (r.data.capabilities && typeof r.data.capabilities === "object") {
      session.capabilities = r.data.capabilities as {
        vision?: boolean;
        video?: boolean;
        audio?: boolean;
        pdf?: boolean;
        tools?: boolean;
      };
    } else if (switchedIdentity) {
      void loadModels();
    }
    if (key === "ui.activityRail") setLayout(String(r.data.value));
    if (key === "ui.fontSize") applyFontSize(String(r.data.value));
    if (key === "locale") {
      await loadI18n();
      if (hooks.applyStaticI18n) hooks.applyStaticI18n();
      writeHooks.renderSettings?.();
    }
    // A provider/model switch re-reads only the config: the refreshed model
    // list arrives with the server's `models` SSE event (INV-W5), so an
    // immediate `loadModels()` would race the background refresh and repaint
    // the stale list. Context/reasoning switches likewise only need config.
    if (isSelector) {
      await loadConfig();
    }
    // Список моделей нового провайдера: SSE `models` придёт после фонового
    // refresh, но не полагаемся только на него — поллинг `loading` в
    // `loadModels` дорисует панель, если событие потерялось.
    if (key === "provider.active") void loadModels();
    // Stale reply (a newer switch started while this one was in flight):
    // leave the paint and the final render to the newer operation.
    if (isSelector && seq !== switchSeq) return true;
    renderSelectors();
    if (refreshSettings) writeHooks.renderSettings?.();
    return true;
  } finally {
    if (isSelector && seq === switchSeq) {
      pendingKey = null;
      paintSelectorPending();
      setSwitching(false);
    }
  }
}

export async function loadConfig(): Promise<void> {
  const r = await api<{ config?: Dict; registry?: Dict[]; webToken?: string }>("/api/config");
  if (!r.ok || !r.data) return;
  settings.config = r.data.config || {};
  settings.registry = Array.isArray(r.data.registry) ? r.data.registry : [];
  settings.webToken = typeof r.data.webToken === "string" ? r.data.webToken : null;
  // The OS snapshot must land before syncThemeFromConfig: on Linux the
  // `omarchy` skin reads colours from the active OS theme; elsewhere it is absent.
  await loadOsTheme();
  // Тема — серверная настройка: конфиг важнее кэша и локального выбора.
  syncThemeFromConfig();
  applyFontSize();
  renderSelectors();
  writeHooks.renderSettings?.();
}

/** Monotonic guard: a slow boot reply must not repaint over a newer switch. */
let modelsSeq = 0;

// Web chat font size (`ui.fontSize`). Like the theme (`ui.theme`, see
// `theme.ts`), it is a server config key. Applied as `body[data-font]` so the
// switch is instant and survives re-renders; unknown values fall back to the
// default.
export function applyFontSize(value?: string): void {
  const v =
    value ||
    (settings.config && settings.config.ui && settings.config.ui.fontSize) ||
    "comfortable";
  const known = v === "compact" || v === "large" ? v : "comfortable";
  if (known === "comfortable") document.body.removeAttribute("data-font");
  else document.body.setAttribute("data-font", known);
}
