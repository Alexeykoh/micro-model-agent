import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ExecutionModule } from "../src/modules/execution/module";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeCfg(overrides: Record<string, unknown> = {}): any {
  return {
    webSearch: { enabled: true },
    errorWebSearch: {
      enabled: true,
      threshold: 5,
      maxResults: 5,
      maxQueryChars: 200,
      maxSearchesPerSession: 3,
      requestTimeoutMs: 10000,
      ...overrides,
    },
  };
}

const TS_ERROR = "error TS2322: Type 'string' is not assignable to type 'number'";

describe("error web search on repeated failures", () => {
  let tmpDir: string;
  let module: ExecutionModule;
  let runner: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-ws-"));
    runner = vi.fn(async () => ({
      success: true,
      results: [{ title: "Fix", url: "https://example.com/fix", snippet: "do this" }],
    }));
    // cooldown 0 → time-based anti-spam disabled for deterministic tests
    module = new ExecutionModule(tmpDir, 8, 5, runner as any, 0);
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  async function failTimes(n: number, output: string, name = "bash") {
    const plugin: any = module.getPlugin();
    const ctx: any = {
      config: makeCfg(),
      logger: { warn: vi.fn(), debug: vi.fn() },
      sessionLog: { plan: vi.fn() },
    };
    const call: any = { id: "c", name, arguments: { command: "bun run test" } };
    const result: any = { success: false, output };
    for (let i = 0; i < n; i++) {
      await plugin.onAfterTool(ctx, call, result);
    }
    await new Promise((r) => setTimeout(r, 5));
    return { plugin, ctx };
  }

  it("fires one search after 5 repeats and injects results", async () => {
    const { plugin, ctx } = await failTimes(5, TS_ERROR);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0]).toContain("TS2322");
    expect(runner.mock.calls[0][0]).toContain("how to fix");

    const messages: string[] = [];
    ctx.contextManager = { addMessage: (m: any) => messages.push(String(m?.content ?? "")) };
    plugin.onBeforeThink(ctx);
    expect(messages.some((m) => m.includes("Web search found"))).toBe(true);
  });

  it("does not search before 5 repeats", async () => {
    await failTimes(4, TS_ERROR);
    expect(runner).not.toHaveBeenCalled();
  });

  it("skips non-searchable error output", async () => {
    await failTimes(5, "Command failed with exit code 1");
    expect(runner).not.toHaveBeenCalled();
  });

  it("respects the webSearch master switch", async () => {
    const plugin: any = module.getPlugin();
    const ctx: any = {
      config: { webSearch: { enabled: false }, errorWebSearch: makeCfg().errorWebSearch },
      logger: { warn: vi.fn(), debug: vi.fn() },
      sessionLog: { plan: vi.fn() },
    };
    const call: any = { id: "c", name: "bash", arguments: { command: "bun run test" } };
    const result: any = { success: false, output: TS_ERROR };
    for (let i = 0; i < 5; i++) await plugin.onAfterTool(ctx, call, result);
    await new Promise((r) => setTimeout(r, 5));
    expect(runner).not.toHaveBeenCalled();
  });

  it("respects the errorWebSearch switch", async () => {
    const plugin: any = module.getPlugin();
    const ctx: any = {
      config: {
        webSearch: { enabled: true },
        errorWebSearch: { ...makeCfg().errorWebSearch, enabled: false },
      },
      logger: { warn: vi.fn(), debug: vi.fn() },
      sessionLog: { plan: vi.fn() },
    };
    const call: any = { id: "c", name: "bash", arguments: { command: "bun run test" } };
    const result: any = { success: false, output: TS_ERROR };
    for (let i = 0; i < 5; i++) await plugin.onAfterTool(ctx, call, result);
    await new Promise((r) => setTimeout(r, 5));
    expect(runner).not.toHaveBeenCalled();
  });

  it("does not re-search the same signature", async () => {
    await failTimes(5, TS_ERROR);
    await failTimes(5, TS_ERROR);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("caps searches per session", async () => {
    const plugin: any = module.getPlugin();
    const ctx: any = {
      config: makeCfg({ maxSearchesPerSession: 1 }),
      logger: { warn: vi.fn(), debug: vi.fn() },
      sessionLog: { plan: vi.fn() },
    };
    const errors = ["error TS2322: A", "error TS1005: B", "ERR_MODULE_NOT_FOUND: C"];
    for (const e of errors) {
      const call: any = { id: "c", name: "bash", arguments: { command: "bun run test" } };
      const result: any = { success: false, output: e };
      for (let i = 0; i < 5; i++) await plugin.onAfterTool(ctx, call, result);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("retries once after empty results, then stops", async () => {
    runner.mockImplementation(async () => ({ success: true, results: [] }));
    const { plugin, ctx } = await failTimes(5, TS_ERROR);
    expect(runner).toHaveBeenCalledTimes(1);

    const call: any = { id: "c", name: "bash", arguments: { command: "bun run test" } };
    const result: any = { success: false, output: TS_ERROR };
    await plugin.onAfterTool(ctx, call, result);
    await new Promise((r) => setTimeout(r, 5));
    expect(runner).toHaveBeenCalledTimes(2);

    await plugin.onAfterTool(ctx, call, result);
    await new Promise((r) => setTimeout(r, 5));
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("triggers search from the write-file typecheck branch too", async () => {
    const plugin: any = module.getPlugin();
    const ctx: any = {
      config: makeCfg(),
      logger: { warn: vi.fn(), debug: vi.fn() },
      sessionLog: { plan: vi.fn() },
    };
    const call: any = { id: "c", name: "write_file", arguments: { path: "src/a.ts" } };
    const result: any = {
      success: true,
      output: "[Project typecheck failed]: src/a.ts(14,19): error TS2322",
    };
    for (let i = 0; i < 5; i++) await plugin.onAfterTool(ctx, call, result);
    await new Promise((r) => setTimeout(r, 5));
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
