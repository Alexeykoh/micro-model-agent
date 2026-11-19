import { mkdtempSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { IndexCache } from "../../src/modules/indexer/cache";

describe("lazy .mma (F-06)", () => {
  it("пустой workspace не создаёт .mma/ через IndexerModule", async () => {
    const { IndexerModule } = await import("../../src/modules/indexer/module");
    const dir = mkdtempSync(join(tmpdir(), "mma-lazy-"));
    const cacheDir = join(dir, ".mma");
    const mod = new IndexerModule({ baseDir: dir, cacheDir });
    await mod.buildIndex();
    expect(existsSync(cacheDir)).toBe(false);
  });

  it("непустой индекс создаёт .mma/ и кэш", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-lazy-"));
    const cacheDir = join(dir, ".mma");
    const cache = new IndexCache(cacheDir, {});
    // @ts-expect-error — минимальный фикстурный результат
    cache.save({
      files: [{ path: "a.ts", size: 1, tokens: 1 }],
      symbols: [],
      totalTokens: 1,
      builtAt: Date.now(),
    });
    expect(existsSync(cacheDir)).toBe(true);
    expect(existsSync(join(cacheDir, "index-cache.json"))).toBe(true);
  });
});
