/**
 * Кеш снапшота статики (INV-W1, спека 2026-11-04-webui-latency-design, C1):
 * повторный запрос не перечитывает файлы фронта, правка файла цепляется после
 * TTL, prod-снапшот (`ttlMs: Infinity`) не пересканируется вообще.
 *
 * До правки `state.assetSource = loadAssets` читал и транспилировал все файлы
 * на каждый статический запрос — 174 запроса × 174 файла.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssetSource } from "../../src/modules/webui/asset-cache";
import type { WebUiAssets } from "../../src/modules/webui/state";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Фикстура: каталог ассетов + источник с подсчётом вызовов чтения. */
function makeFixture(ttlMs = 5_000): {
  dir: string;
  clock: { t: number };
  loads: number[];
  edit: (html: string) => void;
  source: ReturnType<typeof createAssetSource>;
} {
  const dir = mkdtempSync(join(tmpdir(), "mma-assets-"));
  dirs.push(dir);
  mkdirSync(join(dir, "js"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<h1>v1</h1>");
  writeFileSync(join(dir, "js", "api.ts"), "export const a = 1;\n");
  const clock = { t: 1_000 };
  const loads: number[] = [];
  const load = (): WebUiAssets => {
    loads.push(loads.length);
    return { html: readFileSync(join(dir, "index.html"), "utf8"), css: "", js: "" };
  };
  const source = createAssetSource({ dir, ttlMs, load, now: () => clock.t });
  return {
    dir,
    clock,
    loads,
    edit: (html: string) => writeFileSync(join(dir, "index.html"), html),
    source,
  };
}

describe("asset snapshot cache (INV-W1)", () => {
  it("serves one snapshot for repeated requests", () => {
    const { source, loads } = makeFixture();
    const first = source.get();
    expect(source.get()).toBe(first);
    expect(source.get()).toBe(first);
    expect(loads).toHaveLength(1);
  });

  it("rescans the tree after TTL but keeps the snapshot when nothing changed", () => {
    const { source, clock, loads } = makeFixture();
    const first = source.get();
    clock.t += 10_000;
    expect(source.get()).toBe(first);
    expect(loads).toHaveLength(1);
  });

  it("reloads when a file changed", () => {
    const { source, clock, loads, edit } = makeFixture();
    const first = source.get();
    edit("<h1>v2-longer</h1>");
    clock.t += 10_000;
    const next = source.get();
    expect(next).not.toBe(first);
    expect(next.html).toBe("<h1>v2-longer</h1>");
    expect(loads).toHaveLength(2);
  });

  it("does not rescan inside the TTL window", () => {
    const { source, clock, loads, edit } = makeFixture();
    const first = source.get();
    edit("<h1>v2-longer</h1>");
    expect(source.get()).toBe(first);
    expect(loads).toHaveLength(1);
    clock.t += 10_000;
    expect(source.get().html).toBe("<h1>v2-longer</h1>");
    expect(loads).toHaveLength(2);
  });

  it("never rescans with an infinite TTL (bundled assets are immutable)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-assets-"));
    dirs.push(dir);
    writeFileSync(join(dir, "index.html"), "<h1>v1</h1>");
    const loads: number[] = [];
    const source = createAssetSource({
      dir,
      ttlMs: Number.POSITIVE_INFINITY,
      load: () => {
        loads.push(loads.length);
        return { html: readFileSync(join(dir, "index.html"), "utf8"), css: "", js: "" };
      },
    });
    const first = source.get();
    writeFileSync(join(dir, "index.html"), "<h1>v2-longer</h1>");
    expect(source.get()).toBe(first);
    expect(loads).toHaveLength(1);
  });

  it("exposes a stable ETag that changes with the tree", () => {
    const { source, clock, edit } = makeFixture();
    source.get();
    const etag = source.etag();
    expect(etag).toMatch(/^W\/"/);
    clock.t += 10_000;
    expect(source.get()).toBe(source.get());
    expect(source.etag()).toBe(etag);
    edit("<h1>v2-longer</h1>");
    clock.t += 10_000;
    source.get();
    expect(source.etag()).not.toBe(etag);
  });

  it("has no ETag when the asset directory is missing", () => {
    const source = createAssetSource({ dir: null, load: () => ({ html: "", css: "", js: "" }) });
    expect(source.get()).toEqual({ html: "", css: "", js: "" });
    expect(source.etag()).toBeUndefined();
  });

  it("production source reuses one real snapshot and carries an ETag", () => {
    const source = createAssetSource();
    const first = source.get();
    expect(source.get()).toBe(first);
    expect(first.html.length).toBeGreaterThan(0);
    expect(source.etag()).toMatch(/^W\/"/);
  });
});
