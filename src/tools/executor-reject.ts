/**
 * Ранние отказы исполнения тула (правило ≤300 строк).
 *
 * Вынесено из `executor.ts`: проверки, которые обязаны произойти ДО хендлера —
 * allowlist, существование тула, активный набор тегов (INV-11). Возвращают
 * готовый `ToolResult` отказа или null, если вызов можно продолжать.
 */
import type { ToolContext, ToolCall, ToolResult } from "./types";
import type { ToolRegistry } from "./registry";
import { filterToolsByTags } from "./filter-tools";
import { allowedToolNames } from "./executor-security";
import { t } from "../i18n/index";

/**
 * Первый отказ по allowlist/наличию/тегам.
 * @param registry реестр тулов; @param ctx контекст исполнения; @param call вызов.
 * @returns результат-отказ или null, если проверки пройдены.
 */
export function earlyToolRejection(
  registry: ToolRegistry,
  ctx: ToolContext,
  call: ToolCall,
): ToolResult | null {
  const allow = allowedToolNames(ctx);
  if (allow && !allow.has(call.name)) {
    return {
      success: false,
      output: t("tool.not_allowed", { name: call.name }),
      toolCallId: call.id,
    };
  }

  const tool = registry.get(call.name);
  if (!tool) {
    return {
      success: false,
      output: t("tool.unknown", { name: call.name }),
      toolCallId: call.id,
    };
  }

  // Теги ограничивают исполнение, а не только схему (INV-11): вызов тула вне
  // активного набора тегов блокируется ДО хендлера. Критерий — тот же, что у
  // `filterToolsByTags` (alwaysOn переживает сужение); пустой набор тегов —
  // легаси «все тулы».
  if (filterToolsByTags([tool], ctx.activeToolTags ?? []).length === 0) {
    return {
      success: false,
      output: t("tool.tags_blocked", { name: call.name }),
      toolCallId: call.id,
    };
  }
  return null;
}
