// INV-W8 (спека 2026-11-04-webui-latency-design, A1/A2): активация серверной
// сессии и догрузка её истории. Вынесено из `session/tabs.ts` (правило 6):
// хаб вкладок не растёт, а guard по номеру переключения живёт рядом с тем,
// кто его выставляет.
//
// Смысл guard'а: быстрое A→B→A оставляет три конкурирующих запроса, и ответ
// activate(A) может прийти последним — тогда сервер считал бы активной уже
// закрытую вкладку. Глобальные эффекты применяются только при актуальном номере.
import { api } from "../api.js";
import type { Dict } from "../core/store/types.js";
import { loadHistory } from "../feed.js";
import { setSessionLoading } from "../sidebar.js";

let switchSeq = 0;

/** Отметить переключение вкладки; возвращает его номер для guard'ов. */
export function nextSwitchSeq(): number {
  return ++switchSeq;
}

/** true — номер ещё актуален (пользователь не переключился дальше). */
export function isCurrentSwitch(seq: number): boolean {
  return switchSeq === seq;
}

/** Зависимости, которые передаёт хаб вкладок (иначе цикл импортов). */
export interface ActivateDeps {
  loadSessions: () => Promise<void>;
  markTabDead: (id: string) => void;
  /** История догружена: строки субагентов + MMART (пер-табовый колбэк). */
  afterHistory: (id: string) => void;
}

/** Активировать сессию на сервере и догрузить её историю. */
export function activateServerSession(tab: Dict, seq: number, deps: ActivateDeps): void {
  const id = String(tab.id);
  api("/api/sessions/activate", { method: "POST", body: { id } }).then((r) => {
    // Устарело: активной уже другая вкладка — её activate ушёл позже.
    if (!isCurrentSwitch(seq)) return;
    if (r.status === 404) {
      deps.markTabDead(id);
      void deps.loadSessions();
      return;
    }
    void deps.loadSessions();
  });
  loadHistory(tab).then((st) => {
    if (st && st.gone) deps.markTabDead(id);
    deps.afterHistory(id); // история → строки субагентов + MMART
    // Данные ленты на руках — снимаем блокировку ввода (INV-W8). Снимет её
    // и первый полный снапшот в `renderActiveState`, если он пришёл раньше.
    if (isCurrentSwitch(seq)) setSessionLoading(false);
  });
}
