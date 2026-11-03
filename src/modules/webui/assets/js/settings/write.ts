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
import { syncThemeFromConfig } from "./theme.js";

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
const SELECTOR_KEYS = ["provider.active", "model", "contextWindow", "contextAuto", "reasoning.mode"];

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

export async function postConfig(key: string, value: unknown, refreshSettings?: boolean): Promise<boolean> {
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
      const err = (r.data && (r.data.error || r.data.reason)) || r.status || t("web.settings.save_failed");
      setIndicator(saveErrorText(err, key), true);
      return false;
    }
    const persisted = r.data.persisted !== false;
    // auto включён, но провайдер промолчал — говорим об этом явно, а не
    // рисуем «saved» рядом с числом, которое так и не изменилось.
    if (key === "contextAuto" && r.data.probed === false) {
      setIndicator(t("web.selectors.auto_failed"), true);
    } else {
      setIndicator(persisted ? t("web.settings.saved") : (r.data.warning || "not persisted"), !persisted);
    }
    if (settings.config && r.data.value !== undefined) setPath(settings.config, key, r.data.value);
    // Итог пробы едет в ответе — подложим в локальную копию сразу, не дожидаясь
    // GET (сбой реконфига не должен оставить меню с устаревшим окном).
    if (key === "contextAuto" && settings.config && typeof r.data.contextWindow === "number") {
      setPath(settings.config, "contextWindow", r.data.contextWindow);
    }
    if (key === "ui.activityRail") setLayout(String(r.data.value));
    if (key === "ui.fontSize") applyFontSize(String(r.data.value));
    if (key === "locale") {
      await loadI18n();
      if (hooks.applyStaticI18n) hooks.applyStaticI18n();
      writeHooks.renderSettings?.();
    }
    // A provider switch restores the per-provider model; a model change
    // updates that provider's remembered model. Both are independent GETs,
    // so re-read them in parallel. Context/reasoning switches only need the
    // config back (no extra model round-trip).
    if (key === "provider.active" || key === "model") {
      await Promise.all([loadConfig(), loadModels()]);
    } else if (isSelector) {
      await loadConfig();
    }
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
  // Тема — серверная настройка: конфиг важнее кэша и локального выбора.
  syncThemeFromConfig();
  applyFontSize();
  renderSelectors();
  writeHooks.renderSettings?.();
}

export async function loadModels(): Promise<void> {
  const r = await api<{ models?: Dict[]; reasoning?: Dict }>("/api/models");
  if (!r.ok || !r.data) {
    // Попытка была: иначе редактор экспертов будет ретраить список на каждый
    // рендер (офлайн-провайдер неотличим от «ещё не загружено»).
    settings.modelsReady = true;
    return;
  }
  settings.models = Array.isArray(r.data.models) ? r.data.models : [];
  settings.modelsReady = true;
  // Reasoning support rides along with the model list (one round-trip):
  // the 4th selector row renders from this, never from a separate GET.
  if (r.data.reasoning && typeof r.data.reasoning === "object") session.reasoning = r.data.reasoning;
  renderSelectors();
}

// Web chat font size (`ui.fontSize`). Like the theme (`ui.theme`, see
// `theme.ts`), it is a server config key. Applied as `body[data-font]` so the
// switch is instant and survives re-renders; unknown values fall back to the
// default.
export function applyFontSize(value?: string): void {
  const v = value || (settings.config && settings.config.ui && settings.config.ui.fontSize) || "comfortable";
  const known = v === "compact" || v === "large" ? v : "comfortable";
  if (known === "comfortable") document.body.removeAttribute("data-font");
  else document.body.setAttribute("data-font", known);
}
