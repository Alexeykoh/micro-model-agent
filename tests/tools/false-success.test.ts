import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setLocale } from "../../src/i18n/index";
import { approveTool } from "../../src/tools/approve";
import { downloadFileTool } from "../../src/tools/download-file";
import { webSearchTool } from "../../src/tools/web-search";
import { checkSyntax } from "../../src/modules/execution/syntax-check";

beforeEach(() => setLocale("en"));

/**
 * INV-15 / спека observability gaps §2.5: fail-open не имеет права выдавать
 * себя за успех. Один исход (process_kill) уже честный — здесь остальные четыре.
 */
describe("честный отказ вместо ложного успеха", () => {
  it("approve без ApprovalStore не авторизует защищённый путь", async () => {
    const ctx = {
      promptIO: { askChoice: async () => [0], askText: async () => "" },
      baseDir: "/tmp",
      config: {},
    } as never;
    const result = await approveTool.handler(ctx, {
      action: "write",
      path: "secret.txt",
      impact: "high",
    });
    expect(result.success).toBe(false);
    expect(result.errorMeta?.code).toBe("approval_store_unavailable");
  });

  it("download_file помечает ошибку записи как fs_write_failed, не network", async () => {
    const dir = join(process.cwd(), ".tmp-false-success-download");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "blocker"), "not a directory");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("data", { status: 200 })) as never;
    try {
      const ctx = {
        config: {},
        baseDir: dir,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      } as never;
      const result = await downloadFileTool.handler(ctx, {
        url: "https://example.com/x.bin",
        path: "blocker/x.bin",
      });
      expect(result.success).toBe(false);
      expect(result.errorMeta?.code).toBe("fs_write_failed");
      expect(String(result.output)).not.toContain("network");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checkSyntax деградирует при отсутствии node, а не выдумывает syntax error", async () => {
    const degrades: Array<[string, string]> = [];
    const ok = await checkSyntax("/tmp/x.js", {
      baseDir: "/tmp",
      run: async () => {
        throw new Error("spawn node ENOENT");
      },
      degrade: (operation, reason) => degrades.push([operation, reason]),
    });
    expect(ok).toBe(true);
    expect(degrades.some(([operation]) => operation === "verify.syntax")).toBe(true);
  });

  it("web_search с 200 без распознанных результатов возвращает search_unparsed", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "<html></html>",
    })) as never;
    try {
      const ctx = { config: {}, sessionContext: undefined } as never;
      const result = await webSearchTool.handler(ctx, { query: "test" });
      expect(result.success).toBe(false);
      expect(result.errorMeta?.code).toBe("search_unparsed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
