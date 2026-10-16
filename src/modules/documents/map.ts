/**
 * Карта документа: мета + оглавление + счётчики блоков/таблиц/фигур (INV-D4).
 * Формат-агностично — работает с любым `DocumentIR`. Итоговая строка ограничена
 * `boundText` независимо от обработчика (INV-D4): огромный outline не проходит целиком.
 */
import { boundText, DEFAULT_DOC_LIMITS } from "./bound";
import type { DocumentIR } from "./ir";

/** Человекочитаемая «карта» документа: мета + оглавление + счётчики (INV-D4). */
export function renderDocumentMap(ir: DocumentIR): string {
  const tables = ir.blocks.filter((b) => b.kind === "table").length;
  const figures = ir.blocks.filter((b) => b.kind === "figure").length;
  const head = [
    `format: ${ir.meta.format}`,
    ir.meta.title ? `title: ${ir.meta.title}` : null,
    ir.meta.pages ? `pages: ${ir.meta.pages}` : null,
    ir.meta.sheets?.length ? `sheets: ${ir.meta.sheets.join(", ")}` : null,
    `blocks: ${ir.blocks.length} · tables: ${tables} · figures: ${figures}`,
    ir.meta.degraded ? `degraded: ${ir.meta.degraded.reason}` : null,
  ].filter(Boolean);
  const outline = ir.outline
    .map((n) => `${"  ".repeat(Math.max(0, n.level - 1))}- ${n.title}`)
    .join("\n");
  return boundText(`${head.join("\n")}\n\n${outline}`.trim(), DEFAULT_DOC_LIMITS);
}
