// Sliced shared frontend state (was a single `S` object in `store.js`).
//
// ESM live bindings cannot be reassigned from importers, so every mutable field
// lives on a domain slice (`feed`/`tabs`/`settings`/`session`) and each module
// reads/writes the slice it owns. The old `S` god-object (and its `state` group)
// is gone; `grep -n "\\bS\\."` in `assets/js` should be empty.
import { feed } from "./feed.js";
import { tabs } from "./tabs.js";
import { settings } from "./settings.js";
import { session } from "./session.js";
import type { Dict } from "./types.js";

export { feed, tabs, settings, session };

export const THEME_KEY = "mma-theme";
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

// Cross-module UI hooks, registered by `app.js` boot. Lets settings-level
// writes refresh app-shell chrome (locale) without importing app - keeps the
// module DAG acyclic.
export interface StoreHooks {
  // biome-ignore lint/suspicious/noExplicitAny: hook signature owned by app.ts.
  applyStaticI18n: ((...args: any[]) => void) | null;
}

export const hooks: StoreHooks = { applyStaticI18n: null };

export function setPath(obj: Dict, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Dict = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

export function getPath(obj: Dict, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Dict)[p];
  }
  return cur;
}
