/**
 * Резолв `expert_tag` субагента: конфиг эксперта или готовый отказ.
 *
 * Вынесено из `subagent-run.ts` (правило 6: файл на границе 300 строк). Отказ
 * обязан оставить след в `audit.jsonl` и объяснить модели разницу «эксперт vs
 * скилл» — иначе модель повторяет тот же вызов (`ses_mvoac9q9`, дефект D5).
 */
import type { ToolContext } from "./types";
import type { ExpertConfig } from "../config/types";
import { getExpertConfig } from "../config/experts";
import { logSecurityBlock } from "../modules/security/audit-log";

/** Итог резолва: либо конфиг эксперта, либо текст отказа для модели. */
export interface ExpertLookup {
  expert?: ExpertConfig;
  /** Готовый ответ тулу (уже с `[SECURITY BLOCKED]` и записью в audit). */
  refusal?: string;
}

/**
 * Ищет эксперта по тегу. Неизвестный тег логируется и превращается в отказ с
 * перечнем сконфигурированных значений.
 */
export function lookupExpertTag(ctx: ToolContext, expertTag: string): ExpertLookup {
  const expert = getExpertConfig(ctx.config, expertTag);
  if (expert) return { expert };

  const known = Object.keys(ctx.config.experts ?? {});
  const reason = `Unknown expert_tag "${expertTag}"`;
  logSecurityBlock(ctx.sessionId, "tool_call", reason, `expert_tag: ${expertTag}`);
  return {
    refusal:
      `[SECURITY BLOCKED] ${reason}. Known experts: [${known.join(", ") || "none"}]. ` +
      "expert_tag is a configured expert from config.experts, not a skill name — skills are " +
      "loaded with load_skill. Pass tool_tags to choose the sub-agent's tools explicitly.",
  };
}
