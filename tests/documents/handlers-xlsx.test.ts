import { describe, expect, it } from "vitest";
import { DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";
import { xlsxHandler } from "../../src/modules/documents/handlers/xlsx";
import type { Logger } from "../../src/logger/app-logger";
import { buildXlsx } from "./fixtures-xlsx";
import { buildZip } from "./fixtures-zip";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = (limits = DEFAULT_DOC_LIMITS) => ({ logger, limits });
const src = (bytes: Uint8Array, display = "book.xlsx") => ({
  path: display,
  display,
  ext: ".xlsx",
  bytes: async () => bytes,
});

describe("xlsxHandler", () => {
  it("лист → заголовок таблицы, строки и outline kind=sheet", async () => {
    const bytes = buildXlsx([{ name: "Sheet1", rows: [["Name", "Age"], ["Alice", 30]] }]);
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    expect(ir.meta.format).toBe("xlsx");
    expect(ir.meta.title).toBe("book.xlsx");
    expect(ir.meta.sheets).toEqual(["Sheet1"]);
    expect(ir.meta.bytes).toBe(bytes.length);
    expect(ir.outline).toEqual([{ id: "sheet:Sheet1", level: 1, title: "Sheet1", kind: "sheet" }]);
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.caption).toBe("Sheet1");
    expect(block.table.header).toEqual(["Name", "Age"]);
    expect(block.table.rows).toEqual([["Alice", "30"]]);
    expect(block.table.range).toBe("A1:B2");
  });

  it("несколько листов — порядок из workbook.xml", async () => {
    const bytes = buildXlsx([
      { name: "Data", rows: [["x"], ["1"]] },
      { name: "Summary", rows: [["total"], ["9"]] },
    ]);
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    expect(ir.meta.sheets).toEqual(["Data", "Summary"]);
    expect(ir.outline.map((n) => n.kind)).toEqual(["sheet", "sheet"]);
    expect(ir.blocks.map((b) => (b.kind === "table" ? b.table.caption : null))).toEqual(["Data", "Summary"]);
  });

  it("inlineStr-ячейки читаются как литералы", async () => {
    const bytes = buildXlsx([{ name: "S", rows: [["a", "b"], ["c", "d"]], inline: true }]);
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.header).toEqual(["a", "b"]);
    expect(block.table.rows).toEqual([["c", "d"]]);
  });

  it("строки выравниваются по ширине листа (прямоугольные строки)", async () => {
    const bytes = buildXlsx([{ name: "S", rows: [["a", "b", "c"], ["1", "3"]] }]);
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.rows).toEqual([["1", "3", ""]]);
    expect(block.table.range).toBe("A1:C2");
  });

  it("пропуск ячейки в середине строки заполняется пустой", async () => {
    const bytes = buildXlsx([{ name: "S", rows: [["a", "b", "c"], ["1", null, "3"]] }]);
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.rows).toEqual([["1", "", "3"]]);
  });

  it("превышение maxTableRows → truncated, строки обрезаны", async () => {
    const rows: Array<Array<string | number>> = [["h"]];
    for (let i = 0; i < 5; i++) rows.push([i]);
    const bytes = buildXlsx([{ name: "S", rows }]);
    const ir = await xlsxHandler.parse(ctx({ ...DEFAULT_DOC_LIMITS, maxTableRows: 2 }), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.truncated).toBe(true);
    expect(block.table.rows).toHaveLength(2);
  });

  it("архив без worksheet-частей → degraded, без исключения (INV-D5)", async () => {
    const bytes = buildZip([{ name: "hello.txt", data: "not a workbook" }]);
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    expect(ir.meta.degraded?.reason).toBeTruthy();
    expect(ir.blocks).toEqual([]);
  });

  it("deflated-книга (метод 8) читается так же, как stored", async () => {
    const bytes = buildXlsx([{ name: "Sheet1", rows: [["Name", "Age"], ["Alice", 30]] }], {
      deflate: true,
    });
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.header).toEqual(["Name", "Age"]);
    expect(block.table.rows).toEqual([["Alice", "30"]]);
    expect(block.table.range).toBe("A1:B2");
  });

  it("дальняя ячейка (XFD) не раздувает сетку: колонки ограничены, truncated (INV-D4)", async () => {
    const bytes = buildXlsx([
      {
        name: "S",
        rows: [["h"], ["1"]],
        extraCells: [{ ref: "XFD2", xml: '<c r="XFD2"><v>7</v></c>' }],
      },
    ]);
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.rows[0]).toEqual(["1"]); // XFD отброшен, сетка не выросла
    expect(block.table.truncated).toBe(true);
    expect(block.table.range).toBe("A1:XFD2"); // честный диапазон
  });

  it("ячейка в колонке за Z (AA) встаёт по colIndex", async () => {
    const bytes = buildXlsx([
      {
        name: "S",
        rows: [["a"]],
        extraCells: [{ ref: "AA1", xml: '<c r="AA1"><v>9</v></c>' }],
      },
    ]);
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.header).toHaveLength(27);
    expect(block.table.header[0]).toBe("a");
    expect(block.table.header[26]).toBe("9");
    expect(block.table.range).toBe("A1:AA1");
  });

  it("t=\"s\" без <v> не подставляет shared[0] (пустая ячейка)", async () => {
    const bytes = buildXlsx([
      { name: "S", rows: [["h"]], extraCells: [{ ref: "A2", xml: '<c r="A2" t="s"/>' }] },
    ]);
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.rows[0][0]).toBe(""); // было бы "h" при Number("")===0
  });

  it("t=\"s\" при отсутствующем sharedStrings.xml → пусто, без падения", async () => {
    const bytes = buildXlsx(
      [{ name: "S", rows: [[1]], extraCells: [{ ref: "B1", xml: '<c r="B1" t="s"><v>0</v></c>' }] }],
      { skipSharedStrings: true },
    );
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.header).toEqual(["1", ""]);
  });

  it("лист только с заголовком даёт пустые строки", async () => {
    const bytes = buildXlsx([{ name: "S", rows: [["Name", "Age"]] }]);
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.header).toEqual(["Name", "Age"]);
    expect(block.table.rows).toEqual([]);
    expect(block.table.range).toBe("A1:B1");
  });

  it("формульная ячейка t=\"str\" и boolean t=\"b\" читаются из <v>", async () => {
    const bytes = buildXlsx([
      {
        name: "S",
        rows: [[1]],
        extraCells: [
          { ref: "B1", xml: '<c r="B1" t="str"><f>1+1</f><v>2</v></c>' },
          { ref: "C1", xml: '<c r="C1" t="b"><v>1</v></c>' },
        ],
      },
    ]);
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.header).toEqual(["1", "2", "1"]);
  });

  it("пустой лист не даёт пустой таблицы, но не теряется из meta.sheets", async () => {
    const bytes = buildXlsx([
      { name: "Data", rows: [["x"], ["1"]] },
      { name: "Empty", rows: [] },
    ]);
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    expect(ir.meta.sheets).toEqual(["Data", "Empty"]);
    expect(ir.outline.map((n) => n.title)).toEqual(["Data"]);
    expect(ir.blocks).toHaveLength(1);
    expect(ir.meta.degraded).toBeUndefined();
  });

  it("все листы пусты → degraded с причиной (INV-D5)", async () => {
    const bytes = buildXlsx([{ name: "Empty", rows: [] }]);
    const ir = await xlsxHandler.parse(ctx(), src(bytes));
    expect(ir.meta.degraded?.reason).toBeTruthy();
    expect(ir.blocks).toEqual([]);
  });

  it("detect проходит только на ZIP-magic", () => {
    expect(xlsxHandler.detect?.(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(xlsxHandler.detect?.(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(false);
  });
});
