// Names of configured providers, for `select` editors on provider-reference
// keys (e.g. `critic.provider`, `experts[*].provider`). Extracted from
// `panels.ts` (rule 6: file at its line ceiling).
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";

/**
 * Имена записей из `/api/providers`, с фолбэком на `provider.entries` живого
 * конфига (легаси-стабы без view).
 */
export function providerNameOptions(): string[] {
  const view: Dict = settings.providers || {};
  const cfgProvider: Dict = (settings.config && settings.config.provider) || {};
  const entries: Dict[] =
    Array.isArray(view.entries) && view.entries.length
      ? view.entries
      : Array.isArray(cfgProvider.entries)
        ? cfgProvider.entries
        : [];
  const names = entries.map((e) => e.label || e.type).filter((n): n is string => !!n);
  const active = view.active || cfgProvider.active;
  if (active && names.indexOf(active) === -1) names.unshift(active);
  return names;
}
