// Open-tab persistence: the set of session tabs survives a page reload (F5
// no longer dropped the others). Extracted from `session/tabs.ts` (file-size
// rule 6). Storage is best-effort — private mode may disable it — so nothing
// here gates boot.
import { tabs as tabState } from "../store.js";
import type { Dict } from "../core/store/types.js";

const OPEN_TABS_KEY = "mma-open-tabs";

/** Сохранённый набор вкладок для восстановления после перезагрузки. */
export interface SavedTabs {
  ids: string[];
  active: string | null;
}

export function persistTabs(): void {
  try {
    const ids = tabState.tabs
      .filter((x: Dict) => x.kind === "session" && !x.dead)
      .map((x: Dict) => String(x.id));
    const active = tabState.tabs.find((x: Dict) => x.id === tabState.activeTabId);
    const payload: SavedTabs = {
      ids,
      active: active && active.kind === "session" && !active.dead ? String(active.id) : null,
    };
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(payload));
  } catch {
    /* storage disabled (private mode) — persistence is best-effort */
  }
}

/** Читает сохранённый набор вкладок (пустой при отсутствии/поломке). */
export function readSavedTabs(): SavedTabs {
  try {
    const raw = localStorage.getItem(OPEN_TABS_KEY);
    if (!raw) return { ids: [], active: null };
    const parsed = JSON.parse(raw) as Partial<SavedTabs>;
    const ids = Array.isArray(parsed.ids)
      ? parsed.ids.filter((x): x is string => typeof x === "string")
      : [];
    const active = typeof parsed.active === "string" ? parsed.active : null;
    return { ids, active };
  } catch {
    return { ids: [], active: null };
  }
}
