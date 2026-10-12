import { describe, it, expect, vi } from "vitest";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";
import type { ToolContext, ToolDefinition, ToolSecurityDecl } from "../../src/tools/types";

/** W2.3 — единая точка SSRF-enforcement для `urlArgs` (INV-10). */
describe("ToolExecutor url enforcement (W2.3)", () => {
  function executorWith(security: ToolSecurityDecl, opts: { networkEnabled?: boolean; handler?: () => Promise<{ success: boolean; output: string }> } = {}) {
    const registry = new ToolRegistry();
    const handler = vi.fn(opts.handler ?? (async () => ({ success: true, output: "ok" })));
    const def: ToolDefinition = {
      name: "t",
      description: "d",
      parameters: { type: "object", properties: {} },
      security,
      handler,
    };
    registry.register(def, "core");
    const ctx = {
      config: { security: { network: { enabled: opts.networkEnabled ?? true } } } as any,
      baseDir: "/tmp",
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        logToolCall: vi.fn(),
        logToolOutput: vi.fn(),
      } as any,
    } as ToolContext;
    return { executor: new ToolExecutor(registry, ctx, { getAllPlugins: () => [] }), handler };
  }

  it("blocks a private/localhost URL (SSRF) before the handler runs", async () => {
    const { executor, handler } = executorWith({ caps: [{ net: true }], urlArgs: ["url"] });
    const result = await executor.execute({ id: "1", name: "t", arguments: { url: "http://127.0.0.1/secret" } });
    expect(result.blocked).toBe(true);
    expect(result.output).toContain("URL not allowed");
    expect(handler).not.toHaveBeenCalled();
  });

  it("blocks a non-http(s) scheme", async () => {
    const { executor, handler } = executorWith({ caps: [{ net: true }], urlArgs: ["url"] });
    const result = await executor.execute({ id: "1", name: "t", arguments: { url: "file:///etc/passwd" } });
    expect(result.blocked).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows a public https URL", async () => {
    const { executor, handler } = executorWith({ caps: [{ net: true }], urlArgs: ["url"] });
    const result = await executor.execute({ id: "1", name: "t", arguments: { url: "https://example.com/page" } });
    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("skips enforcement when the network policy is disabled", async () => {
    const { executor, handler } = executorWith({ caps: [{ net: true }], urlArgs: ["url"] }, { networkEnabled: false });
    const result = await executor.execute({ id: "1", name: "t", arguments: { url: "http://127.0.0.1/x" } });
    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("skips an absent/empty url arg (optional, tool decides)", async () => {
    const { executor, handler } = executorWith({ caps: [{ net: true }], urlArgs: ["url"] });
    const result = await executor.execute({ id: "1", name: "t", arguments: {} });
    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });
});
