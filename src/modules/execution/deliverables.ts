// Файловые деливераблы шага плана и модельно-видимые тексты плана.
// Вынесено из `module.ts` (правило 6); логика не менялась.
import { t } from "../../i18n/index";
import { getMessageText } from "../../llm/provider";
import { extractFileLikeTokens, stripUrls } from "../../core/hallucination/js-identifiers";
import type { ToolContext } from "../../tools/types";
import { findExistingFile } from "./auditor";
import type { PlanStore } from "./plan-store";

/**
 * Файловые токены из описания шага, не резолвящиеся в реальный файл.
 * Тот же общий экстрактор токенов (allow-list реальных расширений, URL
 * вырезаны) и subtree-резолвер аудитора: "bicycles.ts" находит
 * "bicycle-shop/src/data/bicycles.ts", а hostname в описании — никогда
 * missing deliverable. Шаги без файловых токенов (чистые команды, прогоны
 * проверок) неверифицируемы.
 */
export function missingStepDeliverables(baseDir: string, step: { description: string }): string[] {
  const tokens = extractFileLikeTokens(stripUrls(step.description));
  if (tokens.length === 0) return [];
  return tokens.filter((p) => !findExistingFile(baseDir, p));
}

/**
 * Файловые токены из описания шага, всё ещё резолвящиеся в реальный файл.
 * Инверсия missingStepDeliverables — для гейта delete-шагов ("done" значит
 * файлы пропали).
 */
export function stillExistingDeliverables(
  baseDir: string,
  step: { description: string },
): string[] {
  const tokens = extractFileLikeTokens(stripUrls(step.description));
  if (tokens.length === 0) return [];
  return tokens.filter((p) => findExistingFile(baseDir, p));
}

/** Есть ли в описании шага хоть один реальный файловый токен. Шаги без
 *  токенов (чистые команды, прогоны проверок) не автоверифицируются — */
export function hasStepDeliverables(step: { description: string }): boolean {
  return extractFileLikeTokens(stripUrls(step.description)).length > 0;
}

/**
 * Модельно-видимое actionable-сообщение «нет активного плана». Содержит
 * сведения о последнем завершённом плане и действие для продолжения — вместо
 * голого «No active plan», на котором 9B зацикливалась после авто-архива.
 */
export function noActivePlanMessage(store: PlanStore): string {
  const last = store.listArchived().at(-1);
  if (!last) return t("plan.no_active");
  const done = last.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  return t("plan.no_active_with_last", {
    id: last.id,
    title: last.title,
    done: String(done),
    total: String(last.steps.length),
  });
}

/**
 * BCP-5: формулировка ЗАДАЧИ — это последнее пользовательское сообщение,
 * а не первое в сессии. Первое сообщение относится к прошлому запросу, и его
 * файлы не должны блокировать новый план (живой прогон: note.txt из прошлого
 * хода заставил модель добавлять фиктивный шаг).
 * Инжектированные <system-summary> и компакции пропускаются.
 */
export function getTaskText(ctx: ToolContext | undefined): string {
  const manager = ctx?.contextManager;
  if (!manager) return "";
  const history = manager.getActiveHistory();
  const users = history.filter((m) => {
    if (m.role !== "user") return false;
    const text = getMessageText(m.content);
    return !text.startsWith("<system-summary>") && !text.includes("[Compressed:");
  });
  const current = users[users.length - 1];
  return current ? getMessageText(current.content).trim() : "";
}
