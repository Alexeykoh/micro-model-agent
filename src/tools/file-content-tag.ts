/**
 * DLP §4.8 (`file-content`): если тул читал/писал путь под
 * `providerBlockGlobs`, результат помечается sentinel'ом. Egress-guard снимает
 * тег для локального провайдера и вырезает содержимое для внешнего/API — по
 * пути, независимо от PII-паттернов. Скоуп — только объявленные `pathArgs` (D6).
 *
 * Вынесено из `executor.ts` (правило 6: файл на потолке гейта).
 *
 * DEBT(file-content-bypass-non-path-tools): `bash`/MCP/плагины не объявляют
 * `pathArgs`, поэтому их вывод не тегируется (только regex-редакция).
 */
import type { ToolContext, ToolCall, ToolResult } from "./types";
import type { RegisteredTool } from "./registry";
import {
  DEFAULT_DATA_POLICY,
  effectiveProviderBlockGlobs,
} from "../modules/security/data-policy/defaults";
import { tagFileContent } from "../modules/security/data-policy/file-content";
import { hiddenReason } from "../modules/security/data-policy/path-policy";

/** Пометить результат, если объявленный path-аргумент попал под block-glob. */
export function tagBlockedFileContent(
  tool: RegisteredTool,
  call: ToolCall,
  result: ToolResult,
  ctx: ToolContext,
): ToolResult {
  if (!result.success || typeof result.output !== "string" || result.output.length === 0) {
    return result;
  }
  const pathArgs = tool.security?.pathArgs;
  if (!pathArgs || pathArgs.length === 0) return result;
  const dp = ctx.config.security?.dataPolicy;
  if (dp?.enabled === false) return result;
  const globs = effectiveProviderBlockGlobs(dp ?? DEFAULT_DATA_POLICY);
  if (globs.length === 0) return result;
  for (const argName of pathArgs) {
    const raw = call.arguments[argName];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (typeof value !== "string" || value.trim() === "") continue;
      if (hiddenReason(value, ctx.baseDir, globs)) {
        return { ...result, output: tagFileContent(result.output) };
      }
    }
  }
  return result;
}
