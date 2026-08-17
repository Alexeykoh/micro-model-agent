import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { IndexerModule } from "../src/modules/indexer/module";
import { setLocale } from "../src/i18n/index";

describe("IndexerModule", () => {
  let tmpDir: string;

  beforeEach(() => {
    setLocale("en");
    tmpDir = mkdtempSync(join(tmpdir(), "mma-idx-mod-"));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("builds index and exposes prompt block", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/index.ts"), "export const x = 1");

    const mod = new IndexerModule({ baseDir: tmpDir, cacheDir: join(tmpDir, ".mma") });
    const result = await mod.buildIndex();

    expect(result).not.toBeNull();
    expect(result!.files).toHaveLength(1);

    const block = mod.getSystemPromptBlock();
    expect(block).not.toBeNull();
    expect(block!.content).toContain("Project map");
    expect(block!.content).toContain("src/index.ts");
    expect(block!.content).toContain("x");
  });

  it("loads index from cache", async () => {
    writeFileSync(join(tmpDir, "lib.ts"), "export const y = 2");
    const cacheDir = join(tmpDir, ".mma");

    const first = new IndexerModule({ baseDir: tmpDir, cacheDir });
    await first.buildIndex();

    const second = new IndexerModule({ baseDir: tmpDir, cacheDir });
    const result = await second.buildIndex();

    expect(result).not.toBeNull();
    expect(result!.files).toHaveLength(1);
  });

  it("includes a stack line in the map block when a manifest exists", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "shop",
        scripts: { dev: "vite" },
        dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
        devDependencies: { vite: "^6.0.0" },
      }),
    );
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/App.tsx"), "export const App = () => null");

    const mod = new IndexerModule({ baseDir: tmpDir, cacheDir: join(tmpDir, ".mma") });
    await mod.buildIndex();

    const block = mod.getSystemPromptBlock();
    expect(block!.content).toContain("[Stack: node shop");
    expect(block!.content).toContain("react");
  });

  it("omits the stack line when no manifest exists", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "export const a = 1");
    const mod = new IndexerModule({ baseDir: tmpDir, cacheDir: join(tmpDir, ".mma") });
    await mod.buildIndex();

    const block = mod.getSystemPromptBlock();
    expect(block!.content).not.toContain("[Stack:");
  });

  it("project_map tool returns summary", async () => {
    writeFileSync(join(tmpDir, "lib.ts"), "export function foo() {}");
    const mod = new IndexerModule({ baseDir: tmpDir, cacheDir: join(tmpDir, ".mma") });
    await mod.buildIndex();

    const tool = mod.getToolDefinitions()[0];
    const res = await tool.handler({} as any, { action: "summary" });

    expect(res.success).toBe(true);
    expect(res.output).toContain("Project map:");
  });

  it("project_map tool finds files by export name", async () => {
    writeFileSync(join(tmpDir, "lib.ts"), "export function foo() {}");
    const mod = new IndexerModule({ baseDir: tmpDir, cacheDir: join(tmpDir, ".mma") });
    await mod.buildIndex();

    const tool = mod.getToolDefinitions()[0];
    const res = await tool.handler({} as any, { action: "find", query: "foo" });

    expect(res.success).toBe(true);
    expect(res.output).toContain("lib.ts");
    expect(res.output).toContain("foo");
  });

  it("project_map tool refresh rebuilds index", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "export const a = 1");
    const mod = new IndexerModule({ baseDir: tmpDir, cacheDir: join(tmpDir, ".mma") });
    await mod.buildIndex();

    writeFileSync(join(tmpDir, "b.ts"), "export const b = 2");

    const tool = mod.getToolDefinitions()[0];
    const res = await tool.handler({} as any, { action: "refresh" });

    expect(res.success).toBe(true);
    expect(res.output).toContain("2 files");
  });

  it("plugin lifecycle starts and stops without errors", async () => {
    writeFileSync(join(tmpDir, "x.ts"), "export const x = 1");
    const mod = new IndexerModule({ baseDir: tmpDir, cacheDir: join(tmpDir, ".mma") });
    const plugin = mod.getPlugin();

    plugin.onSessionStart?.({});
    await new Promise((r) => setTimeout(r, 50));
    plugin.onSessionEnd?.({});
  });

  it("flags files sharing a basename across extensions in the map block", async () => {
    // ses_mst2r0r5: ProductCard.js (stale transpiled) and ProductCard.tsx
    // (real source) both exist; Vite resolves .js first. The map must surface
    // the duplication so the model questions which file is served.
    mkdirSync(join(tmpDir, "components"), { recursive: true });
    writeFileSync(join(tmpDir, "components/ProductCard.js"), "export const a = 1");
    writeFileSync(join(tmpDir, "components/ProductCard.tsx"), "export const b = 1");
    writeFileSync(join(tmpDir, "components/Header.tsx"), "export const h = 1");

    const mod = new IndexerModule({ baseDir: tmpDir, cacheDir: join(tmpDir, ".mma") });
    await mod.buildIndex();

    const block = mod.getSystemPromptBlock();
    expect(block!.content).toContain("ProductCard.{js,tsx}");
    expect(block!.content).not.toContain("Header.{");
  });
});
