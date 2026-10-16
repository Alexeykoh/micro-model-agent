/**
 * ODT → `DocumentIR` (группа office, INV-D2/D5).
 *
 * `content.xml` → `office:body/office:text`: `text:h` (уровень из
 * `@_text:outline-level`) → блок-heading + узел outline (`kind:"section"`);
 * `text:p` → `paragraph`; `text:list`/`text:list-item` → `list` (`ordered:false`:
 * нумерация ODF-списков задаётся стилем, вне объёма); `table:table` → блок-таблица.
 * Первый `text:h` уровня 1 → `meta.title`. Нет распознанного содержимого →
 * `meta.degraded` (INV-D5). Политику не реализует (INV-D6).
 *
 * **Известное ограничение (порядок блоков не сохраняется).** Парсер группирует
 * одноимённых детей под одним ключом, поэтому блоки выводятся по первому
 * появлению тега: последовательность `h p h p` читается как `h h p p`, а не в
 * исходном порядке. Альтернатива — `preserveOrder` у `fast-xml-parser` (отдельный
 * полный обход с сохранением порядка) — в этой волне осознанно не внедрена.
 */
import { boundTable } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR, type DocumentIR } from "../ir";
import {
  odfBody,
  odfHeadingLevel,
  odfListItems,
  odfTableName,
  odfText,
  readOdfContent,
  readOdfTable,
} from "./odf";
import { asArray, child, tableHasContent } from "./ooxml";

/** Обработчик ODT (группа office). */
export const odtHandler: DocumentHandler = {
  id: "odt",
  group: "office",
  extensions: [".odt", ".fodt"],
  mediaTypes: ["application/vnd.oasis.opendocument.text"],
  detect: (h) => detectHead(h) === "zip",
  async parse(ctx: ParseContext, source: DocSource): Promise<DocumentIR> {
    const bytes = await source.bytes();
    const ir = emptyIR("odt", bytes.length);
    ir.meta.title = source.display;
    const content = readOdfContent(bytes);
    if (content === undefined) {
      ir.meta.degraded = { reason: "в пакете нет content.xml" };
      return ir;
    }
    const body = child(odfBody(content), "office:text");
    const obj = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};

    let emitted = 0;
    let titleSet = false;
    let sect = 0;
    // Порядок ключей — порядок первого появления тега (ограничение парсера):
    // внутри группы узлы идут по документу, между группами — по первому вхождению.
    for (const [key, value] of Object.entries(obj)) {
      if (key === "text:h") {
        for (const node of asArray(value)) {
          const text = odfText(node);
          if (!text) continue;
          const level = odfHeadingLevel(node);
          ir.blocks.push({ kind: "heading", level, text });
          ir.outline.push({ id: `h${sect++}`, level, title: text, kind: "section" });
          emitted++;
          if (level === 1 && !titleSet) {
            ir.meta.title = text;
            titleSet = true;
          }
        }
      } else if (key === "text:p") {
        for (const node of asArray(value)) {
          const text = odfText(node);
          if (!text) continue;
          ir.blocks.push({ kind: "paragraph", text });
          emitted++;
        }
      } else if (key === "text:list") {
        for (const node of asArray(value)) {
          const items = odfListItems(node);
          if (!items.length) continue;
          ir.blocks.push({ kind: "list", ordered: false, items });
          emitted++;
        }
      } else if (key === "table:table") {
        for (const node of asArray(value)) {
          const grid = readOdfTable(node, ctx.limits);
          if (!tableHasContent(grid)) continue;
          ir.blocks.push({
            kind: "table",
            table: boundTable(
              {
                caption: odfTableName(node),
                header: grid.header,
                rows: grid.rows,
                truncated: grid.truncated,
              },
              ctx.limits,
            ),
          });
          emitted++;
        }
      }
    }
    if (emitted === 0) ir.meta.degraded = { reason: "в документе нет распознанного текста" };
    return ir;
  },
};
