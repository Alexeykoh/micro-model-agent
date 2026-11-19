// Фоновая автоочистка сессий (A-01): не блокирует create(), удаляет пачкой и
// не перебирает гигантский каталог. Вынесено из `manager.ts` (правило 6).
import { t } from "../../i18n/index";
import type { SessionMeta } from "./types";

/** Сколько сессий удаляем за один прогон автоочистки. */
export const AUTO_PRUNE_BATCH = 20;
/** Выше этого числа каталог не сканируем: массовая чистка — явный `session prune`. */
export const AUTO_PRUNE_MAX_SCAN = 1000;

/** Всё, что нужно автоочистке (менеджер отдаёт свои швы). */
export interface AutoPruneDeps {
  max: number;
  count: () => number;
  list: () => SessionMeta[];
  remove: (id: string) => void;
  isBusy: (id: string) => boolean;
  warn: (message: string) => void;
}

/** Один прогон: мягкий лимит, пачка старых сессий, ошибки — в лог. */
export function autoPruneSessions(deps: AutoPruneDeps): void {
  if (deps.max <= 0) return;
  const count = deps.count();
  if (count <= deps.max) return;
  if (count > AUTO_PRUNE_MAX_SCAN) {
    deps.warn(
      t("session.autoprune_skipped", {
        count: String(count),
        limit: String(AUTO_PRUNE_MAX_SCAN),
      }),
    );
    return;
  }
  const sessions = deps.list();
  if (sessions.length <= deps.max) return;
  // list() — от новых к старым; хвост после `max` — самые старые.
  const toDelete = sessions
    .slice(deps.max)
    .filter((s) => !deps.isBusy(s.id))
    .slice(0, AUTO_PRUNE_BATCH);
  for (const s of toDelete) {
    try {
      deps.remove(s.id);
    } catch (e) {
      deps.warn(
        t("session.autoprune_item_failed", {
          id: s.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }
}

/** Планирует один прогон в фоне; ошибка не всплывает unhandledRejection. */
export function scheduleAutoPrune(
  state: { scheduled: boolean },
  run: () => void,
  warn: (message: string) => void,
): void {
  if (state.scheduled) return;
  state.scheduled = true;
  const timer = setTimeout(() => {
    state.scheduled = false;
    try {
      run();
    } catch (e) {
      warn(t("session.autoprune_failed", { error: e instanceof Error ? e.message : String(e) }));
    }
  }, 0);
  (timer as { unref?: () => void }).unref?.();
}
