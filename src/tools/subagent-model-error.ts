/** Читаемая подсказка при провайдерской ошибке «model is unavailable» у субагента. */
import { t } from "../i18n/index";

/**
 * Детект ошибки недоступной модели в сыром тексте провала.
 * Формулировка приходит из гейтвея провайдера (не из MMA), обычно внутри JSON:
 * `... Model "X" is unavailable."}}` — поэтому матчим два маркера вместо точной строки.
 */
export function isModelUnavailableError(rawError: string): boolean {
  return /model/i.test(rawError) && /is unavailable/i.test(rawError);
}

/**
 * Форматирует провал субагента как раньше (`tool.subagent_failed`), но при
 * недоступной модели дописывает, какая модель запрашивалась и где её поправить.
 * Без expert_tag субагент уже идёт на модели родителя — значит, проблема
 * на стороне провайдера (ретайр ID, outage), а не в параметрах вызова.
 */
export function formatSubagentFailure(
  error: string,
  text: string,
  expertTag: string | undefined,
  model: string,
): string {
  const output = t("tool.subagent_failed", { error, text });
  if (!isModelUnavailableError(error)) return output;
  const hint = t("tool.subagent_model_unavailable", {
    model,
    expert: expertTag ? ` (via expert_tag "${expertTag}")` : "",
  });
  return `${output}\n${hint}`;
}
