// Restore remembered session tabs on boot. Extracted from `app.ts` (file-size
// rule 6): the URL `?session=` deep link wins as the active tab, then the
// remembered active, then the first remembered — opened BEFORE `refresh()` so
// the server-active session is not also auto-opened as an extra tab.
import { openTab, readSavedTabs } from "./tabs.js";
import { session } from "../store.js";

export function restoreTabs(urlSession: string | null): void {
  const saved = readSavedTabs();
  const known = (id: string) => session.sessions.some((s) => s.id === id);
  const nameOf = (id: string) => {
    const m = session.sessions.find((s) => s.id === id);
    return m && m.name ? String(m.name) : id;
  };
  const preferred =
    (urlSession && known(urlSession) ? urlSession
      : saved.active && known(saved.active) ? saved.active
        : saved.ids.find(known)) || null;
  const ids: string[] = [];
  if (urlSession && known(urlSession)) ids.push(urlSession);
  if (preferred && !ids.includes(preferred)) ids.push(preferred);
  for (const id of saved.ids) {
    if (known(id) && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return;
  openTab(ids[0], nameOf(ids[0]), "session", true);
  for (const id of ids.slice(1)) openTab(id, nameOf(id), "session", false, false);
}
