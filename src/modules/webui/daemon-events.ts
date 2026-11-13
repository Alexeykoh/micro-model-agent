/**
 * Маппинг host-событий демона в веб-SSE (split W4).
 *
 * Словарь один и тот же по смыслу, отличается только именование оболочки:
 * демон отдаёт `text.delta`/`tool.start`, браузер ждёт `text`/`tool_start`.
 */
import type { HostEvent } from "../../core/host";
import type { SseEvent } from "./state";

/** Переводит событие демона в SSE-событие web; `null` — событие не для ленты. */
export function mapHostEvent(ev: HostEvent): SseEvent | null {
  const data = (ev.data ?? {}) as Record<string, unknown>;
  const base = { ts: ev.ts, ...(ev.sessionId ? { sessionId: ev.sessionId } : {}) };
  switch (ev.type) {
    case "text.delta":
      return { ...base, type: "text", chunk: String(data.chunk ?? "") };
    case "reasoning.delta":
      return { ...base, type: "reasoning", chunk: String(data.chunk ?? "") };
    case "phase":
      return { ...base, type: "phase", phase: String(data.phase ?? "") };
    case "tool.start":
      return {
        ...base,
        type: "tool_start",
        toolCallId: String(data.toolCallId ?? ""),
        name: String(data.name ?? ""),
        args: data.args ?? {},
      };
    case "tool.end":
      return {
        ...base,
        type: "tool_end",
        toolCallId: String(data.toolCallId ?? ""),
        name: String(data.name ?? ""),
        success: data.success !== false,
        durationMs: Number(data.durationMs ?? 0),
        output: String(data.output ?? ""),
      };
    case "plan":
      return {
        ...base,
        type: "plan",
        steps: data.steps ?? [],
        currentIndex: data.currentIndex ?? 0,
      };
    case "question":
      return {
        ...base,
        type: "question",
        id: String(data.id ?? ""),
        text: String(data.text ?? ""),
        kind: String(data.kind ?? "text"),
        options: data.options ?? [],
        multiple: data.multiple === true,
        allowCustom: data.allowCustom === true,
      };
    case "task.started":
      return { ...base, type: "phase", phase: "thinking" };
    case "task.finished":
      return { ...base, type: "turn_end", success: true };
    case "task.failed":
      return {
        ...base,
        type: "turn_end",
        success: false,
        error: String((data.error as { detail?: string } | undefined)?.detail ?? "task failed"),
      };
    case "task.cancelled":
      return { ...base, type: "turn_end", success: false, interrupted: true };
    case "update":
      return {
        ...base,
        type: "update",
        phase: String(data.phase ?? ""),
        current: String(data.current ?? ""),
        ...(data.latest ? { latest: String(data.latest) } : {}),
        ...(data.error ? { error: String(data.error) } : {}),
        ...(data.progress ? { progress: data.progress } : {}),
      };
    default:
      return null;
  }
}
