import { describe, expect, it } from "vitest";
import { jsonHandler } from "../../src/modules/documents/handlers/json";
import { yamlHandler } from "../../src/modules/documents/handlers/yaml";
import { xmlHandler } from "../../src/modules/documents/handlers/xml";
import { htmlHandler } from "../../src/modules/documents/handlers/html";
import { DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";
import type { Logger } from "../../src/logger/app-logger";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = { logger, limits: DEFAULT_DOC_LIMITS };
const src = (path: string, text: string) => ({ path, ext: path.slice(path.lastIndexOf(".")), bytes: async () => new TextEncoder().encode(text) });

describe("json/yaml/xml/html", () => {
  it("json отдаёт code-блок с top-level ключами в outline", async () => {
    const ir = await jsonHandler.parse(ctx, src("c.json", '{"a":1,"b":2}'));
    expect(ir.outline.map((n) => n.title)).toEqual(["a", "b"]);
  });
  it("yaml даёт outline по ключам верхнего уровня", async () => {
    const ir = await yamlHandler.parse(ctx, src("c.yaml", "a: 1\nb: 2\n"));
    expect(ir.outline.map((n) => n.title)).toEqual(["a", "b"]);
  });
  it("xml извлекает теги верхнего уровня", async () => {
    const ir = await xmlHandler.parse(ctx, src("c.xml", "<r><a/><b/></r>"));
    expect(ir.outline.length).toBeGreaterThan(0);
  });
  it("html вынимает title и заголовки", async () => {
    const ir = await htmlHandler.parse(ctx, src("p.html", "<html><head><title>T</title></head><body><h1>H</h1><p>x</p></body></html>"));
    expect(ir.meta.title).toBe("T");
    expect(ir.outline.some((n) => n.title === "H")).toBe(true);
  });
});
