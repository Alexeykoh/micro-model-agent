// Загрузка списка моделей активного провайдера + сопутствующих возможностей
// (`GET /api/models`). Вынесено из `settings/write.ts` (правило 6): там остался
// только write-funnel свитчей конфига.
import { api } from "../api.js";
import { settings, session } from "../store.js";
import type { Dict } from "../core/store/types.js";

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

/** Repaint entry points owned by `write.ts`; injected to keep the DAG acyclic. */
interface ModelsLoadHooks {
  renderSelectors: () => void;
  renderSettings: () => void;
}

let hooks: ModelsLoadHooks = { renderSelectors: () => {}, renderSettings: () => {} };

export function setModelsLoadHooks(next: Partial<ModelsLoadHooks>): void {
  hooks = { ...hooks, ...next };
}

/**
 * Loads the list when the settings panel is opened before the first request
 * (boot/SSE missed). `loading` is left to the running poll, `error` to the
 * explicit retry button — auto-retrying those would hammer a dead provider.
 */
export function ensureModelsLoaded(): void {
  if (settings.modelsStatus !== "idle") return;
  void loadModels();
}

let modelsInflight: Promise<void> | null = null;

export function loadModels(): Promise<void> {
  // Single-flight: `renderSettings()` (which re-renders the experts table)
  // calls back into `loadModelsFor('')` → `loadModels()`. Without this guard
  // the re-entrant call recursed synchronously (stack overflow) and flooded
  // `/api/models` with hundreds of GETs while a switch was in flight.
  if (modelsInflight) return modelsInflight;
  // Defer the body: assigning `modelsInflight` must happen *before* the first
  // synchronous `renderSettings()` runs, otherwise the re-entrant call sees
  // `null` and starts a nested load (the recursion this guard exists to stop).
  modelsInflight = Promise.resolve()
    .then(() => doLoadModels())
    .finally(() => {
      modelsInflight = null;
    });
  return modelsInflight;
}

async function doLoadModels(): Promise<void> {
  const seq = ++modelsSeq;
  settings.modelsStatus = "loading";
  settings.modelsReady = false;
  hooks.renderSettings();
  for (let attempt = 0; attempt < MODELS_POLL_TRIES; attempt++) {
    const r = await api<ModelsPayload>("/api/models");
    if (seq !== modelsSeq) return;
    if (!r.ok || !r.data) {
      // Попытка была: иначе редактор экспертов будет ретраить список на каждый
      // рендер (офлайн-провайдер неотличим от «ещё не загружено»).
      settings.modelsReady = true;
      settings.modelsStatus = "error";
      hooks.renderSettings();
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
        ? (r.data.capabilities as {
            vision?: boolean;
            video?: boolean;
            audio?: boolean;
            pdf?: boolean;
            tools?: boolean;
          })
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
    hooks.renderSelectors();
    hooks.renderSettings();
    return;
  }
  // Poll exhausted: the provider did not answer within the window. Don't leave
  // a permanent "loading" (the old bug: a panel opened earlier never retried) —
  // say the fetch failed; the next `models` event or the retry button recovers.
  settings.modelsStatus = "error";
  hooks.renderSelectors();
  hooks.renderSettings();
}
