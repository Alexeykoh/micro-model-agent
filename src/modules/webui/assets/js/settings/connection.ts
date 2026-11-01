// Баннеры состояния (обрыв SSE, устаревшие переводы). Вынесено из `write.ts`
// (правило 6: файл на потолке строк); реэкспорт — через `settings.js`.
import { el, link, connStatus, staleBar } from "../dom.js";
import { t } from "../i18n.js";

// Connection-state banner: shown while the SSE stream is down. The server
// never replays events, so a reconnect only resyncs the state slices — the feed keeps
// whatever the live session already rendered (no duplication).
export function setConnStatus(disconnected: unknown): void {
  if (!connStatus) return;
  connStatus.hidden = !disconnected;
  connStatus.textContent = disconnected ? "⋯ " + t("web.conn.reconnecting") : "";
}

// Stale-translations banner: dict files on disk are newer than the running
// server process, so the chrome may show raw keys. Rebuilt only on a state
// change (not on every 2s poll) to keep the reload-button focus stable;
// `force` re-renders the label after a locale switch.
let lastStale: boolean | null = null;
export function setStaleBar(stale: unknown, force?: boolean): boolean | null {
  if (!staleBar) return null;
  // undefined = перерисовать последнее состояние (смена локали).
  const on = stale === undefined ? !!lastStale : !!stale;
  if (!force && on === lastStale) return lastStale;
  lastStale = on;
  staleBar.hidden = !on;
  staleBar.textContent = "";
  if (!on) return lastStale;
  staleBar.appendChild(el("span", "", "⚠ " + t("web.i18n.stale") + " "));
  staleBar.appendChild(link(t("web.i18n.reload"), "", () => location.reload()));
  return lastStale;
}
