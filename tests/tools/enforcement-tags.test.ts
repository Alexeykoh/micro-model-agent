import { describe, it, expect, vi } from "vitest";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";
import type { ToolContext, ToolDefinition } from "../../src/tools/types";

/** W2.6 — теги ограничивают исполнение, а не только схему (INV-11). */
describe("ToolExecutor tag enforcement (INV-11)", () => {
  function makeExecutor(activeToolTags: string[]): ToolExecutor {
    const ctx = {
      config: {} as any,
      baseDir: process.cwd(),
      activeToolTags,
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        logToolCall: vi.fn(),
        logToolOutput: vi.fn(),
      } as any,
    } as ToolContext;
    return new ToolExecutor(registry, ctx, { getAllPlugins: () => [] });
  }

  const registry = new ToolRegistry();
  const handler = vi.fn(async () => ({ success: true, output: "ok" }));

  function register(def: Partial<ToolDefinition> & { name: string }): void {
    registry.upsert(
      {
        description: "d",
        parameters: { type: "object", properties: {} },
        security: { caps: [] },
        handler,
        ...def,
      } as ToolDefinition,
      "core",
    );
  }

  register({ name: "tagged", tags: ["file"] });
  register({ name: "untagged" });
  register({ name: "structural", tags: ["code"], alwaysOn: true });

  it("blocks a tool outside the active tag set before the handler runs", async () => {
    handler.mockClear();
    const result = await makeExecutor(["file"]).execute({ id: "1", name: "untagged", arguments: {} });
    expect(result.success).toBe(false);
    expect(result.output).toContain("tag");
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows a tool matching an active tag", async () => {
    const result = await makeExecutor(["file"]).execute({ id: "1", name: "tagged", arguments: {} });
    expect(result.success).toBe(true);
  });

  it("always keeps alwaysOn tools regardless of tags", async () => {
    const result = await makeExecutor(["file"]).execute({ id: "1", name: "structural", arguments: {} });
    expect(result.success).toBe(true);
  });

  it("treats an empty tag set as legacy 'all tools'", async () => {
    const result = await makeExecutor([]).execute({ id: "1", name: "untagged", arguments: {} });
    expect(result.success).toBe(true);
  });
});
