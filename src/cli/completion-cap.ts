// Кап длинных списков автодополнения.
//
// Вынесено из `completer-providers.ts`: это политика выдачи кандидатов, а не
// конкретный провайдер (правило 6 AGENTS).
import { t } from "../i18n/index";

/** Сколько кандидатов показываем до пометки «ещё N». */
export const CANDIDATE_CAP = 20;

/** Вариант дополнения (совместим с `CompletionItem` комплитера). */
export interface CappedItem {
  value: string;
  description?: string;
}

/**
 * Ограничивает длинные списки (сессии, скиллы): 20 кандидатов и пометка
 * «… ещё N» — иначе список превращается в простыню (аудит §8.15).
 */
export function capCandidates(
  values: string[],
  toItem: (value: string) => CappedItem,
): CappedItem[] {
  if (values.length <= CANDIDATE_CAP) return values.map(toItem);
  return [
    ...values.slice(0, CANDIDATE_CAP).map(toItem),
    { value: t("repl.completion_more", { count: String(values.length - CANDIDATE_CAP) }) },
  ];
}
