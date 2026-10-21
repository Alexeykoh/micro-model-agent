// Статусы вкладок: бейджи, подписи и решение о переходе статуса.
//
// Вынесено из `tabs.ts`: правило «как статус вкладки выводится из серверного
// состояния» — отдельно от отрисовки (и не тянет за собой цикл импортов).
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";

/** Бейдж статуса в табстрипе. */
export const TAB_DOT: Record<string, string> = {
  working: "●",
  waiting: "◉",
  queued: "○",
  failed: "✗",
  dead: "✗",
};

/** Сколько ждать подтверждения вопроса, прежде чем считать его зависшим. */
export const STALE_WAITING_MS = 60_000;

/** Подпись статуса (tooltip бейджа). */
export function statusTitle(status: unknown): string {
  if (status === "working") return t("web.tab.working");
  if (status === "waiting") return t("web.tab.waiting");
  if (status === "queued") return t("web.tab.queued");
  if (status === "failed") return t("web.tab.failed");
  if (status === "dead") return t("web.tab.gone");
  return "";
}

/**
 * Новый статус вкладки по серверному состоянию или `null` (не менять).
 *
 * `waiting` дольше `STALE_WAITING_MS` без подтверждения — зависший вопрос:
 * помечаем `failed` (аудит §6.16).
 */
export function nextTabStatus(
  tab: Dict,
  running: string[],
  queued: Record<string, number>,
  now: number,
): string | null {
  if (tab.status === "waiting") {
    const since = typeof tab.waitingSince === "number" ? tab.waitingSince : 0;
    if (since && now - since > STALE_WAITING_MS) return "failed";
    return null;
  }
  if (tab.status === "failed" || tab.status === "dead") return null;
  const next = running.includes(tab.id) ? "working" : queued[tab.id] > 0 ? "queued" : "idle";
  return next === tab.status ? null : next;
}
