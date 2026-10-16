import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../src/logger/app-logger";
import {
  CACHE_VERSION,
  DocumentsCache,
  type DocEntry,
  fingerprint,
  indexDir,
  inventoryDir,
} from "../../src/modules/documents/corpus";
import { reconcile } from "../../src/modules/documents/reconcile";
import { buildRegistry, type DocumentRegistry } from "../../src/modules/documents/registry";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

/** Минимальная валидная запись корпуса для тестов кэша. */
function entry(rel: string): DocEntry {
  return {
    path: `/ws/${rel}`,
    rel,
    mtimeMs: 1,
    size: 2,
    outline: ["S"],
    chunks: [{ id: "c0", text: "hi", section: "S" }],
  };
}

describe("DocumentsCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doc-cache-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const root = "/ws";

  it("roundtrip: save → load", () => {
    const cache = new DocumentsCache(dir, { root });
    const entries = [entry("a.md")];
    cache.save(entries);
    expect(new DocumentsCache(dir, { root }).load()).toEqual(entries);
  });

  it("чужой root отвергается (не доверяем)", () => {
    new DocumentsCache(dir, { root }).save([entry("a.md")]);
    expect(new DocumentsCache(dir, { root: "/other" }).load()).toBeNull();
  });

  it("версия схемы проверяется", () => {
    writeFileSync(
      join(dir, "documents-cache.json"),
      JSON.stringify({ version: 999, root, signature: "", entries: [entry("a.md")] }),
    );
    expect(new DocumentsCache(dir, { root }).load()).toBeNull();
  });

  it("битый JSON игнорируется", () => {
    writeFileSync(join(dir, "documents-cache.json"), "{not json");
    expect(new DocumentsCache(dir, { root }).load()).toBeNull();
  });

  it("частично записанный кэш (обрезанный JSON) отвергается", () => {
    // Валидный префикс envelope, но запись оборвана на середине JSON.
    writeFileSync(
      join(dir, "documents-cache.json"),
      '{"version":1,"root":"/ws","signature":"","entries":[{"path":"/ws/a.md"',
    );
    expect(new DocumentsCache(dir, { root }).load()).toBeNull();
  });

  it("кривая форма записи игнорируется", () => {
    writeFileSync(
      join(dir, "documents-cache.json"),
      JSON.stringify({ version: CACHE_VERSION, root, signature: "", entries: [{ path: 1 }] }),
    );
    expect(new DocumentsCache(dir, { root }).load()).toBeNull();
  });

  it("invalidate чистит память и файл", () => {
    const cache = new DocumentsCache(dir, { root });
    cache.save([entry("a.md")]);
    cache.invalidate();
    expect(cache.load()).toBeNull();
    expect(existsSync(join(dir, "documents-cache.json"))).toBe(false);
  });
});

describe("indexDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doc-index-"));
    writeFileSync(join(dir, "a.csv"), "a,b\n1,2");
    writeFileSync(join(dir, "b.md"), "# T\n\nhello world");
    writeFileSync(join(dir, "c.xyz"), "no handler here");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "d.md"), "# D\n\ndeep");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "e.csv"), "x,y\n1,2");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const reg = buildRegistry();

  it("обходит каталог, индексирует поддержанное, считает пропуски", async () => {
    const res = await indexDir({ baseDir: dir, dir: ".", registry: reg, logger });
    expect(res.entries.map((e) => e.rel).sort()).toEqual(["a.csv", "b.md", "sub/d.md"]);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(res.truncated).toBe(false);
    const md = res.entries.find((e) => e.rel === "b.md");
    expect(md?.chunks.length).toBeGreaterThan(0);
    expect(md?.outline).toContain("T");
  });

  it("кап документов помечает truncated", async () => {
    const res = await indexDir({ baseDir: dir, dir: ".", registry: reg, logger, maxDocuments: 2 });
    expect(res.entries).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  it("битый файл не роняет обход, а считается пропуском", async () => {
    const flaky: DocumentRegistry = {
      resolve: reg.resolve,
      active: reg.active,
      parse: async (ctx, source) => {
        if (source.path.endsWith(".csv")) throw new Error("boom");
        return reg.parse(ctx, source);
      },
    };
    const res = await indexDir({ baseDir: dir, dir: ".", registry: flaky, logger });
    expect(res.entries.map((e) => e.rel).sort()).toEqual(["b.md", "sub/d.md"]);
    // забитый csv + неподдержанный c.xyz
    expect(res.skipped).toBeGreaterThanOrEqual(2);
  });

  it("нечитаемый стартовый каталог — error, а не «пусто» (INV-D5)", async () => {
    const res = await indexDir({ baseDir: dir, dir: "nowhere", registry: reg, logger });
    expect(res.entries).toEqual([]);
    expect(res.skipped).toBe(0);
    expect(res.error).toContain("nowhere");
  });

  it("truncated без ложного срабатывания: ровно по капу — нет, выше — да", async () => {
    const d = mkdtempSync(join(tmpdir(), "doc-cap-"));
    writeFileSync(join(d, "a.md"), "# A\n\nx");
    writeFileSync(join(d, "b.md"), "# B\n\ny");
    writeFileSync(join(d, "c.xyz"), "unsupported");
    try {
      // Ровно на капе, оставшийся файл неподдержан — не «truncated».
      const at = await indexDir({ baseDir: d, dir: ".", registry: reg, logger, maxDocuments: 2 });
      expect(at.entries).toHaveLength(2);
      expect(at.truncated).toBe(false);

      // Один поддержанный файл сверх капа — «truncated» с честной причиной.
      const over = await indexDir({ baseDir: d, dir: ".", registry: reg, logger, maxDocuments: 1 });
      expect(over.entries).toHaveLength(1);
      expect(over.truncated).toBe(true);
      expect(over.truncatedBy).toBe("documents");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("общий бюджет чанков ограничивает корпус (честный truncated)", async () => {
    const d = mkdtempSync(join(tmpdir(), "doc-budget-"));
    for (let i = 0; i < 5; i++) writeFileSync(join(d, `f${i}.md`), `# F${i}\n\nhello world again`);
    try {
      const res = await indexDir({ baseDir: d, dir: ".", registry: reg, logger, maxTotalChunks: 2 });
      const total = res.entries.reduce((n, e) => n + e.chunks.length, 0);
      expect(total).toBeLessThanOrEqual(2);
      expect(res.truncated).toBe(true);
      expect(res.truncatedBy).toBe("chunks");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("inventoryDir", () => {
  it("собирает индексируемые файлы без разбора, считает пропуски", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-inv-"));
    const reg = buildRegistry();
    writeFileSync(join(dir, "a.md"), "# A\n\nhello");
    writeFileSync(join(dir, "b.xyz"), "unsupported");
    try {
      const inv = await inventoryDir(dir, ".", { registry: reg, logger });
      expect(inv.items.map((i) => i.rel)).toEqual(["a.md"]);
      expect(inv.skipped).toBeGreaterThanOrEqual(1);
      expect(inv.error).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("нечитаемый стартовый каталог — error, а не «пусто» (INV-D5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-inv-err-"));
    try {
      const inv = await inventoryDir(dir, "nowhere", { registry: buildRegistry(), logger });
      expect(inv.items).toEqual([]);
      expect(inv.error).toContain("nowhere");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fingerprint", () => {
  it("отличается при изменении состава инвентаря", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-fp-"));
    const reg = buildRegistry();
    writeFileSync(join(dir, "a.md"), "# A\n\nx");
    try {
      const inv1 = await inventoryDir(dir, ".", { registry: reg, logger });
      const fp1 = fingerprint(inv1.items);
      expect(fp1).toMatch(/^[0-9a-f]{40}$/);
      writeFileSync(join(dir, "b.md"), "# B\n\ny");
      const inv2 = await inventoryDir(dir, ".", { registry: reg, logger });
      expect(fingerprint(inv2.items)).not.toBe(fp1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reconcile", () => {
  it("пересобирает изменившийся, отбрасывает исчезнувший, переиспользует прочий", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-reconcile-"));
    const reg = buildRegistry();
    writeFileSync(join(dir, "a.md"), "# A\n\nold");
    writeFileSync(join(dir, "b.md"), "# B\n\nkeep");
    try {
      const first = await indexDir({ baseDir: dir, dir: ".", registry: reg, logger });
      expect(first.entries.map((e) => e.rel).sort()).toEqual(["a.md", "b.md"]);

      // Изменяем содержимое (другая длина ⇒ другой size) и удаляем второй файл.
      writeFileSync(join(dir, "a.md"), "# A\n\nnew content here");
      rmSync(join(dir, "b.md"));

      const inv = await inventoryDir(dir, ".", { registry: reg, logger });
      const res = await reconcile(first.entries, inv.items, { baseDir: dir, registry: reg, logger });
      expect(res.changed).toBe(2);
      expect(res.entries.map((e) => e.rel)).toEqual(["a.md"]);
      expect(res.entries[0].chunks.map((c) => c.text).join(" ")).toContain("new content here");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("подхватывает добавленный файл (важно: add, не только change/remove)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-reconcile-add-"));
    const reg = buildRegistry();
    writeFileSync(join(dir, "a.md"), "# A\n\nfirst");
    try {
      const first = await indexDir({ baseDir: dir, dir: ".", registry: reg, logger });
      writeFileSync(join(dir, "b.md"), "# B\n\nbrand new document");
      const inv = await inventoryDir(dir, ".", { registry: reg, logger });
      const res = await reconcile(first.entries, inv.items, { baseDir: dir, registry: reg, logger });
      expect(res.changed).toBe(1);
      expect(res.entries.map((e) => e.rel).sort()).toEqual(["a.md", "b.md"]);
      const added = res.entries.find((e) => e.rel === "b.md");
      expect(added?.chunks.map((c) => c.text).join(" ")).toContain("brand new document");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("неизменившийся файл не считается изменением и переиспользуется", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-reconcile-same-"));
    const reg = buildRegistry();
    writeFileSync(join(dir, "a.md"), "# A\n\nstable");
    try {
      const first = await indexDir({ baseDir: dir, dir: ".", registry: reg, logger });
      const inv = await inventoryDir(dir, ".", { registry: reg, logger });
      const res = await reconcile(first.entries, inv.items, { baseDir: dir, registry: reg, logger });
      expect(res.changed).toBe(0);
      expect(res.entries.map((e) => e.rel)).toEqual(["a.md"]);
      // Переиспользование: та же ссылка на запись, а не пересборка.
      expect(res.entries[0]).toBe(first.entries[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("все файлы удалены — пустой результат и изменений на число удалённых", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-reconcile-all-"));
    const reg = buildRegistry();
    writeFileSync(join(dir, "a.md"), "# A\n\nx");
    writeFileSync(join(dir, "b.md"), "# B\n\ny");
    try {
      const first = await indexDir({ baseDir: dir, dir: ".", registry: reg, logger });
      rmSync(join(dir, "a.md"));
      rmSync(join(dir, "b.md"));
      const inv = await inventoryDir(dir, ".", { registry: reg, logger });
      const res = await reconcile(first.entries, inv.items, { baseDir: dir, registry: reg, logger });
      expect(res.entries).toEqual([]);
      expect(res.changed).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
