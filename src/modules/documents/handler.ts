/**
 * Контракт обработчика формата (INV-D2): потребители знают только `DocumentHandler`,
 * конкретные `handlers/*` импортируются лишь из `registry.ts`.
 */
import type { Logger } from "../../logger/app-logger";
import type { DocumentIR } from "./ir";

/** Группа форматов — единица грубого включения/выключения в коде (INV-D3). */
export type HandlerGroup = "text" | "spreadsheet" | "office" | "pdf" | "image" | "geo";

/** Лимиты вывода, передаются обработчику (INV-D4). */
export interface DocLimits {
  maxLines: number;
  maxChars: number;
  maxTableRows: number;
}

/** Источник документа: путь + ленивое чтение байтов. */
export interface DocSource {
  /** Абсолютный путь — для чтения и для enforcement, не для сообщений модели. */
  path: string;
  /** Путь, как его задал пользователь (относительный) — только для сообщений. */
  display: string;
  ext: string;
  bytes(): Promise<Uint8Array>;
}

/** Контекст разбора. */
export interface ParseContext {
  logger: Logger;
  limits: DocLimits;
}

/** Обработчик формата. Потребители знают только DocumentHandler (INV-D2). */
export interface DocumentHandler {
  id: string;
  group: HandlerGroup;
  extensions: string[];
  mediaTypes?: string[];
  /** Проверка содержимого по первым байтам; при отсутствии — доверяем расширению. */
  detect?(head: Uint8Array): boolean;
  parse(ctx: ParseContext, source: DocSource): Promise<DocumentIR>;
}

/** Класс содержимого по magic-bytes (расширению доверяем только как подсказке). */
export function detectHead(head: Uint8Array): "zip" | "pdf" | "svg" | "unknown" {
  const b = head;
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05)) return "zip";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf";
  if (b[0] === 0x3c && (b[1] === 0x73 || b[1] === 0x53)) {
    // "<svg ..." или "<SVG" (проверяем первые 4 символа как ascii)
    const s = String.fromCharCode(...b.slice(0, 4)).toLowerCase();
    if (s.startsWith("<svg")) return "svg";
  }
  return "unknown";
}
