/**
 * События прогонов субагентов на host wire (split W10).
 *
 * Стор отдаёт готовый wire-объект (`type: "subagent"`, свои seq/ts); оболочка
 * события добавляет envelope и sessionId, поэтому тип фиксирован здесь, а не
 * вычисляется из поля.
 */
import type { AgentServiceState } from "../state";
import { emitSessionEvent } from "./emit";

/** Публикует одно событие прогона субагента подписчикам сессии. */
export function emitSubagentEvent(
  s: AgentServiceState,
  sessionId: string,
  wire: unknown,
): void {
  emitSessionEvent(s, sessionId, "subagent", wire);
}

/** Ставит приёмник прогонов в `ToolContext` раннера (живой снимок + SSE). */
export function attachSubagentSink(
  s: AgentServiceState,
  sessionId: string,
  runner: { toolCtx?: { subagentRuns?: unknown } },
): void {
  if (!runner.toolCtx) return;
  runner.toolCtx.subagentRuns = s.subagentRuns.sink((ev) => {
    emitSubagentEvent(s, sessionId, ev);
  });
}
