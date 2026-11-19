// Экспорт сессий: чистые форматтеры md/json/jsonl (без IO, тестируемы без диска).
import type { SessionMeta, SessionMessage } from "./types";
import type { SessionLogEntry } from "./store";
import { getMessageText } from "../../llm/provider";
import { redactContextSecrets } from "../../core/api";

/**
 * Чистые форматтеры экспорта для `session export` / `/export`. IO и пути —
 * в слое команд; функции лишь превращают данные сессии в текст и тестируются
 * без диска.
 */

/** Формат экспорта. */
export type ExportFormat = "md" | "json" | "jsonl";

/** Пакет данных для экспорта: мета, сообщения, журнал. */
export interface ExportBundle {
  meta: SessionMeta | null;
  messages: SessionMessage[];
  log: SessionLogEntry[];
}

/** `--compact`: человекочитаемый экспорт без дампов результатов тулов. */
export interface ExportOptions {
  compact?: boolean;
}

function roleHeading(role: string): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool";
    case "system":
      return "System";
    default:
      return role;
  }
}

/** Отрендерить сессию в Markdown. */
export function renderSessionMarkdown(
  meta: SessionMeta | null,
  messages: SessionMessage[],
  opts?: ExportOptions,
): string {
  const lines: string[] = [];
  const name = meta?.name ?? "session";
  const id = meta?.id ?? "unknown";
  lines.push(`# ${name} (${id})`);
  lines.push("");
  if (meta) {
    lines.push(`- Model: ${meta.model}`);
    lines.push(`- Created: ${meta.createdAt}`);
    lines.push(`- Updated: ${meta.updatedAt}`);
    lines.push(`- Messages: ${meta.messageCount}`);
    if (meta.projectDir) lines.push(`- Project: ${meta.projectDir}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const msg of messages) {
    appendMessageLines(lines, msg, opts);
  }

  return lines.join("\n");
}

function appendMessageLines(lines: string[], msg: SessionMessage, opts?: ExportOptions): void {
  // Compact режет тела tool-результатов (основной объём длинных сессий);
  // однострочники `- tool_call:` на ходах ассистента показывают, что запускалось.
  if (opts?.compact && msg.role === "tool") return;
  const heading = roleHeading(msg.role);
  const nameSuffix = msg.name ? ` (${msg.name})` : "";
  lines.push(`## ${heading}${nameSuffix}`);
  lines.push("");
  const text = getMessageText(msg.content);
  lines.push(text.length > 0 ? text : "_(empty)_");
  lines.push("");
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      lines.push(`- tool_call: \`${tc.function.name}\` ${tc.function.arguments}`);
    }
    lines.push("");
  }
}

/** Собрать JSON-экспорт сессии. */
export function buildSessionJson(
  meta: SessionMeta | null,
  messages: SessionMessage[],
  opts?: ExportOptions,
): string {
  const list = opts?.compact ? messages.filter((m) => m.role !== "tool") : messages;
  return JSON.stringify({ meta, messages: list }, null, 2);
}

/** Объёмные снапшот-записи, выкидываемые --compact (для чтения человеком). */
const COMPACT_JSONL_DROP = new Set(["context", "tool_defs", "tool_result", "llm_usage"]);

/** Собрать JSONL-экспорт из журнала. */
export function buildSessionJsonl(log: SessionLogEntry[], opts?: ExportOptions): string {
  const list = opts?.compact ? log.filter((e) => !COMPACT_JSONL_DROP.has(e.type)) : log;
  return list.map((e) => JSON.stringify(e)).join("\n");
}

/** Отформатировать пакет в заданном формате. */
export function formatExport(
  bundle: ExportBundle,
  format: ExportFormat,
  opts?: ExportOptions,
): string {
  switch (format) {
    case "md":
      return renderSessionMarkdown(bundle.meta, bundle.messages, opts);
    case "json":
      return buildSessionJson(bundle.meta, bundle.messages, opts);
    case "jsonl":
      return buildSessionJsonl(bundle.log, opts);
  }
}

/** Вычистить секреты из экспорта, если не отключено. */
export function redactExport(text: string, redact: boolean): string {
  return redact ? redactContextSecrets(text) : text;
}

/** Санитизировать имя сессии под имя файла. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 60) : "session";
}

/** Расширение файла под формат. */
export function extensionFor(format: ExportFormat): string {
  return format === "jsonl" ? "jsonl" : format;
}
