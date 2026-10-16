/**
 * ODS → `DocumentIR` (группа spreadsheet, INV-D2/D5).
 *
 * `content.xml` → `office:body/office:spreadsheet`: каждая `table:table` — лист.
 * На лист: блок-таблица (`boundTable`, заголовок — первая строка) + узел outline
 * (`kind:"sheet"`, имя из `@_table:name`). Нет `content.xml`/таблиц/содержимого →
 * `meta.degraded` (INV-D5), без исключения. Политику не реализует (INV-D6).
 */
import { boundTable } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR, type DocumentIR } from "../ir";
import {
  odfBody,
  odfTableHasContent,
  odfTableName,
  readOdfContent,
  readOdfTable,
} from "./odf";
import { child, findAll } from "./ooxml";

/** Обработчик ODS (группа spreadsheet). */
export const odsHandler: DocumentHandler = {
  id: "ods",
  group: "spreadsheet",
  extensions: [".ods"],
  mediaTypes: ["application/vnd.oasis.opendocument.spreadsheet"],
  detect: (h) => detectHead(h) === "zip",
  async parse(ctx: ParseContext, source: DocSource): Promise<DocumentIR> {
    const bytes = await source.bytes();
    const ir = emptyIR("ods", bytes.length);
    ir.meta.title = source.display;
    const content = readOdfContent(bytes);
    if (content === undefined) {
      ir.meta.degraded = { reason: "в пакете нет content.xml" };
      return ir;
    }
    const tables = findAll(child(odfBody(content), "office:spreadsheet"), "table:table");
    const names = tables.map((t, i) => odfTableName(t) ?? `Sheet${i + 1}`);
    ir.meta.sheets = names;
    let emitted = 0;
    tables.forEach((node, i) => {
      const name = names[i];
      const grid = readOdfTable(node, ctx.limits);
      if (!odfTableHasContent(grid)) return; // пустая таблица не даёт пустого блока (INV-D5)
      emitted++;
      ir.outline.push({ id: `sheet:${name}`, level: 1, title: name, kind: "sheet" });
      ir.blocks.push({
        kind: "table",
        table: boundTable(
          { caption: name, header: grid.header, rows: grid.rows, truncated: grid.truncated },
          ctx.limits,
        ),
      });
    });
    if (tables.length === 0) ir.meta.degraded = { reason: "в документе нет таблиц" };
    else if (emitted === 0) ir.meta.degraded = { reason: "все таблицы пусты" };
    return ir;
  },
};
