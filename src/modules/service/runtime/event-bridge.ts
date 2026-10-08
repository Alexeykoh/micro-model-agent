/**
 * Мост «колбэки петли агента → envelope v1».
 *
 * Транспортно-чистый адаптер над колбэками `Agent.run`: буферизует
 * текст/reasoning, флашит дискретные события (фаза/тул), чистит секреты и
 * режет длинный вывод теми же хелперами, что web-форвардер (`scrubToolArgs`,
 * `clipToolOutput`), — но пишет envelope'ы вместо SSE-событий webui.
 */
import { stripAnsi } from "../../../ui/line-math";
import { redactContextSecrets } from "../../../core/agent/context-log";
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
}

/** Опции моста: куда эмитить типы и через какой интервал флашить буфер. */
export interface ServiceForwarderOptions {
  emit: (type: string, data: unknown) => void;
  flushMs?: number;
}

const DEFAULT_FLUSH_MS = 250;

/** Строит буферизирующий мост колбэков агента в типизированные события. */
export function makeServiceForwarder(opts: ServiceForwarderOptions): ServiceForwarder {
  const flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
  const buf = { text: "", reasoning: "" };
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buf.reasoning) {
      opts.emit("reasoning.delta", { chunk: stripAnsi(buf.reasoning) });
      buf.reasoning = "";
    }
    if (buf.text) {
      opts.emit("text.delta", { chunk: stripAnsi(buf.text) });
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
      opts.emit("phase", { phase });
    },
    onToolStart(call) {
      flush();
      opts.emit("tool.start", {
        toolCallId: call.id,
        name: call.name,
        args: scrubToolArgs(call.arguments),
      });
    },
    onToolEnd(call, result, durationMs) {
      flush();
      opts.emit("tool.end", {
        toolCallId: call.id,
        name: call.name,
        success: result.success,
        durationMs,
        output: stripAnsi(redactContextSecrets(clipToolOutput(call.name, result.output || ""))),
      });
    },
    flush,
  };
}
