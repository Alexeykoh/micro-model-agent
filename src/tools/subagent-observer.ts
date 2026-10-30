/**
 * Наблюдатель одного прогона субагента (шов веб-UI).
 *
 * `ToolContext.subagentRuns` необязателен: CLI/service его не ставят. Модуль
 * собирает колбэки `Agent.run` в плоский поток событий и гарантирует ровно один
 * `end` (успех, ошибка, прерывание). Вынесено из `subagent-run.ts` (правило 6).
 */
import type { ToolContext } from "./types";
import type { AgentResult, RetractInfo, ToolEvent } from "../core/types";
import {
  emitSubagentEvent,
  newSubagentRunId,
  type SubagentRunEvent,
  type SubagentRunStatus,
  type SubagentRunUsage,
  type SubagentUsageRecord,
} from "./subagent-runs";
import { finishSubagentRun, registerSubagentRun } from "./subagent-registry";

/** Колбэки, которые получает дочерний `Agent.run`. */
export interface SubagentCallbacks {
  onChunk: (chunk: string) => void;
  onMeta: (meta: string, kind?: "tool" | "status" | "retract", info?: RetractInfo) => void;
  onTool: (ev: ToolEvent) => void;
  onPhase: (phase: "thinking" | "done") => void;
  onReasoning: (reasoning: string) => void;
  /** Usage одного LLM-вызова прогона (пишется в журнал сессии). */
  onUsage: (usage: SubagentUsageRecord) => void;
}

/** Идентичность прогона для `start`. */
export interface SubagentObserverInfo {
  task: string;
  depth: number;
  agent?: string;
  model?: string;
}

/** Хендл наблюдателя: `start` до прогона, `finish` — ровно один раз. */
export interface SubagentObserver {
  runId: string;
  callbacks: SubagentCallbacks;
  start(): void;
  finish(
    status: SubagentRunStatus,
    iterations: number,
    output?: string,
    error?: string,
    usage?: SubagentRunUsage,
  ): void;
}

/** Создаёт наблюдателя поверх `ctx.subagentRuns` (fail-open). */
export function createSubagentObserver(
  ctx: ToolContext,
  info: SubagentObserverInfo,
): SubagentObserver {
  const runId = newSubagentRunId();
  const startedAt = Date.now();
  let ended = false;
  let toolSeq = 0;
  // `Agent.run` не несёт id вызова, если поверхность их не дала — LIFO по имени.
  const pendingIds = new Map<string, string[]>();
  const emit = (event: SubagentRunEvent): void => emitSubagentEvent(ctx, event);
  const fallbackCallId = (tool: string, end: boolean): string => {
    const stack = pendingIds.get(tool);
    if (end) return stack?.pop() ?? `srun-tool-${++toolSeq}`;
    const id = `srun-tool-${++toolSeq}`;
    if (stack) stack.push(id);
    else pendingIds.set(tool, [id]);
    return id;
  };

  const callbacks: SubagentCallbacks = {
    onChunk: (chunk) => emit({ kind: "text", runId, chunk }),
    onMeta: (meta, kind) => {
      // Тела тулов идут парой tool_start/tool_end; в note только статусы.
      if (kind === "tool") return;
      emit({ kind: "note", runId, chunk: meta, ...(kind ? { metaKind: kind } : {}) });
    },
    onTool: (ev) => {
      const callId = ev.callId ?? fallbackCallId(ev.tool, ev.type === "end");
      if (ev.type === "start") {
        emit({ kind: "tool_start", runId, callId, tool: ev.tool, args: ev.args });
        return;
      }
      emit({
        kind: "tool_end",
        runId,
        callId,
        tool: ev.tool,
        success: !ev.error,
        ...(ev.duration !== undefined ? { durationMs: ev.duration } : {}),
        ...(ev.output !== undefined ? { output: ev.output } : {}),
      });
    },
    onPhase: (phase) => emit({ kind: "phase", runId, phase }),
    onReasoning: (reasoning) => emit({ kind: "reasoning", runId, chunk: reasoning }),
    onUsage: (usage) => emit({ kind: "llm_usage", runId, ...usage }),
  };

  return {
    runId,
    callbacks,
    start(): void {
      registerSubagentRun({
        runId,
        parentSessionId: ctx.sessionId,
        task: info.task,
        ...(info.agent ? { agent: info.agent } : {}),
        ...(info.model ? { model: info.model } : {}),
        startedAt,
      });
      emit({
        kind: "start",
        runId,
        parentSessionId: ctx.sessionId,
        parentToolCallId: ctx.activeCallId,
        depth: info.depth,
        task: info.task,
        ...(info.agent ? { agent: info.agent } : {}),
        ...(info.model ? { model: info.model } : {}),
        at: startedAt,
      });
    },
    finish(status, iterations, output?, error?, usage?): void {
      if (ended) return;
      ended = true;
      finishSubagentRun(runId, {
        status,
        endedAt: Date.now(),
        iterations,
        ...(error !== undefined ? { error } : {}),
        ...(usage ? { usage } : {}),
      });
      emit({
        kind: "end",
        runId,
        status,
        iterations,
        durationMs: Date.now() - startedAt,
        ...(output !== undefined ? { output } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(usage ? { usage } : {}),
      });
    },
  };
}

/** Итог прогона → статус наблюдателя. */
export function resultStatus(result: AgentResult): SubagentRunStatus {
  if (result.success) return "done";
  return result.interrupted ? "interrupted" : "failed";
}

/** Токены прогона для `end` (undefined — провайдер их не сообщил). */
export function resultUsage(
  result: AgentResult,
): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
  if (result.promptTokens === undefined && result.totalTokens === undefined) return undefined;
  return {
    promptTokens: result.promptTokens ?? 0,
    completionTokens: result.completionTokens ?? 0,
    totalTokens: result.totalTokens ?? 0,
  };
}
