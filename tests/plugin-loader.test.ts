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
});
