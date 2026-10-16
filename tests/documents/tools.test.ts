import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t } from "../../src/i18n/index";
import { buildRegistry } from "../../src/modules/documents/registry";
import { csvHandler } from "../../src/modules/documents/handlers/csv";
import { imageHandler } from "../../src/modules/documents/handlers/image";
import { mdHandler } from "../../src/modules/documents/handlers/md";
import { documentMapTool } from "../../src/modules/documents/tools/document-map";
import { documentReadTool } from "../../src/modules/documents/tools/document-read";
import type { ToolContext } from "../../src/tools/types";

const dir = mkdtempSync(join(tmpdir(), "doc-tool-"));
writeFileSync(join(dir, "a.csv"), "a,b\n1,2");
writeFileSync(join(dir, "b.md"), "# A\n\nhello\n\n## B\n\nworld");
writeFileSync(join(dir, "c.xyz"), "unknown-format");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
writeFileSync(join(dir, "p.png"), PNG);
const reg = buildRegistry({ enabled: true, groups: ["text"], handlers: [csvHandler] });
const mdReg = buildRegistry({ enabled: true, groups: ["text"], handlers: [mdHandler] });
const imgReg = buildRegistry({ enabled: true, groups: ["image"], handlers: [imageHandler] });
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const ctx = (onDiagnostic?: (d: unknown) => void): ToolContext =>
  ({ baseDir: dir, logger, onDiagnostic }) as unknown as ToolContext;
/** Контекст с явными capabilities/contextManager для vision-пути. */
const visionCtx = (over: Partial<ToolContext>): ToolContext =>
  ({ baseDir: dir, logger, ...over }) as unknown as ToolContext;

describe("doc tools", () => {
  it("document_map отдаёт карту", async () => {
    const res = await documentMapTool(reg).handler(ctx(), { path: "a.csv" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("format: csv");
  });
  it("пропавший файл — fail-open с относительным путём, без абсолютного", async () => {
    const res = await documentMapTool(reg).handler(ctx(), { path: "nope.csv" });
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain("nope.csv");
    expect(String(res.output)).not.toContain(dir);
  });
  it("неподдерживаемый формат — fail-open с относительным путём", async () => {
    const res = await documentMapTool(reg).handler(ctx(), { path: "c.xyz" });
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain("c.xyz");
    expect(String(res.output)).not.toContain(dir);
  });
  it("пропавший файл — запись module:documents failed (INV-D5)", async () => {
    const onDiagnostic = vi.fn();
    await documentMapTool(reg).handler(ctx(onDiagnostic), { path: "nope.csv" });
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ source: "module:documents", kind: "failed", operation: "document_map" }),
    );
  });
  it("неподдерживаемый формат — запись module:documents failed (INV-D5)", async () => {
    const onDiagnostic = vi.fn();
    await documentMapTool(reg).handler(ctx(onDiagnostic), { path: "c.xyz" });
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ source: "module:documents", kind: "failed", operation: "document_map" }),
    );
  });
  it("document_read: найденный раздел", async () => {
    const res = await documentReadTool(mdReg).handler(ctx(), { path: "b.md", selector: "section:B" });
    expect(res.success).toBe(true);
    expect(String(res.output)).toContain("world");
  });
  it("document_read: отсутствующий раздел — явный fail-open со списком и записью", async () => {
    const onDiagnostic = vi.fn();
    const bad = await documentReadTool(mdReg).handler(ctx(onDiagnostic), { path: "b.md", selector: "section:nope" });
    expect(bad.success).toBe(false);
    expect(String(bad.output)).toContain("nope");
    expect(String(bad.output)).not.toContain(dir);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ source: "module:documents", kind: "failed", operation: "document_read" }),
    );
  });
  it("тулы несут security.fs=read и pathArgs", () => {
    expect(documentMapTool(reg).security.caps).toContainEqual({ fs: "read" });
    expect(documentMapTool(reg).security.pathArgs).toContain("path");
    expect(documentReadTool(reg).security.pathArgs).toContain("path");
  });
});

describe("document_read: vision-путь растра (W4)", () => {
  it("без vision — fail-open с причиной documents.needs_vision и записью (INV-D5)", async () => {
    const onDiagnostic = vi.fn();
    const res = await documentReadTool(imgReg).handler(
      visionCtx({ contextManager: {}, onDiagnostic }),
      { path: "p.png" },
    );
    expect(res.success).toBe(false);
    expect(String(res.output)).toBe(t("documents.needs_vision"));
    expect(res.images).toBeUndefined();
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ source: "module:documents", kind: "failed", operation: "document_read" }),
    );
  });

  it("vision=true без contextManager — тоже fail-open", async () => {
    const res = await documentReadTool(imgReg).handler(
      visionCtx({ capabilities: { vision: true } }),
      { path: "p.png" },
    );
    expect(res.success).toBe(false);
    expect(String(res.output)).toBe(t("documents.needs_vision"));
  });

  it("vision=true + contextManager — отдаёт images с data:image/png URL", async () => {
    const res = await documentReadTool(imgReg).handler(
      visionCtx({ capabilities: { vision: true }, contextManager: {} }),
      { path: "p.png" },
    );
    expect(res.success).toBe(true);
    expect(String(res.output)).toBe(t("documents.image_attached"));
    expect(res.images).toHaveLength(1);
    const url = res.images?.[0].image_url.url ?? "";
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    // base64 от исходных 12 байт фикстуры.
    expect(url).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
  });

  it("document_map растра отдаёт метаданные (figure), без картинки", async () => {
    const res = await documentMapTool(imgReg).handler(visionCtx({ capabilities: { vision: true } }), {
      path: "p.png",
    });
    expect(res.success).toBe(true);
    expect(String(res.output)).toContain("figures: 1");
    expect(String(res.output)).toContain("format: png");
    expect(res.images).toBeUndefined();
  });
});
