import { describe, expect, it } from "vitest";
import { csvHandler } from "../../src/modules/documents/handlers/csv";
import { mdHandler } from "../../src/modules/documents/handlers/md";
import { DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";
import type { Logger } from "../../src/logger/app-logger";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = { logger, limits: DEFAULT_DOC_LIMITS };
const src = (path: string, text: string) => ({ path, display: path, ext: path.slice(path.lastIndexOf(".")), bytes: async () => new TextEncoder().encode(text) });

describe("csvHandler", () => {
  it("первую строку делает заголовком таблицы", async () => {
    const ir = await csvHandler.parse(ctx, src("data.csv", "a,b\n1,2\n3,4"));
    const table = ir.blocks[0];
    expect(table.kind).toBe("table");
    if (table.kind === "table") {
      expect(table.table.header).toEqual(["a", "b"]);
      expect(table.table.rows).toEqual([["1", "2"], ["3", "4"]]);
    }
  });

  it("кавычки с запятой внутри поля не рвут строку", async () => {
    const ir = await csvHandler.parse(ctx, src("d.csv", 'a,b\n"x,y",2'));
    const table = ir.blocks[0];
    if (table.kind !== "table") throw new Error("expect table");
    expect(table.table.rows).toEqual([["x,y", "2"]]);
  });

  it("удвоенная кавычка внутри поля — экранированная кавычка", async () => {
    const ir = await csvHandler.parse(ctx, src("d.csv", 'a,b\n"x""y",2'));
    const table = ir.blocks[0];
    if (table.kind !== "table") throw new Error("expect table");
    expect(table.table.rows).toEqual([['x"y', "2"]]);
  });

  it("перевод строки внутри кавычек остаётся в поле", async () => {
    const ir = await csvHandler.parse(ctx, src("d.csv", 'a,b\n"x\ny",2'));
    const table = ir.blocks[0];
    if (table.kind !== "table") throw new Error("expect table");
    expect(table.table.rows).toEqual([["x\ny", "2"]]);
  });

  it("понимает CRLF-переводы строк", async () => {
    const ir = await csvHandler.parse(ctx, src("d.csv", "a,b\r\n1,2\r\n3,4"));
    const table = ir.blocks[0];
    if (table.kind !== "table") throw new Error("expect table");
    expect(table.table.header).toEqual(["a", "b"]);
    expect(table.table.rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("пустой файл → пустой заголовок и пустые строки", async () => {
    const ir = await csvHandler.parse(ctx, src("d.csv", ""));
    const table = ir.blocks[0];
    if (table.kind !== "table") throw new Error("expect table");
    expect(table.table.header).toEqual([]);
    expect(table.table.rows).toEqual([]);
  });

  it("meta.bytes считает реальные UTF-8 байты, а не код-юниты", async () => {
    const ir = await csvHandler.parse(ctx, src("d.csv", "привет"));
    expect("привет".length).toBe(6); // UTF-16 code-units
    expect(ir.meta.bytes).toBe(12); // UTF-8 bytes
  });
});

describe("mdHandler", () => {
  it("заголовки попадают в outline", async () => {
    const ir = await mdHandler.parse(ctx, src("r.md", "# Title\n\ntext\n\n## Sub"));
    expect(ir.meta.title).toBe("Title");
    expect(ir.outline.map((n) => n.title)).toEqual(["Title", "Sub"]);
  });
});
