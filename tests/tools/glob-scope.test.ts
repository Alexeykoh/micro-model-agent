import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { globTool } from "../../src/tools/glob-tool";
import type { ToolContext } from "../../src/tools/types";

/**
 * `glob` не раскрывает пути вне скоупа субагента, deny-паттерны и
 * защищённые пути (аудит §4.5, план `2026-10-12-harness-module-audit-fixes`,
 * W3/Task 3.4).
 */

const root = mkdtempSync(join(tmpdir(), "mma-glob-scope-"));
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(join(root, "secrets"), { recursive: true });
writeFileSync(join(root, "src", "app.ts"), "export const a = 1;\n", "utf-8");
writeFileSync(join(root, "secrets", "key.txt"), "top secret\n", "utf-8");
writeFileSync(join(root, ".env"), "TOKEN=1\n", "utf-8");

function makeCtx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    baseDir: root,
    config: {},
    logger: { info: () => {}, error: () => {} },
    ...extra,
  } as unknown as ToolContext;
}

describe("glob: скоуп и защищённые пути", () => {
  it("не показывает пути вне скоупа субагента", async () => {
    const ctx = makeCtx({ scope: { allowed_files: ["src"], read_only_files: [] } });
    const res = await globTool.handler(ctx, { pattern: "**/*.ts" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("src");
    expect(res.output).not.toContain("secrets");
  });

  it("не показывает защищённые пути (.env)", async () => {
    const ctx = makeCtx();
    const res = await globTool.handler(ctx, { pattern: "**/.env" });
    expect(res.success).toBe(true);
    expect(res.output).not.toContain(".env");
  });

  it("не показывает пути, попавшие под deny-паттерн", async () => {
    const ctx = makeCtx({
      config: { security: { paths: { enabled: true, denied: ["secrets/**"], allowed: [] } } },
    } as unknown as Partial<ToolContext>);
    const res = await globTool.handler(ctx, { pattern: "**/*.txt" });
    expect(res.success).toBe(true);
    expect(res.output).not.toContain("secrets");
  });

  it("считает скрытые пути", async () => {
    const ctx = makeCtx({ scope: { allowed_files: ["src"], read_only_files: [] } });
    const res = await globTool.handler(ctx, { pattern: "**/*" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("hidden by scope/security");
  });
});
