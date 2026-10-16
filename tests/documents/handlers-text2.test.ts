import { describe, expect, it, vi } from "vitest";
import { jsonHandler } from "../../src/modules/documents/handlers/json";
import { yamlHandler } from "../../src/modules/documents/handlers/yaml";
import { xmlHandler } from "../../src/modules/documents/handlers/xml";
import { htmlHandler } from "../../src/modules/documents/handlers/html";
import { DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";
import type { Logger } from "../../src/logger/app-logger";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = { logger, limits: DEFAULT_DOC_LIMITS };
const loggerWith = (warn: (...a: unknown[]) => void): Logger =>
  ({ debug() {}, info() {}, warn, error() {} }) as unknown as Logger;
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

  it("невалидный JSON логирует warn и помечает degraded (INV-D5)", async () => {
    const warn = vi.fn();
    const ir = await jsonHandler.parse({ logger: loggerWith(warn), limits: DEFAULT_DOC_LIMITS }, src("c.json", "{не json"));
    expect(warn).toHaveBeenCalled();
    expect(ir.meta.degraded).toBeTruthy();
  });
  it("невалидный YAML логирует warn и помечает degraded (INV-D5)", async () => {
    const warn = vi.fn();
    const ir = await yamlHandler.parse({ logger: loggerWith(warn), limits: DEFAULT_DOC_LIMITS }, src("c.yaml", "a: [1,\n  b: : broken"));
    expect(warn).toHaveBeenCalled();
    expect(ir.meta.degraded).toBeTruthy();
  });

  it("xml не размечает теги внутри комментариев", async () => {
    const ir = await xmlHandler.parse(ctx, src("c.xml", "<r><!-- <hidden/> --><a/></r>"));
    const titles = ir.outline.map((n) => n.title);
    expect(titles).toContain("a");
    expect(titles).not.toContain("hidden");
  });
  it("xml: значения атрибутов не становятся тегами (известное ограничение)", async () => {
    const ir = await xmlHandler.parse(ctx, src("c.xml", '<r><a name="b"/></r>'));
    const titles = ir.outline.map((n) => n.title);
    expect(titles).toEqual(expect.arrayContaining(["r", "a"]));
    expect(titles).not.toContain("b");
    expect(titles).not.toContain("name");
  });
  it("meta.bytes — реальные UTF-8 байты (json)", async () => {
    // '"привет"' = 6 кириллических символов * 2 байта + 2 кавычки = 14 байт
    const ir = await jsonHandler.parse(ctx, src("c.json", '"привет"'));
    expect(ir.meta.bytes).toBe(14);
  });
});
