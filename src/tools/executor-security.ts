/**
 * Enforcement-политики тулов — чистая обвязка `ToolExecutor.execute()`
 * (INV-9/10). Порядок проверок, fail-closed и тексты решений — контракт:
 * менять только вместе с `tests/tools/enforcement-*.test.ts`.
 */
import type { ToolContext, ToolResult, ToolCall } from "./types";
import type { RegisteredTool } from "./registry";
import { checkToolPath } from "./path-enforcement";
import { isUrlAllowed } from "../modules/security/network-validator";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { DEFAULT_SECURITY_CONFIG } from "../config/security";
import { t } from "../i18n/index";

/**
 * Имена разрешённых тулов множеством, `null` — без ограничений.
 * `undefined` — без ограничений; `[]` — запрещено всё.
 */
export function allowedToolNames(ctx: ToolContext): Set<string> | null {
  const allow = ctx.toolAllowlist;
  return allow ? new Set(allow) : null;
}

/**
 * Политика путей по объявленным `pathArgs` (INV-10): scope (чтение/запись) и
 * protected-пути (только для записи, always-on). Fail-closed: блокировка
 * возвращает `blocked: true` до вызова хендлера.
 * @returns заблокированный `ToolResult` или `null`, если можно исполнять.
 */
export function enforcePathArgs(
  ctx: ToolContext,
  tool: RegisteredTool,
  call: ToolCall,
): ToolResult | null {
  const pathArgs = tool.security?.pathArgs;
  if (!pathArgs || pathArgs.length === 0) return null;
  const requiredRaw = tool.parameters.required;
  const required = Array.isArray(requiredRaw)
    ? requiredRaw.filter((v): v is string => typeof v === "string")
    : [];
  for (const argName of pathArgs) {
    const raw = call.arguments[argName];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (typeof value !== "string" || value.trim() === "") {
        // Обязательный path-аргумент не должен доходить до хендлера:
        // `String(undefined)` создавал файл с именем "undefined".
        if (required.includes(argName)) {
          return {
            success: false,
            blocked: true,
            output: t("tool.path_arg_invalid", { tool: tool.name, arg: argName }),
          };
        }
        continue;
      }
      const blocked = checkToolPath(ctx, tool.security, value, call.id);
      if (blocked) return blocked;
    }
  }
  return null;
}

/**
 * SSRF-политика по объявленным `urlArgs` (INV-10): `isUrlAllowed` с учётом
 * session-override. Fail-closed; пустой/нестроковый URL пропускается (тул сам
 * решает, обязателен ли он).
 * @returns заблокированный `ToolResult` или `null`.
 */
export function enforceUrlArgs(
  ctx: ToolContext,
  tool: RegisteredTool,
  call: ToolCall,
): ToolResult | null {
  const urlArgs = tool.security?.urlArgs;
  if (!urlArgs || urlArgs.length === 0) return null;
  const config = (ctx.config ?? {}) as import("../config/types").AppConfig;
  const netCfg = ctx.sessionContext
    ? getSessionSecurityConfig(config, ctx.sessionContext).network
    : config.security?.network || DEFAULT_SECURITY_CONFIG.network;
  for (const argName of urlArgs) {
    const raw = call.arguments[argName];
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const check = isUrlAllowed(raw, netCfg);
    if (!check.allowed) {
      return {
        success: false,
        blocked: true,
        output: t("tool.url_blocked", {
          url: raw,
          reason: check.reason ? ` — ${check.reason}` : "",
        }),
        toolCallId: call.id,
      };
    }
  }
  return null;
}

/**
 * TOCTOU-хук: мутирующий тул повторяет проверку прямо перед операцией.
 * Для тулов без путей хук снят, чтобы контекст не нёс чужую политику.
 */
export function createPathGuard(
  ctx: ToolContext,
  tool: RegisteredTool,
  call: ToolCall,
): ToolContext["pathGuard"] {
  return tool.security?.pathArgs && tool.security.pathArgs.length > 0
    ? {
        recheck: (path) => checkToolPath(ctx, tool.security, path, call.id) ?? undefined,
      }
    : undefined;
}
