import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("top-N точен и ограничен при большом корпусе (prune)", () => {
    const entries = Array.from({ length: 300 }, (_, i) => entry(`f${i}.md`, "needle ".repeat((i % 3) + 1)));
    const hits = searchChunks(entries, "needle", 5);
    expect(hits).toHaveLength(5);
    const scores = hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
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

  it("неподдерживаемый/пустой (читаемый) каталог — сводка 0, без падения", async () => {
    const empty = mkdtempSync(join(tmpdir(), "doc-index-empty-"));
    const res = await documentIndexTool(registry, logger).handler(
      { baseDir: empty, logger } as unknown as ToolContext,
      { dir: "." },
    );
    expect(res.success).toBe(true);
    expect(String(res.output)).toContain("documents: 0");
    rmSync(empty, { recursive: true, force: true });
  });

  it("нечитаемый каталог — fail-open с диагностикой и честным сообщением (INV-D5)", async () => {
    const onDiagnostic = vi.fn();
    const res = await documentIndexTool(registry, logger).handler(ctx(onDiagnostic), { dir: "nowhere" });
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain("nowhere");
    expect(String(res.output)).toContain(t("documents.dir_unreadable", { path: "nowhere" }));
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ source: "module:documents", kind: "failed", operation: "document_index" }),
    );
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

  it("обновляет кэш: изменённый файл отражается в поиске (свежесть)", async () => {
    const d = mkdtempSync(join(tmpdir(), "doc-find-refresh-"));
    writeFileSync(join(d, "a.md"), "# A\n\nfirst version");
    const c = (): ToolContext => ({ baseDir: d, logger } as unknown as ToolContext);
    try {
      const first = await documentFindTool(registry, logger).handler(c(), { dir: ".", query: "version" });
      expect(first.success).toBe(true);
      expect(String(first.output)).toContain("first version");

      // Меняем содержимое (другая длина) — кэш обязан пересобраться.
      writeFileSync(join(d, "a.md"), "# A\n\na totally different second edition");

      const second = await documentFindTool(registry, logger).handler(c(), { dir: ".", query: "edition" });
      expect(second.success).toBe(true);
      expect(String(second.output)).toContain("edition");

      // Старое содержимое больше не находится: кэш действительно обновлён.
      const stale = await documentFindTool(registry, logger).handler(c(), { dir: ".", query: "first" });
      expect(String(stale.output)).toBe(t("documents.no_matches", { query: "first" }));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("тул объявляет security fs:read и pathArgs dir (INV-D6)", () => {
    const tool = documentFindTool(registry, logger);
    expect(tool.security.caps).toContainEqual({ fs: "read" });
    expect(tool.security.pathArgs).toContain("dir");
    expect(tool.boundedOutput).toBe(true);
    expect(tool.cacheable).toBe(false);
  });
});
