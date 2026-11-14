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
    case "tool.end": {
      const images = toolImageUrls(ev, data);
      return {
        ...base,
        type: "tool_end",
        toolCallId: String(data.toolCallId ?? ""),
        name: String(data.name ?? ""),
        success: data.success !== false,
        durationMs: Number(data.durationMs ?? 0),
        output: String(data.output ?? ""),
        ...(images.length ? { images } : {}),
      };
    }
    case "log":
      return {
        ...base,
        type: "log",
        level: String(data.level ?? "info"),
        source: String(data.source ?? "mma"),
        text: String(data.text ?? ""),
        diagnostic: data.diagnostic === true,
      };
    case "plan":
      return {
        ...base,
        type: "plan",
        steps: data.steps ?? [],
        currentIndex: data.currentIndex ?? 0,
      };
    case "meta":
      return {
        ...base,
        type: "meta",
        chunk: String(data.chunk ?? ""),
        ...(data.kind ? { kind: String(data.kind) } : {}),
      };
    case "retract":
      return {
        ...base,
        type: "retract",
        reason: String(data.reason ?? data.label ?? ""),
        label: String(data.label ?? ""),
        ...(data.source ? { source: String(data.source) } : {}),
        ...(data.iteration !== undefined ? { iteration: data.iteration } : {}),
        ...(data.verdict ? { verdict: String(data.verdict) } : {}),
      };
    case "critic":
      return {
        ...base,
        type: "critic",
        status: String(data.status ?? ""),
        durationMs: Number(data.durationMs ?? 0),
        passes: Number(data.passes ?? 0),
        issues: data.issues ?? [],
        checks: data.checks ?? [],
        ...(data.summary ? { summary: String(data.summary) } : {}),
        ...(data.timedOut ? { timedOut: true } : {}),
        ...(data.verdict ? { verdict: String(data.verdict) } : {}),
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
    case "subagent": {
      // Внутренний wire-объект стора несёт свои type/ts/sessionId — их
      // заменяет оболочка события.
      const fields = { ...data };
      delete fields.type;
      delete fields.ts;
      delete fields.sessionId;
      return { ...base, type: "subagent", ...fields };
    }
    default:
      return null;
  }
}

/**
 * URL'ы картинок тула для `tool_end`. Сохранённые refs (`imageRefs`) отдаются
 * адаптером из `/api/sessions/:id/images/:name`; inline data URL'ы — как есть.
 */
function toolImageUrls(
  ev: HostEvent,
  data: Record<string, unknown>,
): string[] {
  const refs = Array.isArray(data.imageRefs) ? data.imageRefs.map(String) : [];
  if (refs.length && ev.sessionId) {
    return refs.map(
      (file) => `/api/sessions/${encodeURIComponent(ev.sessionId!)}/images/${encodeURIComponent(file)}`,
    );
  }
  return Array.isArray(data.images) ? data.images.map(String) : [];
}
