/**
 * Оформление результата тула в чат/мета-вывод и картинки события.
 *
 * Вынесено из `tool-batch.ts` (правило 6): чистые функции рендеринга.
 */
import type { OnMeta, ToolEvent } from "../types";
import type { ToolResult } from "../../tools/types";
import { pc } from "../../ui/colors";
import { toolFailureSummary } from "./tool-output";

/** Тип мета-события (совпадает с `MetaKind` треда вывода). */
type MetaKind = "tool";

/** Минимальный контракт депов для рендера результата. */
export interface ToolResultMetaDeps {
  pluginManager: {
    runOnMeta(ctx: unknown, chunk: string): string;
  };
  contextManager: unknown;
  logger: unknown;
}

/**
 * Печатает результат тула в ленту: успех — выводом, провал — спокойной
 * сводкой (без сырых маркеров гардов), diff — отдельным блоком.
 */
export function renderToolResultMeta(
  deps: ToolResultMetaDeps,
  iteration: number,
  result: ToolResult,
  onMeta: OnMeta | undefined,
): void {
  const { pluginManager, contextManager, logger } = deps;
  const TOOL_META: MetaKind = "tool";
  const hookCtx = { iteration, logger, contextManager };
  if (result.display !== undefined) {
    if (result.display.length > 0) onMeta?.(`\n${result.display}\n`, TOOL_META);
  } else if (result.success) {
    const metaOut = pluginManager.runOnMeta(hookCtx, result.output);
    onMeta?.(`\n${pc.dim(metaOut)}\n`, TOOL_META);
  } else {
    const failure = toolFailureSummary(result.output);
    const metaOut = failure.text ? pluginManager.runOnMeta(hookCtx, failure.text) : "";
    if (metaOut) {
      const color = failure.severity === "warn" ? pc.yellow : pc.red;
      const glyph = failure.severity === "warn" ? "⚠" : "✗";
      onMeta?.(`\n${color(`${glyph} ${metaOut}`)}\n`, TOOL_META);
    }
  }
  if (result.diff) onMeta?.(`\n${result.diff}\n`, TOOL_META);
}

/** Поля события с картинками результата тула (references либо сами картинки). */
export function imageEventFields(
  result: ToolResult,
): Pick<ToolEvent, "imageRefs" | "images"> {
  if (result.imageRefs?.length) return { imageRefs: result.imageRefs };
  if (result.images?.length) return { images: result.images };
  return {};
}
