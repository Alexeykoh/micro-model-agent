/**
 * Общий fail-open раннер документных тулов (INV-D5/INV-12): любая ошибка
 * чтения/разбора даёт запись `module:documents` и результат `{success:false}`
 * с причиной. Держит один путь диагностики для обоих тулов.
 */
import { t } from "../../../i18n/index";
import type { ToolContext, ToolResult } from "../../../tools/types";

/** Причина ошибки как строка. */
export function causeOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Эмитит диагностику и возвращает fail-open результат с готовым текстом (INV-D5). */
export function rejectResult(
  ctx: ToolContext,
  operation: string,
  cause: string,
  output: string,
): ToolResult {
  ctx.onDiagnostic?.({ source: "module:documents", operation, kind: "failed", cause });
  return { success: false, output };
}

/** Эмитит диагностику и возвращает fail-open результат (INV-D5). */
export function failResult(ctx: ToolContext, operation: string, cause: string): ToolResult {
  return rejectResult(ctx, operation, cause, t("documents.error", { reason: cause }));
}

/** Выполняет тело тула; при исключении — fail-open с записью (INV-D5). */
export async function failOpen(
  ctx: ToolContext,
  operation: string,
  body: () => Promise<string>,
): Promise<ToolResult> {
  try {
    return { success: true, output: await body() };
  } catch (err) {
    return failResult(ctx, operation, causeOf(err));
  }
}
