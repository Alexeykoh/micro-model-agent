import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Indexer } from "../../../src/modules/indexer/walker";
import { IndexCache, CACHE_VERSION } from "../../../src/modules/indexer/cache";
import { IndexerModule } from "../../../src/modules/indexer/module";

let tempDir: string | null = null;

function makeProject(): string {
  tempDir = mkdtempSync(join(tmpdir(), "mma-cache-"));
  const write = (rel: string, content = "x") => {
    const full = join(tempDir!, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };
  write("src/app.ts", "export const app = 1");
  write("src/util.ts", "export const util = 2");
  return tempDir;
}

function cacheFor(dir: string, cacheDir = join(dir, ".mma")): IndexCache {
  return new IndexCache(cacheDir, {
    root: dir,
    signature: () => new Indexer(dir).scanSignature(),
  });
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("Indexer.scanSignature", () => {
  it("is stable for an unchanged tree", () => {
    const dir = makeProject();
    expect(new Indexer(dir).scanSignature()).toBe(new Indexer(dir).scanSignature());
  });

  it("changes when a file is added, edited or removed", () => {
    const dir = makeProject();
    const before = new Indexer(dir).scanSignature();

    writeFileSync(join(dir, "src", "new-file.ts"), "export const n = 3");
    const afterAdd = new Indexer(dir).scanSignature();
    expect(afterAdd).not.toBe(before);

    writeFileSync(join(dir, "src", "new-file.ts"), "export const n = 3333");
    const afterEdit = new Indexer(dir).scanSignature();
    expect(afterEdit).not.toBe(afterAdd);

    rmSync(join(dir, "src", "util.ts"));
    expect(new Indexer(dir).scanSignature()).not.toBe(afterEdit);
  });
});

describe("IndexCache validation", () => {
  it("round-trips a fresh index", async () => {
    const dir = makeProject();
    const cache = cacheFor(dir);
    const result = await new Indexer(dir).walk();
    cache.save(result);

    const loaded = cacheFor(dir).load();
    expect(loaded).not.toBeNull();
    expect(loaded?.files.map((f) => f.path).sort()).toEqual(
      result.files.map((f) => f.path).sort(),
    );
  });

  it("rejects the cache after the tree changed", async () => {
    const dir = makeProject();
    const cache = cacheFor(dir);
    cache.save(await new Indexer(dir).walk());

    writeFileSync(join(dir, "src", "app.ts"), "export const app = 999999");
    expect(cacheFor(dir).load()).toBeNull();
  });

  it("rejects a cache written for a different root", async () => {
    const dir = makeProject();
    const cache = cacheFor(dir);
    cache.save(await new Indexer(dir).walk());

    const other = join(dir, "src"); // any path !== dir
    const foreign = new IndexCache(join(dir, ".mma"), {
      root: other,
      signature: () => new Indexer(dir).scanSignature(),
    });
    expect(foreign.load()).toBeNull();
  });

  it("rejects a legacy raw-IndexResult cache (no envelope)", async () => {
    const dir = makeProject();
    const cacheDir = join(dir, ".mma");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "index-cache.json"),
      JSON.stringify({ files: [], totalSize: 0 }),
    );
    expect(cacheFor(dir).load()).toBeNull();
  });

  it("rejects a cache written by an older schema version", async () => {
    const dir = makeProject();
    const cacheDir = join(dir, ".mma");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "index-cache.json"),
      JSON.stringify({
        version: CACHE_VERSION - 1,
        root: dir,
        signature: new Indexer(dir).scanSignature(),
        result: { files: [], totalSize: 0 },
      }),
    );
    expect(cacheFor(dir).load()).toBeNull();
  });

  it("invalidate() removes the cache file", async () => {
    const dir = makeProject();
    const cacheDir = join(dir, ".mma");
    const cache = cacheFor(dir);
    cache.save(await new Indexer(dir).walk());
    expect(readFileSync(join(cacheDir, "index-cache.json"), "utf-8")).toBeTruthy();

    cache.invalidate();
    expect(cacheFor(dir).load()).toBeNull();
  });
});

describe("IndexerModule cache staleness", () => {
  it("rebuilds instead of serving a stale cache after a file is added", async () => {
    const dir = makeProject();
    const cacheDir = join(dir, ".mma");

    const first = new IndexerModule({ baseDir: dir, cacheDir });
    const r1 = await first.buildIndex();
    expect(r1?.files.some((f) => f.path.replace(/\\/g, "/").endsWith("src/new.ts"))).toBe(false);

    writeFileSync(join(dir, "src", "new.ts"), "export const fresh = 1");

    // A NEW module (fresh in-memory state) must notice the change instead of
    // loading the stale on-disk cache.
    const second = new IndexerModule({ baseDir: dir, cacheDir });
    const r2 = await second.buildIndex();
    expect(r2?.files.some((f) => f.path.replace(/\\/g, "/").endsWith("src/new.ts"))).toBe(true);
  });
});
