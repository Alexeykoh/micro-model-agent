// Стартовое восстановление плана: per-session слот — единственный источник
// правды, глобальный `.mma/plans/active.json` остаётся legacy-зеркалом.
import type { ExecutionModule } from "../../modules/execution/module";

/** Сессия, активная на старте процесса. */
export interface StartupSession {
  id: string | null;
  /** История сессии на диске. 0 — автосозданная/пустая сессия. */
  messageCount: number;
}

/** Есть ли у сессии собственный слот плана (не роняя старт на битом id). */
function hasSessionSlot(
  execModule: Pick<ExecutionModule, "getStore">,
  sessionId: string,
): boolean {
  try {
    return execModule.getStore().loadSessionActive(sessionId) !== null;
  } catch {
    return false;
  }
}

/**
 * Поднимает план стартовой сессии.
 *
 * Активная сессия грузит СВОЙ слот через `switchSession`. Глобальный
 * `active.json` (legacy, до per-session слотов в 0.59) усыновляется только
 * возобновлённой сессией с историей и только если своего слота у неё нет.
 *
 * Свежая (автосозданная при старте) сессия не наследует чужой план: раньше
 * безусловный `restorePlan()` + усыновление в `switchSession` записывали
 * старый `active.json` в слот новой сессии — план «просачивался» в новый чат
 * и переживал перезапуск.
 */
export function restoreStartupPlan(
  execModule: Pick<ExecutionModule, "restorePlan" | "switchSession" | "getStore">,
  session: StartupSession,
): void {
  if (!session.id) {
    execModule.switchSession(null);
    return;
  }
  if (session.messageCount > 0 && !hasSessionSlot(execModule, session.id)) {
    execModule.restorePlan();
  }
  execModule.switchSession(session.id);
}

/** Источник активной сессии для старта (SessionManager в bootstrap). */
export interface ActiveSessionSource {
  getActive(): string | null;
  getActiveMeta(): { messageCount: number } | null;
}

/**
 * Fail-open обёртка над `restoreStartupPlan`: старт не должен падать из-за
 * битого слота/меты — тогда трекер просто остаётся пустым.
 */
export function restoreStartupPlanFrom(
  execModule: Pick<ExecutionModule, "restorePlan" | "switchSession" | "getStore">,
  sessions: ActiveSessionSource,
): void {
  try {
    const id = sessions.getActive();
    const messageCount = id ? (sessions.getActiveMeta()?.messageCount ?? 0) : 0;
    restoreStartupPlan(execModule, { id, messageCount });
  } catch {
    // fail-open: без сессии/слота трекер остаётся пустым
  }
}
