import { describe, expect, it } from "vitest";
import { csvHandler } from "../../src/modules/documents/handlers/csv";
import { mdHandler } from "../../src/modules/documents/handlers/md";
import { DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";
import type { Logger } from "../../src/logger/app-logger";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = { logger, limits: DEFAULT_DOC_LIMITS };
const src = (path: string, text: string) => ({ path, ext: path.slice(path.lastIndexOf(".")), bytes: async () => new TextEncoder().encode(text) });

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
});

describe("mdHandler", () => {
  it("заголовки попадают в outline", async () => {
    const ir = await mdHandler.parse(ctx, src("r.md", "# Title\n\ntext\n\n## Sub"));
    expect(ir.meta.title).toBe("Title");
    expect(ir.outline.map((n) => n.title)).toEqual(["Title", "Sub"]);
  });
});
