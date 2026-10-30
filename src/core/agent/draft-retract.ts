// Структурированный отзыв черновика (A13): кто забраковал, почему и на какой
// итерации. Вынесено из гейтов (правило ≤300): все три вызывают `announceRetract`,
// поэтому метка `retract` не может снова стать безымянной.
import { t } from "../../i18n/index";
import type { CriticIssue, CriticVerdict } from "../../modules/critic/types";
import type { OnMeta, RetractInfo } from "../types";

/** Лента и Trace — одна строка (STYLE): длинный summary критика режем. */
const MAX_REASON_CHARS = 160;

/** Плоская короткая причина: без переводов строк, с честным маркером обрезки. */
export function clipRetractReason(text: string | undefined): string | undefined {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length <= MAX_REASON_CHARS ? flat : `${flat.slice(0, MAX_REASON_CHARS - 1)}…`;
}

/** Детали отзыва для критика: summary вердикта, иначе первое замечание. */
export function criticRetractInfo(
  verdict: CriticVerdict,
  issues: CriticIssue[],
  iteration: number,
): RetractInfo {
  const issue = issues[0];
  const reason =
    clipRetractReason(verdict.summary) ??
    clipRetractReason(issue ? issue.problem || issue.claim : undefined);
  return { source: "critic", reason, iteration, verdict: verdict.status };
}

/** Детали отзыва для проверки заявлений/халлюцинаций (claim или причина). */
export function claimRetractInfo(reason: string, kind: string, iteration: number): RetractInfo {
  return { source: "hallucination", reason: clipRetractReason(reason), iteration, verdict: kind };
}

/** Детали отзыва для финального аудита плана. */
export function auditRetractInfo(summary: string, iteration: number): RetractInfo {
  return { source: "audit", reason: clipRetractReason(summary), iteration, verdict: "audit" };
}

/** Единственная точка эмита `retract`: сырой текст метки + структура. */
export function announceRetract(
  onMeta: OnMeta | undefined,
  info: RetractInfo,
  slog?: { logRetract(info: RetractInfo): void },
): void {
  // Live-событие не переживает перезагрузку — пишем его в журнал сессии,
  // чтобы история показывала тот же блок, а не осиротевший черновик.
  // Тест-двойники логгера могут не иметь метода: отсутствие записи не должно
  // ронять сам отзыв.
  if (typeof slog?.logRetract === "function") slog.logRetract(info);
  onMeta?.(t("ui.draft_retracted"), "retract", info);
}
