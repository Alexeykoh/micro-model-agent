/**
 * Пост-обработка результата тула: DLP-теги, taint субагента, admission,
 * логирование. Часть `ToolExecutor.execute()`, порядок шагов — контракт.
 */
import type { ToolContext, ToolResult, ToolCall } from "./types";
import type { RegisteredTool } from "./registry";
import { tagBlockedFileContent, tagShellFileContent } from "./file-content-tag";
import { admitFromContext } from "./admission";

/** DLP + taint + admission: то, что видит модель и контекст. */
export function finalizeToolResult(
  ctx: ToolContext,
  tool: RegisteredTool,
  call: ToolCall,
  result: ToolResult,
): ToolResult {
  // DLP §4.8: результат по пути из `providerBlockGlobs` тегируется
  // `file-content`; egress-guard решит, отдавать его (локально) или резать.
  let out = tagBlockedFileContent(tool, call, result, ctx);
  // `bash`: путь в самой команде (§4.8) — тоже источник file-content.
  out = tagShellFileContent(tool, call, out, ctx);
  // Субагент: его ответ производен от защищённых файлов дочернего контекста.
  if (out.taint) ctx.contextManager?.markNextToolTainted?.();

  // Admission (OO-1/OO-7): результат больше admitMaxTokens не входит в
  // контекст дословно — спилл + дескриптор. Одна точка для всех тулов;
  // хендлер политику не реализует. Мемо сохраняет уже admitted результат.
  return admitFromContext(out, ctx, call);
}

/** Запись вызова в лог сессии/приложения (после post-хуков). */
export function logToolResult(ctx: ToolContext, call: ToolCall, result: ToolResult): void {
  ctx.logger.logToolCall(
    call.name,
    JSON.stringify(call.arguments)?.slice(0, 200) ?? "",
    result.success ? "OK" : `FAIL: ${result.output?.slice(0, 200)}`,
  );
  ctx.logger.logToolOutput(call.name, result.output ?? "", result.success ? 0 : 1);
  ctx.logger.debug(`Tool ${call.name}: ${result.success ? "OK" : "FAIL"}`);
}
