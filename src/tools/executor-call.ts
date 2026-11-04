/**
 * Запуск хендлера неинтерактивного тула под таймаутом и abort-сигналом.
 * Часть `ToolExecutor.execute()`: failFast (kill процесса + cleanup) и порядок
 * снятия таймера/слушателя — контракт, менять вместе с `tests/executor.test.ts`.
 */
import type { ToolContext, ToolResult, ToolCall } from "./types";
import type { RegisteredTool } from "./registry";
import { killByCallId } from "../modules/processes/runner";
import { t } from "../i18n/index";
import { TOOL_EXECUTION_TIMEOUT_MS } from "../config/timeouts";

/**
 * Выполнить неинтерактивный хендлер (или отдать мемо-хит) с таймаутом и
 * отменой. Победитель гонки — результат; проигравшие логируются и отцепляются.
 */
export async function runToolWithTimeout(
  ctx: ToolContext,
  tool: RegisteredTool,
  call: ToolCall,
  signal: AbortSignal | undefined,
  memoHit: ToolResult | undefined,
): Promise<ToolResult> {
  const timeoutMs =
    typeof tool.timeoutMs === "function"
      ? tool.timeoutMs(ctx)
      : (tool.timeoutMs ?? TOOL_EXECUTION_TIMEOUT_MS);
  const failFast = (message: string) => {
    // Убить долгоживущий дочерний процесс этого вызова.
    killByCallId(call.id, ctx.sessionId);
    // Тул-специфичный cleanup (напр. восстановление скоупа subagent) —
    // до reject, чтобы общее состояние восстановилось и при abandonment.
    const cleanup = ctx.cleanup;
    if (cleanup) {
      cleanup();
      // Сбрасывать, только если более новый вызов не подменил тем временем.
      if (ctx.cleanup === cleanup) ctx.cleanup = undefined;
    }
    return new Error(message);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<ToolResult>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        failFast(
          t("tool.timeout", {
            name: call.name,
            seconds: Math.round(timeoutMs / 1000),
          }),
        ),
      );
    }, timeoutMs);
  });
  const racePromises: Promise<ToolResult>[] = [
    memoHit ? Promise.resolve(memoHit) : tool.handler(ctx, call.arguments),
    timeoutPromise,
  ];
  if (signal) {
    const abortPromise = new Promise<ToolResult>((_, reject) => {
      onAbort = () => reject(failFast(t("tool.aborted", { name: call.name })));
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    racePromises.push(abortPromise);
  }
  try {
    return await Promise.race(racePromises);
  } finally {
    // Остановить таймер и снять abort-слушатель, чтобы они не сработали
    // против контекста/cleanup УЖЕ ДРУГОГО вызова.
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    // У проигравших промисов потребителя после settled race нет (их
    // kill/cleanup-эффекты уже применены в failFast). Залогировать
    // reject и отцепить, чтобы не всплыл как unhandled rejection.
    for (const p of racePromises.slice(1)) {
      p.catch((e: Error) => {
        ctx.logger.debug(`Tool ${call.name}: discarded race loser: ${e.message}`);
      });
    }
  }
}
