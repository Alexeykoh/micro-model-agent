// Чистые builders записей session-журнала для сообщений, вызовов тулов и
// событий гейтов. Держат SessionLogger ≤300 (правило 6) и не дают формату
// события расползтись по нескольким файлам.
import type { SessionLogEntry } from "../modules/session/log-types";
import type { ToolImageRef } from "../modules/session/image-store";
import { redactContextSecrets } from "./agent/context-log";
import { sanitizeLogMessageTargeted } from "../modules/security/data-sanitizer";
import type { ToolCall } from "./types";

type LogEntry = Omit<SessionLogEntry, "ts" | "source">;

/** Активный провайдер/модель на момент записи (provenance). */
export interface LogCaller {
  provider?: string;
  model?: string;
}

/** `system`: системное сообщение (секреты вырезаны). */
export function systemEntry(content: string): LogEntry {
  return { type: "system", content: redactContextSecrets(content) };
}

/** `tool_defs`: состав тулов итерации для пост-анализа. */
export function toolDefsEntry(toolCount: number, toolNames: string[], iteration: number): LogEntry {
  return { type: "tool_defs", toolCount, toolNames, iteration };
}

/** `user`: санитизированный текст и ref'ы приложенных картинок. */
export function userEntry(content: string, imageRefs?: ToolImageRef[]): LogEntry {
  return {
    type: "user",
    content,
    ...(imageRefs?.length ? { images: imageRefs } : {}),
  };
}

/**
 * `reasoning` (если есть) + `assistant` с токенами/провайдером/финишем.
 * Два события на один ответ — в этом же порядке.
 */
export function assistantEntries(
  content: string,
  reasoning: string | undefined,
  toolCalls: ToolCall[] | undefined,
  iteration: number | undefined,
  finish: string | undefined,
  caller: LogCaller | undefined,
): LogEntry[] {
  const entries: LogEntry[] = [];
  if (reasoning) {
    entries.push({
      type: "reasoning",
      content: redactContextSecrets(reasoning),
      iteration,
      provider: caller?.provider,
      model: caller?.model,
    });
  }
  entries.push({
    type: "assistant",
    content: redactContextSecrets(content),
    ...(toolCalls
      ? {
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          })),
        }
      : {}),
    iteration,
    provider: caller?.provider,
    model: caller?.model,
    ...(finish ? { finish } : {}),
  });
  return entries;
}

/**
 * Сериализует аргументы тула для лога. Санитайзер может испортить JSON
 * (например, режет закрывающую кавычку в `password=secret"`), поэтому при
 * ошибке парсинга пишем сырую санитизированную строку и предупреждаем —
 * запись tool_call не должна теряться.
 */
export function sanitizeToolArgs(
  args: unknown,
  warn?: (message: string) => void,
): Record<string, unknown> {
  const raw = JSON.stringify(args ?? {});
  const sanitized = sanitizeLogMessageTargeted(raw);
  try {
    const parsed: unknown = JSON.parse(sanitized);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { raw: sanitized };
  } catch {
    warn?.(`tool_call args sanitization broke JSON; storing raw string (${raw.length} chars)`);
    return { raw: sanitized };
  }
}

/** `tool_call`: имя, id, санитизированные аргументы, итерация. */
export function toolCallEntry(
  call: ToolCall,
  iteration: number,
  args: Record<string, unknown>,
): LogEntry {
  return {
    type: "tool_call",
    tool: call.name,
    tool_call_id: call.id,
    args,
    iteration,
  };
}

/** `tool_result`: успех, усечённый вывод, diff, ref'ы картинок, длительность. */
export function toolResultEntry(
  call: ToolCall,
  result: { success: boolean; output: string; diff?: string },
  duration: number,
  iteration: number,
  imageRefs: ToolImageRef[] | undefined,
  caller: LogCaller | undefined,
): LogEntry {
  return {
    type: "tool_result",
    tool: call.name,
    tool_call_id: call.id,
    success: result.success,
    content: sanitizeLogMessageTargeted(result.output.slice(0, 1000)),
    diff: result.diff,
    ...(imageRefs?.length ? { images: imageRefs } : {}),
    duration,
    iteration,
    provider: caller?.provider,
    model: caller?.model,
  };
}

/** `audit`: вердикт финального аудита; `tests` — пометка тест-прогона (INV-15). */
export function auditEntry(
  summary: string,
  iteration: number,
  durationMs?: number,
  tests?: string,
): LogEntry {
  return {
    type: "audit",
    content: summary,
    iteration,
    duration: durationMs,
    ...(tests ? { tests } : {}),
  };
}

/** `reasoning_control`: уровень и источник решения политики. */
export function reasoningControlEntry(data: {
  iteration: number;
  level: string;
  strategy?: string;
  probePassed?: boolean;
  source?: string;
}): LogEntry {
  return {
    type: "reasoning_control",
    content: `reasoning level: ${data.level} (source: ${data.source ?? "policy"})`,
    iteration: data.iteration,
    level: data.level,
    strategy: data.strategy,
    probePassed: data.probePassed,
    origin: data.source,
  };
}

/** `claim_retry`: отклонение уже отстримленного черновика гейтом. */
export function claimRetryEntry(data: {
  kind: string;
  reason: string;
  iteration: number;
}): LogEntry {
  return {
    type: "claim_retry",
    content: data.reason,
    kind: data.kind,
    iteration: data.iteration,
  };
}

/** `onboarding_*`: события meet/init для пост-анализа. */
export function onboardingEntry(
  event: "meet_start" | "meet_done" | "init_start" | "init_done",
  data: Record<string, unknown>,
): LogEntry {
  return {
    type: `onboarding_${event}`,
    content: event,
    ...data,
  };
}

/** `critic_*`: событие контр-агента; `summary` становится `content`. */
export function criticEntry(
  event: "critic_check" | "critic_verdict" | "critic_escalation",
  data: Record<string, unknown>,
): LogEntry {
  return {
    type: event,
    content: (data.summary as string) ?? event,
    ...data,
  };
}
