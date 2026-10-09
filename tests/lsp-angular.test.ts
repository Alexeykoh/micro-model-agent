import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_LSP_CONFIG,
  getServerForFile,
  getServerKeyForFile,
} from "../src/modules/lsp/config";
import { extractBinaryFromNpxArgs } from "../src/modules/lsp/resolve";

describe("angular LSP support", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lsp-angular-"));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it("default config has an angular server (ngserver via npx)", () => {
    const s = DEFAULT_LSP_CONFIG.servers.angular;
    expect(s).toBeDefined();
    expect(s.command).toBe("npx");
    expect(s.args).toContain("@angular/language-server");
    expect(s.args).toContain("ngserver");
    expect(s.workspaceMarkers).toContain("angular.json");
  });

  it("routes .html to the angular server inside an Angular workspace", () => {
    const proj = join(tmp, "ng-app", "src", "app");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(tmp, "ng-app", "angular.json"), "{}", "utf-8");
    const file = join(proj, "app.component.html");
    writeFileSync(file, "<div>{{ title }}</div>", "utf-8");

    const server = getServerForFile(file, DEFAULT_LSP_CONFIG);
    expect(server).toBe(DEFAULT_LSP_CONFIG.servers.angular);
    expect(getServerKeyForFile(file, DEFAULT_LSP_CONFIG)).toBe("angular");
  });

  it("routes .html to the html server outside an Angular workspace", () => {
    const dir = join(tmp, "plain");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "index.html");
    writeFileSync(file, "<html></html>", "utf-8");

    expect(getServerKeyForFile(file, DEFAULT_LSP_CONFIG)).toBe("html");
    expect(getServerForFile(file, DEFAULT_LSP_CONFIG)).toBe(DEFAULT_LSP_CONFIG.servers.html);
  });

  it("falls back to the html server when angular.json exists but no angular server is configured", () => {
    const config = { ...DEFAULT_LSP_CONFIG, servers: { ...DEFAULT_LSP_CONFIG.servers } };
    delete (config.servers as Record<string, unknown>).angular;
    const file = join(tmp, "index.html");
    writeFileSync(file, "<html></html>", "utf-8");
    expect(getServerForFile(file, config)).toBe(config.servers.html);
  });

  it("module check routes .html through the angular server in an Angular project", async () => {
    const proj = join(tmp, "ng-app2");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "angular.json"), "{}", "utf-8");
    const html = join(proj, "src", "app.component.html");
    writeFileSync(html, "<b>hi</b>", "utf-8");

    const { LspModule } = await import("../src/modules/lsp/module");
    const module = new LspModule({ enabled: true });
    let seenConfig: { command: string; args?: string[] } | null = null;
    (module as any).client.checkFile = async (
      _f: string,
      _b: string,
      serverConfig: { command: string; args?: string[] },
    ) => {
      seenConfig = serverConfig;
      return { diagnostics: [], inconclusive: false };
    };

    const tool = module.getToolDefinitions().find((t) => t.name === "lsp_check")!;
    const ctx = { baseDir: proj, config: {}, logger: { warn: () => {} } } as any;
    const res = await tool.handler(ctx, { path: "src/app.component.html" });

    expect(res.success).toBe(true);
    expect(seenConfig!.command).toBe("npx");
    expect(seenConfig!.args).toContain("ngserver");
  });

  it("extractBinaryFromNpxArgs only matches the strict [packages] binary --stdio layout", () => {
    const extract = (args: string[]) => extractBinaryFromNpxArgs(args);

    expect(
      extract([
        "--yes",
        "--package",
        "typescript-language-server",
        "--package",
        "typescript@5",
        "typescript-language-server",
        "--stdio",
      ]),
    ).toBe("typescript-language-server");

    // angular: trailing probe-location args must NOT be mistaken for the binary
    expect(
      extract([
        "--yes",
        "--package",
        "@angular/language-server",
        "--package",
        "typescript@5",
        "ngserver",
        "--stdio",
        "--tsProbeLocations",
        "./node_modules",
        "--ngProbeLocations",
        "./node_modules",
      ]),
    ).toBeNull();

    expect(extract(["--stdio"])).toBeNull();
    expect(extract(["--stdio", "--tsProbeLocations", "."])).toBeNull();
  });
});
