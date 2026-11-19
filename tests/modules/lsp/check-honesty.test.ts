import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LspModule } from "../../../src/modules/lsp/module";
import { setLocale } from "../../../src/i18n/index";
import type { ToolContext } from "../../../src/tools/types";

/**
 * `lsp_check` честен: если ничего не проверено, это «неокончательно», а не
 * «чисто» (аудит §8.6, план `2026-10-12-harness-module-audit-fixes`,
 * W8/Task 8.4).
 */

setLocale("en");

function ctxFor(baseDir: string): ToolContext {
  return {
    baseDir,
    config: {} as never,
    logger: { info: () => {}, error: () => {} },
  } as unknown as ToolContext;
}

describe("lsp_check: честность отчёта", () => {
  it("names a missing server instead of claiming the server went silent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-lsp-honest-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n", "utf-8");
      // Серверов нет → проверить нечем; это «не настроен», а не «не ответил».
      const module = new LspModule({ enabled: true, servers: {} });
      const tool = module.getToolDefinitions()[0];
      const result = await tool.handler(ctxFor(dir), { path: "src/a.ts" });
      expect(result.success).toBe(false);
      expect(result.output.toLowerCase()).toContain("no lsp server configured");
      expect(result.output.toLowerCase()).not.toContain("inconclusive");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
