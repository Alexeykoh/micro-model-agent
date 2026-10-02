// Sliced shared frontend state (was a single `S` object in `store.js`).
//
// ESM live bindings cannot be reassigned from importers, so every mutable field
// lives on a domain slice (`feed`/`tabs`/`settings`/`session`) and the modules
// read/write the slice they own. The legacy `S` god-object is kept temporarily
// as an accessor *view* over the slices (top-level fields + the `state` group)
// so not-yet-migrated consumers keep working unchanged; the slices are the
// single source of truth.
import { feed } from "./feed.js";
import { tabs } from "./tabs.js";
import { settings } from "./settings.js";
import { session } from "./session.js";

export { feed, tabs, settings, session };

export const THEME_KEY = "mma-theme";
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

// Cross-module UI hooks, registered by `app.js` boot. Lets settings-level
// writes refresh app-shell chrome (locale) without importing app — keeps the
// module DAG acyclic.
export const hooks = { applyStaticI18n: null };

export function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

export function getPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

// Define accessors on `target` for every own key of `source`, so reads/writes
// (including whole-value reassignment) alias the slice.
function defineAliases(target, source) {
  for (const key of Object.keys(source)) {
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get: () => source[key],
      set: (v) => {
        source[key] = v;
      },
    });
  }
  return target;
}

// Which slice owns each field historically exposed under `S.state`.
const STATE_SLICES = {
  // settings-owned
  config: settings,
  registry: settings,
  webToken: settings,
  models: settings,
  memory: settings,
  skills: settings,
  pluginsData: settings,
  providers: settings,
  providerPresets: settings,
  providerForm: settings,
  mcpForm: settings,
  lspForm: settings,
  lsp: settings,
  // session-owned
  sessions: session,
  host: session,
  busy: session,
  activeSessionId: session,
  runningSessionId: session,
  runningSessionIds: session,
  queued: session,
  sessionsError: session,
  reasoning: session,
};

const stateView = {};
for (const [key, slice] of Object.entries(STATE_SLICES)) {
  Object.defineProperty(stateView, key, {
    enumerable: true,
    configurable: true,
    get: () => slice[key],
    set: (v) => {
      slice[key] = v;
    },
  });
}

/** Compatibility view over the slices; new code should import slices directly. */
export const S = {};
defineAliases(S, tabs);
defineAliases(S, session);
defineAliases(S, settings);
defineAliases(S, feed);
Object.defineProperty(S, "state", {
  enumerable: true,
  configurable: true,
  get: () => stateView,
});