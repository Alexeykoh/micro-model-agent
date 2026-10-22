/**
 * Мост «колбэки петли агента → envelope v1».
 *
 * Транспортно-чистый адаптер над колбэками `Agent.run`: буферизует
 * текст/reasoning, флашит дискретные события (фаза/тул), чистит секреты и
 * режет длинный вывод теми же хелперами, что web-форвардер (`scrubToolArgs`,
 * `clipToolOutput`), — но пишет envelope'ы вместо SSE-событий webui.
 */
import { stripAnsi } from "../../../ui/line-math";
import { redactContextSecrets } from "../../../core/api";
import { scrubToolArgs, clipToolOutput } from "../../webui/session/forward";
import type { ToolCall, ToolResult } from "../../../tools/types";

/** Передаёт готовые типы событий без `v`/`seq`/`ts` — их добавляет `emit`. */
export interface ServiceForwarder {
  onText(chunk: string): void;
  onReasoning(chunk: string): void;
  onPhase(phase: string): void;
  onToolStart(call: ToolCall): void;
  onToolEnd(call: ToolCall, result: ToolResult, durationMs: number): void;
  flush(): void;
  /** Придерживает события (структурный вывод: пока не прошла валидация). */
  hold(): void;
  /** Отдаёт придержанные события наружу. */
  release(): void;
  /** Выбрасывает придержанные события (первая попытка не увидела свет). */
  discard(): void;
  /** Номер попытки, который уходит в конверт (`attempt`). */
  setAttempt(attempt: number): void;
}

/** Опции моста: куда эмитить типы и через какой интервал флашить буфер. */
export interface ServiceForwarderOptions {
  /** `attempt` — номер попытки вывода (для retry структурного ответа). */
  emit: (type: string, data: unknown, attempt: number) => void;
  flushMs?: number;
}

const DEFAULT_FLUSH_MS = 250;

/** Строит буферизирующий мост колбэков агента в типизированные события. */
export function makeServiceForwarder(opts: ServiceForwarderOptions): ServiceForwarder {
  const flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
  const buf = { text: "", reasoning: "" };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 1;
  /** Непустой массив — события придержаны до `release`/`discard`. */
  let held: Array<{ type: string; data: unknown }> | null = null;

  const deliver = (type: string, data: unknown): void => opts.emit(type, data, attempt);
  const emit = (type: string, data: unknown): void => {
    if (held) held.push({ type, data });
    else deliver(type, data);
  };

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buf.reasoning) {
      emit("reasoning.delta", { chunk: stripAnsi(buf.reasoning) });
      buf.reasoning = "";
    }
    if (buf.text) {
      emit("text.delta", { chunk: stripAnsi(buf.text) });
      buf.text = "";
    }
  };
  const schedule = (): void => {
    if (!timer) timer = setTimeout(flush, flushMs);
  };

  return {
    onText(chunk) {
      buf.text += chunk;
      schedule();
    },
    onReasoning(chunk) {
      buf.reasoning += chunk;
      schedule();
    },
    onPhase(phase) {
      flush();
      emit("phase", { phase });
    },
    onToolStart(call) {
      flush();
      emit("tool.start", {
        toolCallId: call.id,
        name: call.name,
        args: scrubToolArgs(call.arguments),
      });
    },
    onToolEnd(call, result, durationMs) {
      flush();
      emit("tool.end", {
        toolCallId: call.id,
        name: call.name,
        success: result.success,
        durationMs,
        output: stripAnsi(redactContextSecrets(clipToolOutput(call.name, result.output || ""))),
      });
    },
    flush,
    hold() {
      if (!held) held = [];
    },
    release() {
      if (!held) return;
      flush();
      const pending = held;
      held = null;
      for (const event of pending) deliver(event.type, event.data);
    },
    discard() {
      held = null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      buf.text = "";
      buf.reasoning = "";
    },
    setAttempt(next) {
      attempt = next;
    },
  };
}
