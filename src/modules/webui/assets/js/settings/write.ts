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

interface ModelsPayload {
  models?: Dict[];
  reasoning?: Dict;
  capabilities?: Dict;
  loading?: boolean;
  error?: boolean;
}

/** Clamp for the loading poll: the server kicks `listModels()` in the background. */
const MODELS_POLL_MS = 400;
const MODELS_POLL_TRIES = 15;

export async function loadModels(): Promise<void> {
  const seq = ++modelsSeq;
  settings.modelsStatus = "loading";
  settings.modelsReady = false;
  writeHooks.renderSettings?.();
  for (let attempt = 0; attempt < MODELS_POLL_TRIES; attempt++) {
    const r = await api<ModelsPayload>("/api/models");
    if (seq !== modelsSeq) return;
    if (!r.ok || !r.data) {
      // Попытка была: иначе редактор экспертов будет ретраить список на каждый
      // рендер (офлайн-провайдер неотличим от «ещё не загружено»).
      settings.modelsReady = true;
      settings.modelsStatus = "error";
      writeHooks.renderSettings?.();
      return;
    }
    // Reasoning support rides along with the model list (one round-trip):
    // the 4th selector row renders from this, never from a separate GET.
    if (r.data.reasoning && typeof r.data.reasoning === "object")
      session.reasoning = r.data.reasoning;
    // Capabilities ride along too: the model chip renders from this, so a switch
    // never needs a second request.
    session.capabilities =
      r.data.capabilities && typeof r.data.capabilities === "object"
        ? (r.data.capabilities as { vision?: boolean; tools?: boolean })
        : null;
    // While the server is still collecting the list, keep the spinner instead
    // of showing an empty provider as "no models" (INV-P1 honesty).
    if (r.data.loading === true) {
      await new Promise((res) => setTimeout(res, MODELS_POLL_MS));
      if (seq !== modelsSeq) return;
      continue;
    }
    settings.models = Array.isArray(r.data.models) ? r.data.models : [];
    settings.modelsReady = true;
    settings.modelsStatus = r.data.error === true ? "error" : "ready";
    renderSelectors();
    writeHooks.renderSettings?.();
    return;
  }
  // Poll exhausted: the provider did not answer within the window. Don't leave
  // a permanent "loading" (the old bug: a panel opened earlier never retried) —
  // say the fetch failed; the next `models` event or the retry button recovers.
  settings.modelsStatus = "error";
  renderSelectors();
  writeHooks.renderSettings?.();
}

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
