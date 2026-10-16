import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t } from "../../src/i18n/index";
import { type DocEntry, DocumentsCache } from "../../src/modules/documents/corpus";
import { buildRegistry } from "../../src/modules/documents/registry";
import { FIND_LIMIT, searchChunks } from "../../src/modules/documents/search";
import { documentFindTool } from "../../src/modules/documents/tools/document-find";
import { documentIndexTool } from "../../src/modules/documents/tools/document-index";
import type { ToolContext } from "../../src/tools/types";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Запись корпуса с одним чанком для тестов поиска. */
function entry(rel: string, text: string, section?: string): DocEntry {
  return {
    path: `/ws/${rel}`,
    rel,
    mtimeMs: 0,
    size: text.length,
    outline: section ? [section] : [],
    chunks: [{ id: "c0", text, section }],
  };
}

describe("searchChunks", () => {
  it("находит по терму и раньше отдаёт более релевантный чанк", () => {
    const entries = [entry("a.md", "alpha beta", "A"), entry("b.md", "beta beta beta", "B")];
    const hits = searchChunks(entries, "beta", 10);
    expect(hits.map((h) => h.rel)).toEqual(["b.md", "a.md"]);
    expect(hits[0].section).toBe("B");
    expect(hits[0].snippet).toContain("beta");
  });

  it("ограничивает выдачу top-N", () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry(`f${i}.md`, "needle"));
    expect(searchChunks(entries, "needle", 2)).toHaveLength(2);
  });

  it("пустой запрос — пустая выдача", () => {
    expect(searchChunks([entry("a.md", "x")], "   ", 10)).toEqual([]);
  });

  it("нет вхождений — пустая выдача", () => {
    expect(searchChunks([entry("a.md", "hello")], "zzz", 10)).toEqual([]);
  });
});

describe("document_index", () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-index-tool-"));
  writeFileSync(join(dir, "a.csv"), "a,b\n1,2");
  writeFileSync(join(dir, "b.md"), "# T\n\nhello world");
  writeFileSync(join(dir, "c.xyz"), "unsupported");
  const registry = buildRegistry();
  const ctx = (onDiagnostic?: (d: unknown) => void): ToolContext =>
    ({ baseDir: dir, logger, onDiagnostic }) as unknown as ToolContext;

  it("индексирует каталог, сохраняет кэш и отдаёт сводку", async () => {
    const res = await documentIndexTool(registry, logger).handler(ctx(), { dir: "." });
    expect(res.success).toBe(true);
    expect(String(res.output)).toContain("documents: 2");
    expect(String(res.output)).toContain("skipped: 1");
    const cachePath = join(dir, ".mma", "documents-cache.json");
    expect(existsSync(cachePath)).toBe(true);
    const loaded = new DocumentsCache(join(dir, ".mma"), { root: dir }).load();
    expect(loaded?.map((e) => e.rel).sort()).toEqual(["a.csv", "b.md"]);
  });

  it("неподдерживаемый/пустой каталог — сводка 0, без падения", async () => {
    const res = await documentIndexTool(registry, logger).handler(ctx(), { dir: "nowhere" });
    expect(res.success).toBe(true);
    expect(String(res.output)).toContain("documents: 0");
  });

  it("тул объявляет security fs:read и pathArgs dir (INV-D6)", () => {
    const tool = documentIndexTool(registry, logger);
    expect(tool.security.caps).toContainEqual({ fs: "read" });
    expect(tool.security.pathArgs).toContain("dir");
    expect(tool.tags).toContain("document");
    expect(tool.boundedOutput).toBe(true);
    expect(tool.cacheable).toBe(false);
  });
});

describe("document_find", () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-find-tool-"));
  writeFileSync(join(dir, "guide.md"), "# Guide\n\nthe needle is here");
  writeFileSync(join(dir, "other.md"), "# Other\n\nnothing relevant");
  const registry = buildRegistry();
  const ctx = (onDiagnostic?: (d: unknown) => void): ToolContext =>
    ({ baseDir: dir, logger, onDiagnostic }) as unknown as ToolContext;

  it("индексирует по требованию и находит совпадение", async () => {
    const res = await documentFindTool(registry, logger).handler(ctx(), { dir: ".", query: "needle" });
    expect(res.success).toBe(true);
    expect(String(res.output)).toContain("guide.md");
    expect(String(res.output)).toContain("needle");
  });

  it("нет совпадений — честное сообщение", async () => {
    const res = await documentFindTool(registry, logger).handler(ctx(), { dir: ".", query: "zzzznope" });
    expect(res.success).toBe(true);
    expect(String(res.output)).toBe(t("documents.no_matches", { query: "zzzznope" }));
  });

  it("бюджет top-N: не больше FIND_LIMIT строк", async () => {
    const many = mkdtempSync(join(tmpdir(), "doc-find-many-"));
    for (let i = 0; i < 30; i++) writeFileSync(join(many, `f${i}.md`), `# F${i}\n\nneedle`);
    const res = await documentFindTool(buildRegistry(), logger).handler(
      { baseDir: many, logger } as unknown as ToolContext,
      { dir: ".", query: "needle" },
    );
    const lines = String(res.output).split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(FIND_LIMIT);
  });

  it("пустой каталог — fail-open с причиной и записью (INV-D5)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "doc-find-empty-"));
    const onDiagnostic = vi.fn();
    const res = await documentFindTool(buildRegistry(), logger).handler(
      { baseDir: empty, logger, onDiagnostic } as unknown as ToolContext,
      { dir: ".", query: "x" },
    );
    expect(res.success).toBe(false);
    expect(String(res.output)).toBe(t("documents.no_index", { dir: "." }));
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ source: "module:documents", kind: "failed", operation: "document_find" }),
    );
  });

  it("пустой запрос — fail-open с причиной", async () => {
    const res = await documentFindTool(registry, logger).handler(ctx(), { dir: ".", query: "  " });
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain(t("documents.query_required"));
  });

  it("тул объявляет security fs:read и pathArgs dir (INV-D6)", () => {
    const tool = documentFindTool(registry, logger);
    expect(tool.security.caps).toContainEqual({ fs: "read" });
    expect(tool.security.pathArgs).toContain("dir");
    expect(tool.boundedOutput).toBe(true);
    expect(tool.cacheable).toBe(false);
  });
});
