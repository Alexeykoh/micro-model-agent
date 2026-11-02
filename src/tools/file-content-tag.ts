/**
 * DLP §4.8 (`file-content`): если тул читал/писал путь под
 * `providerBlockGlobs`, результат помечается sentinel'ом. Egress-guard снимает
 * тег для локального провайдера и вырезает содержимое для внешнего/API — по
 * пути, независимо от PII-паттернов. Скоуп — объявленные `pathArgs` (D6), плюс
 * отдельно `bash` (см. `tagShellFileContent`) и MCP-тулы с path-схемой.
 *
 * Вынесено из `executor.ts` (правило 6: файл на потолке гейта).
 *
 * Остаток долга (DEBT(file-content-bypass-non-path-tools)): плагины и
 * переменные/подстановки в `bash` — эвристика по токенам их не видит.
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

/** Токены команды, похожие на путь: не флаги, есть `/`, `\` или `.`. */
function commandPathTokens(command: string): string[] {
  return command
    .split(/[\s"'`;|&<>()]+/)
    .map((token) => token.replace(/^[=@]+/, "").replace(/[=,]+$/, ""))
    .filter((token) => token.length > 1 && !token.startsWith("-") && /[\\/.]/.test(token));
}

/**
 * `bash` не объявляет `pathArgs`, но команда называет файлы. Если хоть один
 * токен попадает под block-globs, весь вывод помечается `file-content`:
 * `cat secret/.env` уйдёт внешнему провайдеру как `[FILE]`, а не текстом.
 *
 * Эвристика консервативная: переменные и подстановки не раскрываются — это
 * residual risk, а не гарантия.
 */
export function tagShellFileContent(
  tool: RegisteredTool,
  call: ToolCall,
  result: ToolResult,
  ctx: ToolContext,
): ToolResult {
  if (tool.name !== "bash") return result;
  if (!result.success || typeof result.output !== "string" || result.output.length === 0) {
    return result;
  }
  const dp = ctx.config.security?.dataPolicy;
  if (dp?.enabled === false) return result;
  const globs = effectiveProviderBlockGlobs(dp ?? DEFAULT_DATA_POLICY);
  if (globs.length === 0) return result;
  const command = call.arguments.command;
  if (typeof command !== "string" || command.trim() === "") return result;
  for (const token of commandPathTokens(command)) {
    if (hiddenReason(token, ctx.baseDir, globs)) {
      return { ...result, output: tagFileContent(result.output) };
    }
  }
  return result;
}
