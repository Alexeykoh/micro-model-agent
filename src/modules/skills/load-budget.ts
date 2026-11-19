/**
 * Бюджетная проверка загрузки скилла (правило ≤300 строк).
 *
 * Вынесено из `module.ts`: чистая функция считает, влезает ли тело скилла в
 * долевой бюджет и абсолютный cap, и собирает отказ/успех. Модуль применяет
 * решение к своему состоянию.
 */
import { t } from "../../i18n/index";
import type { SkillMeta } from "./loader";
import { estimateTokens } from "../../llm/token-counter";

/**
 * Абсолютный потолок суммарного веса загруженных тел скиллов (L2): хвост
 * промпта, каждая загрузка рвёт prefix-cache. Долевой бюджет
 * (`skills.budget` × окно) на больших окнах даёт десятки тысяч токенов хвоста;
 * cap держит его в разумных рамках. На малом окне доля меньше cap —
 * поведение 1:1 со старым.
 */
export const SKILLS_LOADED_TOKENS_CAP = 6000;

/** Итог загрузки скилла по имени (успех, сообщение, сам скилл). */
export interface LoadResult {
  success: boolean;
  message: string;
  skill?: SkillMeta;
}

/** Решение по загрузке: помещается или причина отказа. */
export type LoadDecision =
  | { ok: true; tokens: number; effectiveBudget: number }
  | { ok: false; message: string };

/**
 * Проверяет, влезает ли скилл в бюджет.
 * @param skill загружаемый скилл; @param budget долевой бюджет модуля;
 * @param currentTokens уже занято загруженными телами.
 */
export function checkLoadBudget(
  skill: SkillMeta,
  budget: number,
  currentTokens: number,
): LoadDecision {
  const tokens = estimateTokens(skill.content);
  // L2: абсолютный cap поверх долевого бюджета (см. SKILLS_LOADED_TOKENS_CAP).
  const effectiveBudget = Math.min(budget, SKILLS_LOADED_TOKENS_CAP);

  if (tokens > budget) {
    return {
      ok: false,
      message: t("skill.too_large", { name: skill.name, tokens, budget }),
    };
  }
  if (currentTokens + tokens > effectiveBudget) {
    const remaining = Math.max(0, effectiveBudget - currentTokens);
    return {
      ok: false,
      message: t("skill.exceeds_budget", { name: skill.name, tokens, remaining }),
    };
  }
  return { ok: true, tokens, effectiveBudget };
}
