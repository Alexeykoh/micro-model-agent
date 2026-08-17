import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LspModule } from "../src/modules/lsp/module";
import type { LspDiagnostic } from "../src/modules/lsp/types";

const baseCtx = {
  config: {},
  logger: { warn: () => {} },
} as any;

function lspTool(module: LspModule) {
  return module.getToolDefinitions().find((t) => t.name === "lsp_check")!;
}

describe("lsp_check tool", () => {
  let tmp: string;
  let baseDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lsp-tool-"));
    baseDir = join(tmp, "proj");
    mkdirSync(join(baseDir, "src"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it("returns clean for a file with no diagnostics", async () => {
    writeFileSync(join(baseDir, "src", "a.ts"), "export const a = 1;", "utf-8");
    const module = new LspModule({ enabled: true });
    (module as any).client.checkFile = async () => [];
    const res = await lspTool(module).handler({ ...baseCtx, baseDir }, { path: "src/a.ts" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("No errors");
  });

  it("reports [LSP errors] with relative path, line and column", async () => {
    writeFileSync(join(baseDir, "src", "a.ts"), "export const a = 1;", "utf-8");
    const diag: LspDiagnostic = {
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 5 },
      },
      severity: 1,
      message: "Cannot find name 'x'",
    };
    const module = new LspModule({ enabled: true });
    (module as any).client.checkFile = async () => [diag];
    const res = await lspTool(module).handler({ ...baseCtx, baseDir }, { path: "src/a.ts" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("[LSP errors] (1):");
    expect(res.output).toContain("src/a.ts(2,1): error: Cannot find name 'x'");
  });

  it("checks every source file in a directory and skips unsupported extensions", async () => {
    writeFileSync(join(baseDir, "src", "a.ts"), "export const a = 1;", "utf-8");
    writeFileSync(join(baseDir, "src", "b.ts"), "export const b = 2;", "utf-8");
    writeFileSync(join(baseDir, "README.md"), "# readme", "utf-8");
    const checked: string[] = [];
    const module = new LspModule({ enabled: true });
    (module as any).client.checkFile = async (filePath: string) => {
      checked.push(filePath);
      return [];
    };
    const res = await lspTool(module).handler({ ...baseCtx, baseDir }, { path: "src" });
    expect(res.success).toBe(true);
    expect(checked.length).toBe(2);
    expect(res.output).toContain("No errors");
  });

  it("does not descend into node_modules", async () => {
    mkdirSync(join(baseDir, "node_modules"), { recursive: true });
    writeFileSync(join(baseDir, "node_modules", "lib.ts"), "boom", "utf-8");
    writeFileSync(join(baseDir, "src", "a.ts"), "export const a = 1;", "utf-8");
    const checked: string[] = [];
    const module = new LspModule({ enabled: true });
    (module as any).client.checkFile = async (filePath: string) => {
      checked.push(filePath);
      return [];
    };
    const res = await lspTool(module).handler({ ...baseCtx, baseDir }, { path: "." });
    expect(res.success).toBe(true);
    expect(checked.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("lists the checked files in the output", async () => {
    writeFileSync(join(baseDir, "src", "a.ts"), "export const a = 1;", "utf-8");
    writeFileSync(join(baseDir, "src", "b.ts"), "export const b = 1;", "utf-8");
    const module = new LspModule({ enabled: true });
    (module as any).client.checkFile = async () => [];
    const res = await lspTool(module).handler({ ...baseCtx, baseDir }, { path: "src" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("Checked 2 file(s):");
    expect(res.output).toContain("src/a.ts");
    expect(res.output).toContain("src/b.ts");
  });

  it("fails for a missing path", async () => {
    const module = new LspModule({ enabled: true });
    (module as any).client.checkFile = async () => [];
    const res = await lspTool(module).handler({ ...baseCtx, baseDir }, { path: "src/nope.ts" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("Path not found");
  });

  it("disables a dead server after 3 consecutive failures in one batch", async () => {
    writeFileSync(join(baseDir, "src", "a.ts"), "export const a = 1;", "utf-8");
    writeFileSync(join(baseDir, "src", "b.ts"), "export const b = 1;", "utf-8");
    writeFileSync(join(baseDir, "src", "c.ts"), "export const c = 1;", "utf-8");
    const module = new LspModule({ enabled: true });
    (module as any).client.checkFile = async () => {
      throw new Error("typescript-language-server not found");
    };
    const res = await lspTool(module).handler({ ...baseCtx, baseDir }, { path: "src" });
    expect(module.isLspDisabled()).toBe(true);
    expect(res.output).toContain("LSP disabled");
  });

  it("returns an error when LSP is disabled in config", async () => {
    const module = new LspModule({ enabled: false });
    const res = await lspTool(module).handler({ ...baseCtx, baseDir }, { path: "src/a.ts" });
    expect(res.success).toBe(false);
  });
});
