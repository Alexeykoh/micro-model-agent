/**
 * First-run setup wizard for `mma web` (browser).
 *
 * Entry point: loaded before `app.js` (ES module), exposes
 * `window.MmaSetup.maybeOpen()`. `maybeOpen()` returns a Promise<boolean> that
 * resolves `true` when the server reports `setupRequired` and the wizard has
 * taken over the screen (it hides the chat chrome via `body.setup-active` and
 * reloads the page on success). On any other case it resolves `false` and
 * `app.js` boots the chat as usual.
 *
 * Steps/forms live in sibling `setup-*.ts` modules; this file only owns the
 * shared state, the `/api/setup` handshake and the `window.MmaSetup` hook.
 * Style follows docs/design/ui/STYLE.md (rows, glyphs, no boxed panels).
 */
import { api, loadI18n } from "./setup-api.js";
import type { SetupContext } from "./setup-context.js";
import { clearDraft, loadDraft, saveDraft } from "./setup-draft.js";
import { I18N, applyDicts } from "./setup-i18n.js";
import { render } from "./setup-render.js";
import { createSetupState, type Dict } from "./setup-state.js";
import { applyThemePreview } from "./setup-steps-appearance.js";

const gate = document.getElementById("setupGate") as HTMLElement | null;
const state = createSetupState();
let opened = false;

async function maybeOpen(): Promise<boolean> {
  if (!gate || opened) return opened;
  const r = await api<Dict>("/api/setup");
  if (!r.ok || !r.data || !r.data.required) {
    clearDraft();
    return false;
  }

  state.display = r.data;
  hydrateDefaults(state, r.data);
  const first = (r.data.providers || [])[0];
  if (first) {
    state.answers.provider = first.type;
    if (first.baseUrl) state.answers.apiBase = first.baseUrl;
  }
  await loadI18n();
  state.answers.locale = I18N.locale || "en";

  const draft = loadDraft();
  if (draft) {
    Object.assign(state.answers, draft.answers);
    state.step = draft.step;
  }
  await restoreLocale(draft);
  applyThemePreview(state.answers.theme, state.answers.themeMode);

  const ctx: SetupContext = { state, gate, render: () => render(ctx) };
  document.body.classList.add("setup-active");
  gate.hidden = false;
  opened = true;
  gate.addEventListener("input", () => saveDraft(state));
  gate.addEventListener("change", () => saveDraft(state));
  render(ctx);
  return true;
}

/** Текущие значения конфига/дефолты сервера → стартовые ответы. */
function hydrateDefaults(s: typeof state, data: Dict): void {
  const current = data.current || {};
  const defaults = data.defaults || {};
  if (typeof current.criticEnabled === "boolean") {
    s.answers.criticEnabled = current.criticEnabled;
  }
  if (typeof current.webSearchEnabled === "boolean") {
    s.answers.webSearchEnabled = current.webSearchEnabled;
  }
  if (typeof current.contextAuto === "boolean") {
    s.answers.contextAuto = current.contextAuto;
  }
  if (defaults.contextAuto === false) s.answers.contextAuto = false;
  if (typeof current.contextWindow === "number") {
    s.answers.contextWindow = current.contextWindow;
  }
  if (defaults.contextWindow) s.answers.contextWindow = defaults.contextWindow;
  if (defaults.maxToolIterations) {
    s.answers.maxToolIterations = defaults.maxToolIterations;
  }
  if (defaults.security) {
    s.answers.securityDetail = Object.assign(s.answers.securityDetail, defaults.security);
  }
  const ui = current.ui || {};
  if (typeof ui.theme === "string") s.answers.theme = ui.theme;
  if (typeof ui.themeMode === "string") s.answers.themeMode = ui.themeMode;
  if (typeof ui.themeEffects === "boolean") s.answers.themeEffects = ui.themeEffects;
  if (ui.sounds) {
    s.answers.sounds = Object.assign(s.answers.sounds, ui.sounds);
  }
}

/** Черновик мог быть на другом языке: возвращаем локаль до первого рендера. */
async function restoreLocale(draft: ReturnType<typeof loadDraft>): Promise<void> {
  const locale = state.answers.locale;
  if (!draft || !locale || locale === I18N.locale) return;
  const langs = state.display?.languages || [];
  if (!langs.some((l: Dict) => l.value === locale)) return;
  const r = await api<{ dicts?: Record<string, Record<string, string>> }>("/api/setup/locale", {
    method: "POST",
    body: { locale },
  });
  if (r.ok && r.data && r.data.dicts) applyDicts(r.data.dicts, locale);
}

window.MmaSetup = { maybeOpen };
