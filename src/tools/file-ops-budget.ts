/**
 * Видимый модели бюджет файловых операций: предупреждение заранее, а не только
 * `[SECURITY BLOCKED]` после 100-й правки (сессия ses_mwmeoln9: 6 блокировок).
 *
 * Единая точка — `finalizeToolResult`, отдельные хендлеры тулов не меняются.
 */
import { t } from "../i18n/index";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import type { ToolContext, ToolCall } from "./types";

/** За сколько операций до лимита показывать остаток. */
export const FILE_OPS_WARN_REMAINING = 10;

/** Тулы, расходующие бюджет файловых операций (декларативный список). */
const FILE_TOOLS = new Set([
  "write_file",
  "append_file",
  "edit_file",
  "delete_file",
  "move_file",
  "create-dir",
]);

export function fileOpsBudgetNote(ctx: ToolContext, call: ToolCall): string {
  if (!FILE_TOOLS.has(call.name)) return "";
  const securityConfig = ctx.sessionContext
    ? getSessionSecurityConfig(ctx.config, ctx.sessionContext)
    : ctx.config.security;
  const max = securityConfig?.maxFileOperations ?? 100;
  const used = ctx.fileOperationsCount ?? 0;
  const remaining = max - used;
  if (remaining > FILE_OPS_WARN_REMAINING || remaining < 0) return "";
  return t("tool.file_ops_budget", { remaining: String(remaining), max: String(max) });
}
