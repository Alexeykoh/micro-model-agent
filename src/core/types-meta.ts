// Мета-канал вывода (`onMeta`): вид события и структурированные детали.
// Вынесено из `core/types.ts` (правило ≤300).
import type { CriticReport } from "./types-critic";

/**
 * Вид мета-канала: тела тулов (`display`/`output`/`diff`/сводка из `ToolBatch`)
 * — model-facing, в quiet-чатах скрываются; настоящий статус (статистика
 * контекста, компакция, варнинги) виден всегда. `retract` — гейт забраковал
 * уже отстримленный черновик и переспрашивает модель: потребители убирают
 * черновик из ленты (иначе финал встанет дублем следом). `critic` — свёрнутый
 * итог проверки (детали по умолчанию скрыты).
 */
export type MetaKind = "tool" | "status" | "retract" | "progress" | "critic";

/** Кто отозвал уже отстримленный черновик (штатная перепроверка, не сбой). */
export type RetractSource = "critic" | "hallucination" | "audit";

/**
 * Структурированные детали отзыва черновика (`kind: "retract"`) или итог
 * проверки (`kind: "critic"`). Сырой текст метки остаётся первым аргументом
 * `OnMeta`: терминал и старые потребители `meta` не меняются, а лента/Trace
 * получают виновника, причину и итерацию.
 */
export interface RetractInfo {
  source: RetractSource;
  /** Короткая причина: summary/issue критика, claim или причина повтора. */
  reason?: string;
  /** Итерация петли — ключ связи с `critic_verdict`/`claim_retry` в логе. */
  iteration?: number;
  /** Статус/вид вердикта (`critical`, `concern`, `success`, `artifact`, …). */
  verdict?: string;
  /** Только для `kind: "critic"`: что смотрел критик и чем закончил. */
  critic?: CriticReport;
}
