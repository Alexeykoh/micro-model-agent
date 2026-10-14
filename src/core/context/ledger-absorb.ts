// src/core/context/ledger-absorb.ts
// Сбор адресов/записей леджеров из удаляемых сообщений компакции (OO-3/OO-8).
// Вынесено из ContextManager, чтобы не растить manager.ts (правило ≤300 строк).
import { getMessageText } from "../../llm/provider";
import type { ContextLedger } from "./ledger";
import { addressesFromToolResult } from "./ledger-parse";
import type { Message } from "./manager";

/** Потолок строк леджера тулов в сводке компакции. */
const TOOL_LEDGER_MAX_ENTRIES = 12;

/** OO-8: успешные записи/правки этих тулов помечают адреса файла stale. */
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

/** Краткая сигнатура аргументов тула (`ключ1, ключ2, ключ3`). */
export function summarizeArgs(args: unknown): string {
  if (!args) return "";
  if (typeof args === "string") return args.slice(0, 80);
  try {
    const keys = Object.keys(args as Record<string, unknown>);
    return keys.slice(0, 3).join(", ");
  } catch {
    return String(args).slice(0, 80);
  }
}

/** Первая непустая строка результата (digest для леджера тулов). */
function firstLine(text: string): string {
  return text
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean) ?? "";
}

/**
 * Пополняет durable леджер адресов из УСПЕШНЫХ результатов тулов (OO-3) и леджер
 * тулов из удаляемых сообщений. Адреса пишутся всегда — леджер durable и от
 * режима сводки не зависит; строка леджера тулов — только при `summaryOn`.
 */
export function absorbLedgers(
  messages: Message[],
  ledger: ContextLedger | null,
  summaryOn: boolean,
  toolLedger: string[],
  toolLedgerKeys: Set<string>,
): void {
  for (const m of messages) {
    if (m.role !== "tool" || !m.name) continue;
    const text = typeof m.content === "string" ? m.content : getMessageText(m.content);
    if (ledger && m.success !== false) {
      const args = (m.arguments ?? {}) as Record<string, unknown>;
      for (const a of addressesFromToolResult(m.name, args, text)) {
        ledger.record(a.address, a.note);
      }
    }
    if (!summaryOn) continue;
    const args = summarizeArgs(m.arguments);
    const key = `${m.name}:${args}`;
    if (toolLedgerKeys.has(key)) continue;
    const line = firstLine(text);
    toolLedgerKeys.add(key);
    toolLedger.push(`- ${m.name}(${args})${line ? ` → ${line.slice(0, 120)}` : ""}`);
  }
  if (toolLedger.length > TOOL_LEDGER_MAX_ENTRIES) {
    toolLedger.splice(0, toolLedger.length - TOOL_LEDGER_MAX_ENTRIES);
  }
}

/**
 * OO-3/OO-8: наблюдает УСПЕШНЫЙ tool-результат в момент входа в историю.
 * Записывает адреса-находки из СЫРОГО контента (до возможной чистки
 * `pruneStaleToolResults`, которая обнулила бы `path:line`) и помечает
 * изменённый записью файл stale. `record` идемпотентен (дедуп по адресу).
 */
export function observeToolResult(ledger: ContextLedger | null, msg: Message): void {
  if (!ledger || msg.role !== "tool" || msg.success === false || !msg.name) return;
  const text = typeof msg.content === "string" ? msg.content : getMessageText(msg.content);
  const args = (msg.arguments ?? {}) as Record<string, unknown>;
  for (const a of addressesFromToolResult(msg.name, args, text)) {
    ledger.record(a.address, a.note);
  }
  if (WRITE_TOOLS.has(msg.name)) {
    const touched = args.path;
    if (typeof touched === "string" && touched) ledger.markStale(touched);
  }
}
