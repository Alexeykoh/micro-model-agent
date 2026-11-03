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
import { I18N } from "./setup-i18n.js";
import { render } from "./setup-render.js";
import { createSetupState, type Dict } from "./setup-state.js";

const gate = document.getElementById("setupGate") as HTMLElement | null;
const state = createSetupState();
let opened = false;

async function maybeOpen(): Promise<boolean> {
  if (!gate || opened) return opened;
  const r = await api<Dict>("/api/setup");
  if (!r.ok || !r.data || !r.data.required) return false;

  state.display = r.data;
  if (r.data.defaults) {
    state.answers.contextWindow = r.data.defaults.contextWindow || state.answers.contextWindow;
    state.answers.maxToolIterations =
      r.data.defaults.maxToolIterations || state.answers.maxToolIterations;
    if (r.data.defaults.security) {
      state.answers.securityDetail = Object.assign(
        state.answers.securityDetail,
        r.data.defaults.security,
      );
    }
  }
  const first = (r.data.providers || [])[0];
  if (first) {
    state.answers.provider = first.type;
    if (first.baseUrl) state.answers.apiBase = first.baseUrl;
  }
  await loadI18n();
  state.answers.locale = I18N.locale || "en";

  const ctx: SetupContext = { state, gate, render: () => render(ctx) };
  document.body.classList.add("setup-active");
  gate.hidden = false;
  opened = true;
  render(ctx);
  return true;
}

window.MmaSetup = { maybeOpen };
