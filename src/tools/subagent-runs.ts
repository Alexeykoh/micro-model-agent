/**
 * События прогона субагента для наблюдателя поверхности (веб-UI).
 *
 * Субагент — не сессия: у него свой `ContextManager`, но нет `sessionManager`
 * и UI-колбэков. Поверхность ставит `ToolContext.subagentRuns`, а тул
 * `subagent` превращает ход дочернего агента в этот поток. Ядро не знает, как
 * события хранятся и рендерятся; приёмник обязан быть fail-open.
 */
import { randomBytes } from "node:crypto";

/** Итоговый статус прогона. */
export type SubagentRunStatus = "done" | "failed" | "interrupted";

/** Пара токенов прогона (сумма LLM-вызовов субагента). */
export interface SubagentRunUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Начало прогона: кто и что делегировал. */
export interface SubagentRunStart {
  kind: "start";
  runId: string;
  /** Сессия-владелец (родительский ход). */
  parentSessionId?: string;
  /** id родительского tool call — клиент привязывает строку ленты к прогону. */
  parentToolCallId?: string;
  /** 1 — прямой субагент, 2 — вложенный и т.д. */
  depth: number;
  task: string;
  /** `expert_tag`, если задан. */
  agent?: string;
  model?: string;
  at: number;
}

/** Кусок текста/рассуждения; приёмник вправе коалесцировать. */
export interface SubagentRunChunk {
  kind: "text" | "reasoning";
  runId: string;
  chunk: string;
}

/** Служебная строка петли (статус/ретракт); тела тулов идут событиями tool_*. */
export interface SubagentRunNote {
  kind: "note";
  runId: string;
  chunk: string;
  metaKind?: string;
}

/** Фаза дочернего агента (для спиннера). */
export interface SubagentRunPhase {
  kind: "phase";
  runId: string;
  phase: "thinking" | "done";
}

/** Начало вызова тула внутри субагента. */
export interface SubagentRunToolStart {
  kind: "tool_start";
  runId: string;
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

/** Конец вызова тула внутри субагента; `output` — сырой, режет приёмник. */
export interface SubagentRunToolEnd {
  kind: "tool_end";
  runId: string;
  callId: string;
  tool: string;
  success: boolean;
  durationMs?: number;
  output?: string;
}

/** Завершение прогона (эмитится ровно один раз). */
export interface SubagentRunEnd {
  kind: "end";
  runId: string;
  status: SubagentRunStatus;
  iterations: number;
  durationMs: number;
  output?: string;
  error?: string;
  usage?: SubagentRunUsage;
}

/** Любое событие прогона. */
export type SubagentRunEvent =
  | SubagentRunStart
  | SubagentRunChunk
  | SubagentRunNote
  | SubagentRunPhase
  | SubagentRunToolStart
  | SubagentRunToolEnd
  | SubagentRunEnd;

/** Приёмник событий прогонов, который ставит поверхность (web-UI). */
export interface SubagentRunSink {
  emit(event: SubagentRunEvent): void;
}

/** Новый уникальный id прогона в пределах процесса. */
export function newSubagentRunId(): string {
  return `srun_${randomBytes(8).toString("hex")}`;
}

/**
 * Отправляет событие приёмнику, если он есть. Fail-open: сломанный или
 * медленный наблюдатель не должен менять результат субагента.
 */
export function emitSubagentEvent(
  ctx: { subagentRuns?: SubagentRunSink },
  event: SubagentRunEvent,
): void {
  try {
    ctx.subagentRuns?.emit(event);
  } catch {
    /* fail-open: наблюдатель не влияет на прогон */
  }
}
