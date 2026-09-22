import type { SessionMeta, SessionMessage } from "./types";
import type { SessionLogEntry } from "./store";
import { getMessageText } from "../../llm/provider";
import { redactContextSecrets } from "../../core/agent/context-log";

/**
 * Pure export formatters for `session export` / `/export`. IO and paths live
 * in the command layer; these functions only turn session data into text and
 * are unit-testable without touching disk.
 */

export type ExportFormat = "md" | "json" | "jsonl";

export interface ExportBundle {
  meta: SessionMeta | null;
  messages: SessionMessage[];
  log: SessionLogEntry[];
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

export function renderSessionMarkdown(meta: SessionMeta | null, messages: SessionMessage[]): string {
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

  return lines.join("\n");
}

export function buildSessionJson(meta: SessionMeta | null, messages: SessionMessage[]): string {
  return JSON.stringify({ meta, messages }, null, 2);
}

export function buildSessionJsonl(log: SessionLogEntry[]): string {
  return log.map((e) => JSON.stringify(e)).join("\n");
}

export function formatExport(bundle: ExportBundle, format: ExportFormat): string {
  switch (format) {
    case "md":
      return renderSessionMarkdown(bundle.meta, bundle.messages);
    case "json":
      return buildSessionJson(bundle.meta, bundle.messages);
    case "jsonl":
      return buildSessionJsonl(bundle.log);
  }
}

/** Apply secret redaction to an export unless disabled. */
export function redactExport(text: string, redact: boolean): string {
  return redact ? redactContextSecrets(text) : text;
}

/** Sanitize a session name for use as a file name. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 60) : "session";
}

export function extensionFor(format: ExportFormat): string {
  return format === "jsonl" ? "jsonl" : format;
}
