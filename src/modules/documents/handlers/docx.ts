/**
 * DOCX/DOCM → `DocumentIR` (группа office, INV-D2/D5).
 *
 * Часть `word/document.xml`, тело `w:body`. Абзац `w:p`:
 * - `w:pStyle @_w:val`, начинающийся с `Heading`/`heading` (например `Heading1`,
 *   `heading 1`) → блок `heading` (уровень из хвостовой цифры) + узел outline
 *   (`kind:"section"`);
 * - есть `w:numPr` → пункт списка (`ordered:false`: нумерация живёт в
 *   `numbering.xml`; определять маркированный/нумерованный по одному `numPr`
 *   нельзя — известное ограничение);
 * - иначе непустой текст → `paragraph`.
 * Таблица `w:tbl` → блок-таблица (строки `w:tr`, ячейки `w:tc`). Первый `Heading1`
 * → `meta.title`. Нет распознанного содержимого → `meta.degraded` (INV-D5).
 * Политику не реализует (INV-D6).
 *
 * **Известное ограничение (порядок блоков не сохраняется).** Парсер группирует
 * одноимённых детей под одним ключом, поэтому блоки выводятся по первому
 * появлению тега: `w:p w:tbl w:p` читается как `p p tbl`, а не в исходном
 * порядке. Альтернатива — `preserveOrder` у `fast-xml-parser` (отдельный полный
 * обход с сохранением порядка) — в этой волне осознанно не внедрена.
 */
import { boundTable } from "../bound";
import {
  detectHead,
  type DocLimits,
  type DocSource,
  type DocumentHandler,
  type ParseContext,
} from "../handler";
import { emptyIR, type DocTable, type DocumentIR } from "../ir";
import { asArray, attr, child, collectText, findAll, MAX_TABLE_COLS, readOoxml, tableHasContent } from "./ooxml";

/** Уровень заголовка из `w:pStyle`, либо `undefined` (не заголовок). */
function headingLevel(style: string | undefined): number | undefined {
  if (!style) return undefined;
  // `$` — иначе `HeadingChar`/`HeadingStyle` ложно считались бы заголовком.
  const m = /^heading\s*(\d+)?$/i.exec(style.trim());
  if (!m) return undefined;
  const n = m[1] ? Number.parseInt(m[1], 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Стиль абзаца `w:pPr/w:pStyle @_w:val`. */
function paragraphStyle(p: unknown): string | undefined {
  return attr(child(child(p, "w:pPr"), "w:pStyle"), "w:val");
}

/** Абзац помечен как элемент списка (`w:pPr/w:numPr`). */
function isListItem(p: unknown): boolean {
  return child(child(p, "w:pPr"), "w:numPr") !== undefined;
}

/** Текст абзаца — склейка всех `w:t` (через `collectText`). */
function paragraphText(p: unknown): string {
  return collectText(p).trim();
}

/** Текст ячейки: абзацы `w:p` через перевод строки (как `cellText` в ODF). */
function cellText(tc: unknown): string {
  return findAll(tc, "w:p")
    .map((p) => collectText(p).trim())
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * Таблица `w:tbl` → заголовок (первая строка) + строки, обрезанные по лимиту.
 * Строки собираются не более `maxTableRows + 1` (заголовок + одна лишняя для
 * детекта `truncated`), колонки — до `MAX_TABLE_COLS`: cap во время разбора, а
 * не после материализации (INV-D4).
 */
function readTable(tbl: unknown, limits: DocLimits): DocTable {
  const rowCap = limits.maxTableRows + 1; // заголовок + строки данных
  const all: string[][] = [];
  let truncated = false;
  for (const tr of asArray(child(tbl, "w:tr"))) {
    if (all.length >= rowCap) {
      truncated = true;
      break;
    }
    const cells: string[] = [];
    for (const tc of asArray(child(tr, "w:tc"))) {
      if (cells.length >= MAX_TABLE_COLS) {
        truncated = true; // колонка за пределом — отбрасываем ячейку
        break;
      }
      cells.push(cellText(tc));
    }
    all.push(cells);
  }
  const header = all.shift() ?? [];
  const rows = all.slice(0, limits.maxTableRows);
  return { header, rows, ...(truncated ? { truncated: true } : {}) };
}

/** Обработчик DOCX/DOCM (группа office). */
export const docxHandler: DocumentHandler = {
  id: "docx",
  group: "office",
  extensions: [".docx", ".docm"],
  mediaTypes: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-word.document.macroEnabled.12",
  ],
  detect: (h) => detectHead(h) === "zip",
  async parse(ctx: ParseContext, source: DocSource): Promise<DocumentIR> {
    const bytes = await source.bytes();
    const ir = emptyIR("docx", bytes.length);
    ir.meta.title = source.display;
    const doc = readOoxml(bytes).xml("word/document.xml");
    if (doc === undefined) {
      ir.meta.degraded = { reason: "в пакете нет word/document.xml" };
      return ir;
    }
    const body = child(child(doc, "w:document"), "w:body");
    const obj = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};

    let list: string[] | null = null;
    let emitted = 0;
    let titleSet = false;
    let sect = 0;
    const flushList = (): void => {
      if (list && list.length) {
        ir.blocks.push({ kind: "list", ordered: false, items: list });
        emitted++;
      }
      list = null;
    };

    // Парсер группирует одноимённых детей под одним ключом (порядок ключей —
    // порядок первого появления): внутри группы порядок сохраняется, между
    // разными тегами — по первому вхождению (известное ограничение).
    for (const [key, value] of Object.entries(obj)) {
      if (key === "w:p") {
        for (const p of asArray(value)) {
          const text = paragraphText(p);
          const level = headingLevel(paragraphStyle(p));
          if (level !== undefined) {
            flushList();
            if (!text) continue;
            ir.blocks.push({ kind: "heading", level, text });
            ir.outline.push({ id: `h${sect++}`, level, title: text, kind: "section" });
            emitted++;
            if (level === 1 && !titleSet) {
              ir.meta.title = text;
              titleSet = true;
            }
            continue;
          }
          if (isListItem(p)) {
            if (text) (list ??= []).push(text);
            continue;
          }
          flushList();
          if (text) {
            ir.blocks.push({ kind: "paragraph", text });
            emitted++;
          }
        }
      } else if (key === "w:tbl") {
        for (const tbl of asArray(value)) {
          flushList();
          const table = readTable(tbl, ctx.limits);
          if (!tableHasContent(table)) continue;
          ir.blocks.push({ kind: "table", table: boundTable(table, ctx.limits) });
          emitted++;
        }
      }
    }
    flushList();
    if (emitted === 0) ir.meta.degraded = { reason: "в документе нет распознанного текста" };
    return ir;
  },
};
