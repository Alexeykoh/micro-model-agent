/** Тул ручной установки reasoning-уровня (транзиентный, с кулдауном). */
import { t } from "../i18n/index";
import type { ReasoningLevel, ReasoningConfig } from "../config/types";
import type { ToolDefinition, ToolContext, ToolResult } from "./types";

/** Допустимые уровни reasoning. */
const VALID_LEVELS: ReasoningLevel[] = ["default", "none", "low", "medium", "high", "max"];

/** Состояние reasoning: уровень, итерация оверрайда, ручной флаг. */
export interface ReasoningState {
  level: ReasoningLevel;
  overrideIteration: number;
  /**
   * Стойкий ручной оверрайд юзера (`/reasoning <level>`) — в отличие от
   * транзиентного `set_thinking`, протухающего после `overrideCooldown`.
   * Снимается через `/reasoning auto`.
   */
  manual?: boolean;
}

/**
 * Фабрика тула set_thinking (уровень на следующий LLM-вызов; штатно рулит
 * харнесс). Возврат: определение тула.
 */
export function createSetThinkingTool(
  state: ReasoningState,
  config: ReasoningConfig,
  getCurrentIteration: () => number,
): ToolDefinition {
  return {
    name: "set_thinking",
    description:
      "Set reasoning effort level for the next LLM call. Normally managed automatically by the harness. Use only to force deeper thinking for genuinely hard subproblems or shallower for mechanical batches.",
    icon: "🧠",
    tags: [],
    alwaysOn: true,
    parameters: {
      type: "object",
      properties: {
        level: {
          type: "string",
          enum: ["none", "low", "high", "max"],
          description: "Reasoning effort level to set",
        },
        reason: {
          type: "string",
          description: "Why changing the level",
        },
      },
      required: ["level"],
    },
    handler: async (_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
      const requested = args.level as string;
      const reason = (args.reason as string) || "agent override";

      if (!VALID_LEVELS.includes(requested as ReasoningLevel) && requested !== "auto") {
        return {
          success: false,
          output: t("tool.thinking_invalid_level", { level: requested }),
        };
      }

      // Проверка кулдауна.
      const currentIter = getCurrentIteration();
      const elapsed = currentIter - state.overrideIteration;
      if (elapsed > 0 && elapsed < config.overrideCooldown) {
        return {
          success: true,
          output: t("tool.thinking_cooldown", {
            remaining: config.overrideCooldown - elapsed,
            current: state.level,
          }),
        };
      }

      // Кламп в настроенные границы.
      let level = requested as ReasoningLevel;
      const levelOrder: ReasoningLevel[] = ["none", "low", "medium", "high", "max"];
      const minIdx = levelOrder.indexOf(config.min);
      const maxIdx = levelOrder.indexOf(config.max);
      const reqIdx = levelOrder.indexOf(level);

      let clamped = false;
      if (reqIdx >= 0 && reqIdx < minIdx) {
        level = config.min;
        clamped = true;
      } else if (reqIdx > maxIdx) {
        level = config.max;
        clamped = true;
      }

      state.level = level;
      state.overrideIteration = currentIter;

      const msg = clamped
        ? t("tool.thinking_set_clamped", { level, reason })
        : t("tool.thinking_set", { level, reason });

      return { success: true, output: msg };
    },
  };
}
