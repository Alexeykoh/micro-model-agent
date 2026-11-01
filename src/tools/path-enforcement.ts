// Политика путей тула: одна проверка для enforcement и TOCTOU-recheck.
// Живёт в `src/tools/`, потому что это шов исполнителя, а не модуль политики.
import type { ToolContext, ToolResult, ToolSecurityDecl } from "./types";
import { isPathInScope, isPathWritable } from "../modules/security/path-validator";
import { matchProtectedPath, protectedPathBlock } from "../modules/security/protected-paths";
import { logSecurityApproval } from "../modules/security/audit-log";
import { safeResolvePath } from "./path-utils";
import { t } from "../i18n/index";

/** Пишущий ли тул (по объявленным caps). */
export function isWritableTool(security: ToolSecurityDecl | undefined): boolean {
  return (security?.caps ?? []).some(
    (c) => "fs" in c && (c.fs === "write" || c.fs === "any"),
  );
}

/**
 * Защищённый путь: одноразовое разрешение `approve` пропускает ровно одну
 * операцию. Разрешение живёт в `ctx.approvals` (его минтит только хендлер
 * `approve` после ответа пользователя), поэтому текст модели — в том числе
 * `[APPROVED]` — на решение не влияет.
 *
 * @returns `null`, если запись разрешена; иначе блок с директивой.
 */
function protectedWriteBlock(
  ctx: ToolContext,
  value: string,
  toolCallId: string,
): ToolResult | null {
  if (!matchProtectedPath(ctx.baseDir, value)) return null;
  const grant = ctx.approvals?.consume(safeResolvePath(ctx.baseDir, value), toolCallId);
  if (grant) {
    logSecurityApproval(ctx.sessionId, grant.token, grant.action, value, toolCallId);
    return null;
  }
  const prot = protectedPathBlock(ctx, value, value);
  return prot ? { ...prot, blocked: true, toolCallId } : null;
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
    const prot = protectedWriteBlock(ctx, value, toolCallId);
    if (prot) return prot;
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
