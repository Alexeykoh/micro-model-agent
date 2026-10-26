// Политика путей тула: одна проверка для enforcement и TOCTOU-реcheck.
// Живёт в `src/tools/`, потому что это шов исполнителя, а не модуль политики.
import type { ToolContext, ToolResult, ToolSecurityDecl } from "./types";
import { isPathInScope, isPathWritable } from "../modules/security/path-validator";
import { protectedPathBlock } from "../modules/security/protected-paths";
import { t } from "../i18n/index";

/** Пишущий ли тул (по объявленным caps). */
export function isWritableTool(security: ToolSecurityDecl | undefined): boolean {
  return (security?.caps ?? []).some(
    (c) => "fs" in c && (c.fs === "write" || c.fs === "any"),
  );
}

/**
 * Проверка одного пути по политике тула (INV-10): scope, protected-пути,
 * fail-closed. Общая для первичного enforcement (`pathArgs`) и TOCTOU-recheck
 * непосредственно перед файловой операцией.
 *
 * @returns заблокированный результат или `null`.
 */
export function checkToolPath(
  ctx: ToolContext,
  security: ToolSecurityDecl | undefined,
  value: string,
  toolCallId: string,
): ToolResult | null {
  const writable = isWritableTool(security);
  if (writable) {
    const prot = protectedPathBlock(ctx, value, value);
    if (prot) return { ...prot, blocked: true, toolCallId };
  }
  const check = writable
    ? isPathWritable(ctx.baseDir, value, ctx.scope, ctx.config.security?.paths)
    : isPathInScope(ctx.baseDir, value, ctx.scope, ctx.config.security?.paths);
  if (check.allowed) return null;
  return {
    success: false,
    blocked: true,
    output: t("tool.path_blocked", {
      path: value,
      reason: check.reason ? ` — ${check.reason}` : "",
    }),
    toolCallId,
  };
}
