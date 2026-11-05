// Создание новой серверной сессии и её вкладки. Вынесено из `tabs.ts`
// (правило ≤300); `openTab`/`loadSessions` приходят снаружи — обратный импорт
// замкнул бы граф вкладок.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { setIndicator } from "../dialog.js";
import { tabs as tabState } from "../store.js";
import { setSessionLoading } from "../sidebar.js";
import type { Dict } from "../core/store/types.js";

/** Зависимости хаба вкладок, нужные для нового чата. */
export interface NewChatDeps {
  openTab: (id: string, name: string, kind: string, server: boolean) => void;
  loadSessions: () => Promise<void>;
}

/** `POST /api/sessions` → вкладка; локал-фолбэк при отказе сервера. */
export async function createNewChatTab(deps: NewChatDeps): Promise<void> {
  const r = await api<{ session?: Dict }>("/api/sessions", { method: "POST", body: {} });
  if (r.ok && r.data && r.data.session && r.data.session.id) {
    const meta = r.data.session;
    // Скелетон ставим ДО openTab: его `ensureTabState` догрузит снапшот и
    // снимет загрузку в `renderActiveState`. Пост-фактум вызов оставлял
    // composer в `switching` навсегда (курсор-прогресс, readOnly) — новый чат
    // выглядел зависшим.
    setSessionLoading(true);
    deps.openTab(meta.id, meta.name || String(meta.id), "session", false);
    await deps.loadSessions();
    return;
  }
  // Server-side creation failed (no manager / offline): keep a local-only tab
  // so the user is not blocked, but surface the failure.
  tabState.newSeq++;
  deps.openTab("new" + tabState.newSeq, t("web.empty.title"), "new", false);
  setIndicator(t("web.sessions.create_failed"), true);
}
