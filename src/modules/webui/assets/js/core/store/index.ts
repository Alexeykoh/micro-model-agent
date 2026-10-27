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
export { streamStateFor } from "./feed.js";
export type { FeedSlice, FeedStreamState } from "./feed.js";

export const THEME_KEY = "mma-theme";
export const MAX_IMAGES = 10;
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

// Cross-module UI hooks, registered by `app.js` boot. Lets settings-level
// writes refresh app-shell chrome (locale) without importing app - keeps the
// module DAG acyclic.
export interface StoreHooks {
  // biome-ignore lint/suspicious/noExplicitAny: hook signature owned by app.ts.
  applyStaticI18n: ((...args: any[]) => void) | null;
  /** Renders a session tab's cached snapshot (or fetches it once from REST). */
  ensureTabState?: ((id: string) => void) | null;
  /** Re-renders the active tab's projection (sidebar chrome + empty feed). */
  renderActive?: (() => void) | null;
  /**
   * Opens a workspace file in the sidebar Files tab (tree revealed to the file).
   * Registered by `app.js`; the feed calls it for chat file links without
   * importing the sidebar, keeping the module DAG acyclic.
   */
  openFileInTree?: ((path: string) => void) | null;
  /** Лента вкладки отрисована: связать исторические строки субагентов с прогонами. */
  afterHistory?: ((id: string) => void) | null;
  /** Перед заменой ленты в `#msgs` (закрывает вид субагента, если открыт). */
  beforeFeedMount?: (() => void) | null;
  /**
   * Открыть настройки сразу на нужной панели (и, если задан, прокрутить к
   * якорю внутри неё). Регистрирует `settings/modal.ts`; сайдбар зовёт через
   * хук, чтобы не тянуть настройки в свой граф.
   */
  openSettingsAt?: ((panel: string, anchor?: string) => void) | null;
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
