import { describe, expect, it } from "vitest";
import { DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";
import { odfHeadingLevel } from "../../src/modules/documents/handlers/odf";
import { odsHandler } from "../../src/modules/documents/handlers/ods";
import type { Logger } from "../../src/logger/app-logger";
import { buildOds } from "./fixtures-odf";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = (limits = DEFAULT_DOC_LIMITS) => ({ logger, limits });
const src = (bytes: Uint8Array, display = "sheet.ods") => ({
  path: display,
  display,
  ext: ".ods",
  bytes: async () => bytes,
});

describe("odsHandler", () => {
  it("таблица → заголовок/строки и outline kind=sheet", async () => {
    const bytes = buildOds([
      {
        name: "Data",
        rows: [
          { cells: [{ text: "Name" }, { text: "Age" }] },
          { cells: [{ text: "Alice" }, { text: "30" }] },
        ],
      },
    ]);
    const ir = await odsHandler.parse(ctx(), src(bytes));
    expect(ir.meta.format).toBe("ods");
    expect(ir.meta.title).toBe("sheet.ods");
    expect(ir.meta.sheets).toEqual(["Data"]);
    expect(ir.outline).toEqual([{ id: "sheet:Data", level: 1, title: "Data", kind: "sheet" }]);
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.caption).toBe("Data");
    expect(block.table.header).toEqual(["Name", "Age"]);
    expect(block.table.rows).toEqual([["Alice", "30"]]);
  });

  it("несколько таблиц — порядок и meta.sheets", async () => {
    const bytes = buildOds([
      { name: "A", rows: [{ cells: [{ text: "x" }] }] },
      { name: "B", rows: [{ cells: [{ text: "y" }] }] },
    ]);
    const ir = await odsHandler.parse(ctx(), src(bytes));
    expect(ir.meta.sheets).toEqual(["A", "B"]);
    expect(ir.outline.map((n) => n.title)).toEqual(["A", "B"]);
    expect(ir.blocks.map((b) => (b.kind === "table" ? b.table.caption : null))).toEqual(["A", "B"]);
  });

  it("повтор колонок/строк разворачивается (number-*-repeated)", async () => {
    const bytes = buildOds([
      {
        name: "R",
        rows: [
          { cells: [{ text: "h" }, { text: "x", colsRepeated: 2 }] },
          { cells: [{ text: "v" }], rowsRepeated: 3 },
        ],
      },
    ]);
    const ir = await odsHandler.parse(ctx(), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.header).toEqual(["h", "x", "x"]);
    expect(block.table.rows).toEqual([["v"], ["v"], ["v"]]);
  });

  it("строки внутри table:table-header-rows/table:table-rows читаются (не теряются)", async () => {
    const bytes = buildOds([
      {
        name: "H",
        headerRows: [{ cells: [{ text: "Name" }, { text: "Age" }] }],
        rows: [{ cells: [{ text: "Alice" }, { text: "30" }] }],
        wrapBody: true,
      },
    ]);
    const ir = await odsHandler.parse(ctx(), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.header).toEqual(["Name", "Age"]);
    expect(block.table.rows).toEqual([["Alice", "30"]]);
  });

  it("все строки внутри обёртки (row-group) → таблица не пустая", async () => {
    const bytes = buildOds([
      {
        name: "G",
        headerRows: [{ cells: [{ text: "H" }] }],
        rows: [{ cells: [{ text: "v" }] }],
        wrapAll: true,
      },
    ]);
    const ir = await odsHandler.parse(ctx(), src(bytes));
    expect(ir.meta.degraded).toBeUndefined();
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.header).toEqual(["H"]);
    expect(block.table.rows).toEqual([["v"]]);
  });

  it("number-rows/columns-repeated=1048576 не раздувает сетку (INV-D4)", async () => {
    const bytes = buildOds([
      { name: "R", rows: [{ cells: [{ text: "x", colsRepeated: 1048576 }], rowsRepeated: 1048576 }] },
    ]);
    const ir = await odsHandler.parse(ctx(), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.truncated).toBe(true);
    expect(block.table.rows.length).toBeLessThanOrEqual(DEFAULT_DOC_LIMITS.maxTableRows);
    expect(block.table.header.length).toBeLessThanOrEqual(256);
    for (const row of block.table.rows) expect(row.length).toBeLessThanOrEqual(256);
  });

  it("odfHeadingLevel: мусор/отсутствие/ноль → 1", () => {
    expect(odfHeadingLevel({ "@_text:outline-level": "junk" })).toBe(1);
    expect(odfHeadingLevel({ "@_text:outline-level": "0" })).toBe(1);
    expect(odfHeadingLevel({ "@_text:outline-level": "3" })).toBe(3);
    expect(odfHeadingLevel({})).toBe(1);
  });

  it("превышение maxTableRows → truncated, строки обрезаны (INV-D4)", async () => {
    const rows = [{ cells: [{ text: "h" }] }];
    for (let i = 0; i < 5; i++) rows.push({ cells: [{ text: String(i) }] });
    const bytes = buildOds([{ name: "S", rows }]);
    const ir = await odsHandler.parse(ctx({ ...DEFAULT_DOC_LIMITS, maxTableRows: 2 }), src(bytes));
    const block = ir.blocks[0];
    if (block.kind !== "table") throw new Error("expect table");
    expect(block.table.truncated).toBe(true);
    expect(block.table.rows).toHaveLength(2);
  });

  it("без content.xml → degraded, без исключения (INV-D5)", async () => {
    const ir = await odsHandler.parse(ctx(), src(buildOds([], { skipContent: true })));
    expect(ir.meta.degraded?.reason).toBeTruthy();
    expect(ir.blocks).toEqual([]);
  });

  it("нет таблиц → degraded", async () => {
    const ir = await odsHandler.parse(ctx(), src(buildOds([])));
    expect(ir.meta.degraded?.reason).toBeTruthy();
    expect(ir.blocks).toEqual([]);
  });

  it("все таблицы пусты → degraded с причиной (INV-D5)", async () => {
    const ir = await odsHandler.parse(ctx(), src(buildOds([{ name: "E", rows: [] }])));
    expect(ir.meta.degraded?.reason).toBeTruthy();
    expect(ir.blocks).toEqual([]);
  });

  it("detect проходит только на ZIP-magic", () => {
    expect(odsHandler.detect?.(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(odsHandler.detect?.(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(false);
  });
});
