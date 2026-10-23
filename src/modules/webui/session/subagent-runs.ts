// In-memory registry of subagent runs for `mma web` + SSE broadcast.
//
// A subagent is not a session (own ContextManager, no SessionManager), so its
// events cannot be replayed from `session.jsonl`. The web surface installs a
// `ToolContext.subagentRuns` sink; this store scrubs/caps the stream, keeps the
// last runs per session and broadcasts each event as `subagent` SSE. Parent
// tool row → run mapping uses `parentToolCallId` from the executor.
import type { SubagentRunEnd, SubagentRunEvent } from "../../../tools/subagent-runs";
import { scrubToolArgs } from "./scrub";
import {
  SUBAGENT_RUNS_PER_SESSION,
  SUBAGENT_RUN_MAX_EVENTS,
  SUBAGENT_RUN_MAX_TEXT_CHARS,
  cleanRunText,
  clipRunOutput,
  type SubagentRunSnapshot,
  type SubagentWireEvent,
} from "./subagent-run-caps";
export {
  SUBAGENT_RUNS_PER_SESSION,
  SUBAGENT_RUN_MAX_EVENTS,
  SUBAGENT_RUN_MAX_TEXT_CHARS,
  SUBAGENT_TOOL_OUTPUT_CAP,
} from "./subagent-run-caps";

/** Исходящее SSE-событие прогона (структурно совпадает с `SseEvent`). */
export type SubagentWireOut = { type: string; ts: number; [k: string]: unknown };

/** Куда стор отдаёт готовое SSE-событие (веб-слой передаёт `broadcast`). */
export type SubagentBroadcast = (event: SubagentWireOut) => void;

/** Окно коалесцирования чанков текста/рассуждений (как у основного forwarder). */
const COALESCE_MS = 50;

/** Внутренняя запись прогона. */
interface StoredRun extends SubagentRunSnapshot {
  seq: number;
  textChars: number;
  pendingText: string;
  pendingReasoning: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Хранилище прогонов субагентов в памяти процесса. */
export class SubagentRunStore {
  private runs = new Map<string, StoredRun>();
  private bySession = new Map<string, string[]>();
  /** Ручки остановки прогонов (ставит тул `subagent`, зовёт API/кнопка). */
  private interrupts = new Map<string, () => void>();

  /** Приёмник для `ToolContext.subagentRuns` (замыкает broadcast и store). */
  sink(send: SubagentBroadcast) {
    return {
      emit: (event: SubagentRunEvent): void => this.ingest(event, send),
      registerInterrupt: (runId: string, interrupt: () => void): void => {
        this.interrupts.set(runId, interrupt);
      },
      releaseInterrupt: (runId: string): void => {
        this.interrupts.delete(runId);
      },
    };
  }

  /** Останавливает прогон кнопкой веба; `not_running` — уже завершён. */
  interrupt(sessionId: string, runId: string): "ok" | "not_found" | "not_running" {
    const run = this.runs.get(runId);
    if (!run || run.parentSessionId !== sessionId) return "not_found";
    const stop = this.interrupts.get(runId);
    if (!stop) return "not_running";
    stop();
    return "ok";
  }

  /** Принимает событие прогона: нормализует, хранит, рассылает. */
  ingest(event: SubagentRunEvent, send?: SubagentBroadcast): void {
    if (!event || typeof event.runId !== "string" || !event.runId) return;
    let run = this.runs.get(event.runId);
    if (!run) {
      if (event.kind !== "start") return; // без start прогон не принимаем
      run = this.create(event);
    }
    if (run.status !== "running" && event.kind !== "end") return;

    switch (event.kind) {
      case "start":
        this.push(run, event, send);
        break;
      case "text":
      case "reasoning":
        this.appendChunk(run, event, send);
        break;
      case "note":
        this.flush(run, send);
        this.push(run, { ...event, chunk: cleanRunText(event.chunk) ?? "" }, send);
        break;
      case "tool_start":
        this.flush(run, send);
        this.push(run, { ...event, args: scrubToolArgs(event.args ?? {}) }, send);
        break;
      case "tool_end": {
        this.flush(run, send);
        const output = event.output === undefined ? undefined : cleanRunText(clipRunOutput(event.output));
        this.push(run, { ...event, ...(output !== undefined ? { output } : {}) }, send);
        break;
      }
      case "phase":
        this.flush(run, send);
        this.push(run, event, send);
        break;
      case "end":
        this.flush(run, send);
        this.finish(run, event, send);
        break;
    }
  }

  /** Снимки прогонов сессии (новые последними), опционально по tool call. */
  list(sessionId: string, toolCallId?: string): SubagentRunSnapshot[] {
    const ids = this.bySession.get(sessionId) ?? [];
    return ids
      .map((id) => this.runs.get(id))
      .filter((r): r is StoredRun => !!r)
      .filter((r) => !toolCallId || r.parentToolCallId === toolCallId)
      .map((r) => this.snapshot(r));
  }

  /** Прогон по id (undefined — нет или принадлежит другой сессии). */
  get(sessionId: string, runId: string): SubagentRunSnapshot | undefined {
    const run = this.runs.get(runId);
    if (!run || run.parentSessionId !== sessionId) return undefined;
    return this.snapshot(run);
  }

  /** Сессия удалена: её прогоны больше не нужны. */
  forgetSession(sessionId: string): void {
    const ids = this.bySession.get(sessionId) ?? [];
    for (const id of [...ids]) this.drop(id);
    this.bySession.delete(sessionId);
  }

  private create(event: Extract<SubagentRunEvent, { kind: "start" }>): StoredRun {
    const run: StoredRun = {
      runId: event.runId,
      parentSessionId: event.parentSessionId,
      parentToolCallId: event.parentToolCallId,
      depth: typeof event.depth === "number" ? event.depth : 1,
      task: cleanRunText(event.task) ?? "",
      agent: event.agent,
      model: event.model,
      startedAt: typeof event.at === "number" ? event.at : Date.now(),
      status: "running",
      events: [],
      seq: 0,
      textChars: 0,
      pendingText: "",
      pendingReasoning: "",
      timer: null,
    };
    this.runs.set(run.runId, run);
    const key = run.parentSessionId ?? "";
    const ids = this.bySession.get(key) ?? [];
    ids.push(run.runId);
    this.bySession.set(key, ids);
    this.evict(key);
    return run;
  }

  /** Коалесцирует текстовые чанки: один SSE на ~50 мс, не на токен. */
  private appendChunk(
    run: StoredRun,
    event: Extract<SubagentRunEvent, { kind: "text" | "reasoning" }>,
    send: SubagentBroadcast | undefined,
  ): void {
    const chunk = cleanRunText(event.chunk);
    if (!chunk) return;
    const remaining = SUBAGENT_RUN_MAX_TEXT_CHARS - run.textChars;
    if (remaining <= 0) return;
    const text = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
    run.textChars += text.length;
    if (event.kind === "text") run.pendingText += text;
    else run.pendingReasoning += text;
    if (run.timer) return;
    run.timer = setTimeout(() => {
      run.timer = null;
      this.flush(run, send);
    }, COALESCE_MS);
    run.timer.unref?.();
  }

  /** Сбрасывает буферы в SSE в порядке поступления. */
  private flush(run: StoredRun, send: SubagentBroadcast | undefined): void {
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
    }
    if (run.pendingText) {
      this.push(run, { kind: "text", runId: run.runId, chunk: run.pendingText }, send);
      run.pendingText = "";
    }
    if (run.pendingReasoning) {
      this.push(run, { kind: "reasoning", runId: run.runId, chunk: run.pendingReasoning }, send);
      run.pendingReasoning = "";
    }
  }

  private finish(run: StoredRun, event: SubagentRunEnd, send: SubagentBroadcast | undefined): void {
    run.status = event.status;
    run.endedAt = Date.now();
    run.iterations = event.iterations;
    run.output = cleanRunText(event.output);
    run.error = cleanRunText(event.error);
    run.usage = event.usage;
    this.push(run, event, send);
  }

  /** Сохраняет событие с `seq` и сразу рассылает его. */
  private push(run: StoredRun, event: SubagentRunEvent, send: SubagentBroadcast | undefined): void {
    if (run.events.length >= SUBAGENT_RUN_MAX_EVENTS) return;
    const seq = ++run.seq;
    run.events.push({ ...event, seq } as SubagentWireEvent);
    const wire: SubagentWireOut = {
      type: "subagent",
      ts: Date.now(),
      seq,
      ...(run.parentSessionId ? { sessionId: run.parentSessionId } : {}),
      ...event,
    };
    send?.(wire);
  }

  private snapshot(run: StoredRun): SubagentRunSnapshot {
    return {
      runId: run.runId,
      parentSessionId: run.parentSessionId,
      parentToolCallId: run.parentToolCallId,
      depth: run.depth,
      task: run.task,
      agent: run.agent,
      model: run.model,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      status: run.status,
      output: run.output,
      error: run.error,
      iterations: run.iterations,
      usage: run.usage,
      events: run.events.map((e) => ({ ...e })),
    };
  }

  /** Держит не больше `SUBAGENT_RUNS_PER_SESSION`: первым уходит завершённый. */
  private evict(sessionId: string): void {
    const ids = this.bySession.get(sessionId);
    if (!ids || ids.length <= SUBAGENT_RUNS_PER_SESSION) return;
    while (ids.length > SUBAGENT_RUNS_PER_SESSION) {
      const idx = ids.findIndex((id) => this.runs.get(id)?.status !== "running");
      if (idx === -1) break;
      this.drop(ids[idx]);
    }
  }

  private drop(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.timer) clearTimeout(run.timer);
    this.interrupts.delete(runId);
    this.runs.delete(runId);
    const key = run.parentSessionId ?? "";
    const ids = this.bySession.get(key);
    if (ids) {
      const idx = ids.indexOf(runId);
      if (idx !== -1) ids.splice(idx, 1);
      if (ids.length === 0) this.bySession.delete(key);
    }
  }
}




