import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PluginLoader } from "../src/modules/plugins/loader";
import { PluginManager } from "../src/modules/plugins/manager";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function pluginFile(name: string, extra = "") {
  return `export const plugin = { name: "${name}"${extra} };\n`;
}

describe("PluginLoader", () => {
  let tmpDir: string;
  let loader: PluginLoader;
  let pm: PluginManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-plugins-"));
    loader = new PluginLoader();
    pm = new PluginManager();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("loads flat .ts files (legacy behavior)", () => {
    writeFileSync(join(tmpDir, "stats.ts"), pluginFile("stats"));
    writeFileSync(join(tmpDir, "redact.js"), pluginFile("redact"));
    loader.loadFromDir(tmpDir, pm);
    expect(pm.getAllPlugins().map((p) => p.name).sort()).toEqual(["redact", "stats"]);
  });

  it("loads a folder plugin via plugin.ts", () => {
    const dir = join(tmpDir, "trace-server");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.ts"), pluginFile("trace-server"));
    writeFileSync(join(dir, "page.html"), "<html></html>");
    loader.loadFromDir(tmpDir, pm);
    expect(pm.getAllPlugins().map((p) => p.name)).toEqual(["trace-server"]);
  });

  it("loads a folder plugin via index.ts", () => {
    const dir = join(tmpDir, "my-plugin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), pluginFile("my-plugin"));
    loader.loadFromDir(tmpDir, pm);
    expect(pm.getAllPlugins().map((p) => p.name)).toEqual(["my-plugin"]);
  });

  it("prefers plugin.ts over index.ts as folder entry", () => {
    const dir = join(tmpDir, "both");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), pluginFile("from-index"));
    writeFileSync(join(dir, "plugin.ts"), pluginFile("from-plugin"));
    loader.loadFromDir(tmpDir, pm);
    expect(pm.getAllPlugins().map((p) => p.name)).toEqual(["from-plugin"]);
  });

  it("skips folders without an entry file", () => {
    const dir = join(tmpDir, "no-entry");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "helper.ts"), "export const x = 1;");
    loader.loadFromDir(tmpDir, pm);
    expect(pm.getAllPlugins()).toHaveLength(0);
  });

  it("skips non-ts/js files at the top level", () => {
    writeFileSync(join(tmpDir, "readme.md"), "# hi");
    writeFileSync(join(tmpDir, "plugin.txt"), "not a plugin");
    loader.loadFromDir(tmpDir, pm);
    expect(pm.getAllPlugins()).toHaveLength(0);
  });

  it("loads both flat files and folder plugins together", () => {
    writeFileSync(join(tmpDir, "flat.ts"), pluginFile("flat"));
    const dir = join(tmpDir, "folder-p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.js"), pluginFile("folder-p"));
    loader.loadFromDir(tmpDir, pm);
    expect(pm.getAllPlugins().map((p) => p.name).sort()).toEqual(["flat", "folder-p"]);
  });

  it("logs skipped entries and continues on failure", () => {
    writeFileSync(join(tmpDir, "broken.ts"), "export const plugin = {");
    writeFileSync(join(tmpDir, "ok.ts"), pluginFile("ok"));
    const warned: string[] = [];
    loader.loadFromDir(tmpDir, pm, { warn: (m) => warned.push(m) });
    expect(pm.getAllPlugins().map((p) => p.name)).toEqual(["ok"]);
    expect(warned.length).toBeGreaterThan(0);
  });

  it("supports default export as the plugin", () => {
    writeFileSync(join(tmpDir, "def.ts"), `export default { name: "def-plug", priority: 5 };\n`);
    loader.loadFromDir(tmpDir, pm);
    expect(pm.getAllPlugins().map((p) => p.name)).toEqual(["def-plug"]);
  });

  it("skips plugins whose minMmaVersion is higher than the current MMA version", () => {
    writeFileSync(join(tmpDir, "too-new.ts"), pluginFile("too-new", `, version: "1.0.0", minMmaVersion: "9.9.9"`));
    writeFileSync(join(tmpDir, "ok.ts"), pluginFile("ok", `, version: "1.0.0", minMmaVersion: "0.1.0"`));
    const warned: string[] = [];
    loader.loadFromDir(tmpDir, pm, { warn: (m) => warned.push(m) }, { mmaVersion: "0.38.0" });
    expect(pm.getAllPlugins().map((p) => p.name)).toEqual(["ok"]);
    expect(warned.some((m) => m.includes("too-new"))).toBe(true);
  });

  it("skips plugins with minMmaVersion even without an mmaVersion option", () => {
    writeFileSync(join(tmpDir, "req.ts"), pluginFile("req", `, version: "1.0.0", minMmaVersion: "0.30.0"`));
    loader.loadFromDir(tmpDir, pm);
    expect(pm.getAllPlugins().map((p) => p.name)).toEqual(["req"]);
  });

  it("passes the source through to registered plugins", () => {
    writeFileSync(join(tmpDir, "src.ts"), pluginFile("src-plug", `, version: "1.0.0"`));
    loader.loadFromDir(tmpDir, pm, undefined, { source: "global", mmaVersion: "0.38.0" });
    const infos = pm.getPluginInfos();
    expect(infos).toHaveLength(1);
    expect(infos[0].source).toBe("global");
  });

  it("deduplicates across dirs — higher version wins", () => {
    const other = mkdtempSync(join(tmpdir(), "mma-plugins2-"));
    try {
      writeFileSync(join(tmpDir, "a.ts"), pluginFile("dup", `, version: "1.0.0"`));
      writeFileSync(join(other, "b.ts"), pluginFile("dup", `, version: "2.0.0"`));
      loader.loadFromDir(tmpDir, pm);
      loader.loadFromDir(other, pm);
      expect(pm.getAllPlugins()).toHaveLength(1);
      expect(pm.getAllPlugins()[0].version).toBe("2.0.0");
    } finally {
      rmSync(other, { recursive: true });
    }
  });
});
