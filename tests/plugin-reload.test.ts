// Живая перезагрузка плагинов: выгрузка с `onUnload`, сброс кэша модулей,
// подхват правок кода и удалённых файлов.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginLoader, isStaleAfterInvalidate } from "../src/modules/plugins/loader";
import { PluginManager } from "../src/modules/plugins/manager";

function pluginSource(name: string, extra = ""): string {
  return `export const plugin = { name: "${name}"${extra} };\n`;
}

describe("PluginLoader.reloadFromDir", () => {
  let dir: string;
  let projectDir: string;
  let loader: PluginLoader;
  let manager: PluginManager;
  let log: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-plreload-"));
    projectDir = mkdtempSync(join(tmpdir(), "mma-plreload-p-"));
    loader = new PluginLoader();
    manager = new PluginManager();
    // Плагины — отдельные модули: общее состояние только через globalThis.
    log = ((globalThis as Record<string, unknown>).__plReloadLog ??= [] as string[]);
    log.length = 0;
    // Фикстура всегда с onUnload — иначе нечего выгружать при перезагрузке.
    writeFileSync(
      join(dir, "a.ts"),
      `export const plugin = { name: "a", version: "1.0.0", onUnload: () => globalThis.__plReloadLog.push("unload:a") };\n`,
    );
    loader.loadFromDir(dir, manager);
    manager.setSourceDirs({ globalPluginsDir: dir, projectPluginsDir: projectDir });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
  });

  it("picks up a code change without a process restart", () => {
    writeFileSync(join(dir, "a.ts"), pluginSource("a", `, version: "2.0.0", author: "alexe"`));
    const report = loader.reloadFromDir(dir, manager);
    expect(report.unloaded).toBe(1);
    expect(report.loaded).toBe(1);
    expect(manager.getRecords()[0].version).toBe("2.0.0");
    expect(manager.getRecords()[0].author).toBe("alexe");
  });

  it("drops a plugin whose file was deleted", () => {
    rmSync(join(dir, "a.ts"));
    const report = loader.reloadFromDir(dir, manager);
    expect(report.unloaded).toBe(1);
    expect(report.loaded).toBe(0);
    expect(manager.getRecords()).toHaveLength(0);
  });

  it("picks up a newly added plugin", () => {
    writeFileSync(join(dir, "b.ts"), pluginSource("b"));
    const report = loader.reloadFromDir(dir, manager);
    expect(report.loaded).toBe(2);
    expect(manager.getRecords().map((r) => r.name).sort()).toEqual(["a", "b"]);
  });

it("calls onUnload when a plugin file is deleted", () => {
    rmSync(join(dir, "a.ts"));
    loader.reloadFromDir(dir, manager);
    expect(log).toContain("unload:a");
  });

  it("runs onUnload before the freshly loaded plugin is dispatched to", () => {
    writeFileSync(
      join(dir, "b.ts"),
      `export const plugin = { name: "b", onSessionStart: () => globalThis.__plReloadLog.push("start:b") };\n`,
    );
    loader.reloadFromDir(dir, manager);
    manager.runOnSessionStart({});
    // Порядок важен: старый экземпляр освобождает ресурсы до того, как новый
    // начнёт работать, иначе на секунду живут оба.
    expect(log.indexOf("unload:a")).toBeLessThan(log.indexOf("start:b"));
  });

  it("survives a plugin whose onUnload throws", () => {
    writeFileSync(
      join(dir, "a.ts"),
      `export const plugin = { name: "a", onUnload: () => { throw new Error("boom"); } };\n`,
    );
    writeFileSync(join(dir, "b.ts"), pluginSource("b"));
    expect(() => loader.reloadFromDir(dir, manager)).not.toThrow();
    expect(manager.getRecords().map((r) => r.name).sort()).toEqual(["a", "b"]);
  });

  it("records a fresh failure when the new code is broken", () => {
    writeFileSync(join(dir, "a.ts"), "const broken = ((");
    const report = loader.reloadFromDir(dir, manager);
    expect(report.failed).toBe(1);
    expect(manager.getFailures()).toHaveLength(1);
    expect(manager.getRecords()).toHaveLength(0);
  });

  it("clears stale failures after a successful reload", () => {
    writeFileSync(join(dir, "broken.ts"), "const broken = ((");
    loader.reloadFromDir(dir, manager);
    expect(manager.getFailures().length).toBeGreaterThan(0);
    writeFileSync(join(dir, "broken.ts"), pluginSource("broken"));
    loader.reloadFromDir(dir, manager);
    expect(manager.getFailures()).toHaveLength(0);
  });

  it("reloads folder plugins by their entry file", () => {
    const sub = join(dir, "folder");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "plugin.ts"), pluginSource("folder", `, version: "1.0.0"`));
    rmSync(join(dir, "a.ts"));
    loader.reloadFromDir(dir, manager);
    expect(manager.getRecords().map((r) => r.name)).toEqual(["folder"]);
  });

  it("keeps builtins and other directories untouched", () => {
    manager.register({ name: "builtin-x", isBuiltin: true }, "builtin");
    const other = mkdtempSync(join(tmpdir(), "mma-plreload2-"));
    try {
      writeFileSync(join(other, "z.ts"), pluginSource("z"));
      loader.loadFromDir(other, manager);
      writeFileSync(join(dir, "a.ts"), pluginSource("a", `, version: "9.0.0"`));
      loader.reloadFromDir(dir, manager);
      const names = manager.getRecords().map((r) => r.name).sort();
      expect(names).toEqual(["a", "builtin-x", "z"]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("keeps a denied plugin denied across a reload", () => {
    manager.setEnabled("a", false);
    writeFileSync(join(dir, "a.ts"), pluginSource("a", `, version: "2.0.0"`));
    loader.reloadFromDir(dir, manager);
    expect(manager.getRecords()[0].enabled).toBe(false);
  });

  it("reload() on the manager uses the injected dirs", () => {
    writeFileSync(join(dir, "a.ts"), pluginSource("a", `, version: "3.0.0"`));
    const report = manager.reload();
    expect(report.loaded).toBe(1);
    expect(manager.getRecords()[0].version).toBe("3.0.0");
  });

  it("reload() without dirs is a no-op, not a crash", () => {
    const fresh = new PluginManager();
    expect(fresh.reload()).toEqual({ unloaded: 0, loaded: 0, failed: 0, staleTs: 0 });
  });

  it("removes a plugin when its whole folder is deleted", () => {
    const sub = join(dir, "folder");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "plugin.ts"), pluginSource("folder"));
    rmSync(join(dir, "a.ts"));
    loader.reloadFromDir(dir, manager);
    expect(manager.getRecords().map((r) => r.name)).toEqual(["folder"]);
    rmSync(sub, { recursive: true });
    loader.reloadFromDir(dir, manager);
    expect(manager.getRecords()).toHaveLength(0);
  });
});

describe("isStaleAfterInvalidate", () => {
  it("flags .ts only when running under Node (verified experimentally)", () => {
    const runningUnderBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
    if (runningUnderBun) {
      // Bun сбрасывает кэш и для .ts — reload честный.
      expect(isStaleAfterInvalidate("/x/a.ts")).toBe(false);
      expect(isStaleAfterInvalidate("/x/a.js")).toBe(false);
    } else {
      expect(isStaleAfterInvalidate("/x/a.ts")).toBe(true);
      expect(isStaleAfterInvalidate("/x/a.js")).toBe(false);
    }
  });
});