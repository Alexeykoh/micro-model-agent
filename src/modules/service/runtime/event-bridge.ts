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
import type { MetaKind, RetractInfo } from "../../../core/types";
import { scrubToolArgs } from "../../../runtime/scrub";
import { clipToolOutput } from "../../../runtime/tool-output";
import type { ToolCall, ToolResult } from "../../../tools/types";

/** Передаёт готовые типы событий без `v`/`seq`/`ts` — их добавляет `emit`. */
export interface ServiceForwarder {
  onText(chunk: string): void;
  onReasoning(chunk: string): void;
  /**
   * Мета-канал: статусы, тела тулов, отзыв черновика и итог критика.
   * Без него thin-клиент терял всю не-текстовую ленту (split W9).
   */
  onMeta(chunk: string, kind?: MetaKind, info?: RetractInfo): void;
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
  const buf = { text: "", reasoning: "", meta: "", metaKind: undefined as MetaKind | undefined };
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
    if (buf.meta) {
      emit("meta", {
        chunk: stripAnsi(buf.meta),
        ...(buf.metaKind ? { kind: buf.metaKind } : {}),
      });
      buf.meta = "";
      buf.metaKind = undefined;
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
    onMeta(chunk, kind, info) {
      // `retract` и `critic` — дискретные события со структурой: терминал
      // печатает `label`, лента/Trace получают детали (как в web-форвардере).
      if (kind === "retract") {
        flush();
        const label = stripAnsi(chunk);
        emit("retract", {
          label,
          reason: info?.reason ? stripAnsi(info.reason) : label,
          ...(info?.source ? { source: info.source } : {}),
          ...(info?.iteration !== undefined ? { iteration: info.iteration } : {}),
          ...(info?.verdict ? { verdict: info.verdict } : {}),
        });
        return;
      }
      if (kind === "critic" && info?.critic) {
        flush();
        const report = info.critic;
        emit("critic", {
          label: stripAnsi(chunk),
          status: report.status,
          durationMs: report.durationMs,
          passes: report.passes,
          issues: report.issues,
          checks: report.checks,
          ...(report.summary ? { summary: stripAnsi(report.summary) } : {}),
          ...(report.timedOut ? { timedOut: true } : {}),
          ...(info.verdict ? { verdict: info.verdict } : {}),
        });
        return;
      }
      // Смена вида (тело тула ↔ статус) — отдельное событие, иначе потребитель
      // не отличит quiet-скрываемое от всегда видимого.
      if (buf.meta && buf.metaKind !== kind) flush();
      buf.meta += chunk;
      buf.metaKind = kind;
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
      buf.meta = "";
      buf.metaKind = undefined;
    },
    setAttempt(next) {
      attempt = next;
    },
  };
}
