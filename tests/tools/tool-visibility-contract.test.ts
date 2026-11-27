import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry";
import { ToolExecutor } from "../../src/tools/executor";
import { earlyToolRejection } from "../../src/tools/executor-reject";
import { enableToolsTool } from "../../src/tools/enable-tools";
import { hiddenToolCounts } from "../../src/tools/hidden-tools-block";
import type { ToolCall, ToolContext, ToolDefinition } from "../../src/tools/types";

function tool(name: string, tags: string[], alwaysOn = false): ToolDefinition {
  return {
    name,
    description: `${name} desc`,
    parameters: { type: "object", properties: {} },
    tags,
    alwaysOn,
    handler: async () => ({ success: true, output: "" }),
  };
}

function context(activeToolTags: string[], extra: Record<string, unknown> = {}): ToolContext {
  return { activeToolTags, ...extra } as unknown as ToolContext;
}

describe("tool visibility contract", () => {
  it("rejects an unknown enable_tools tag and names the available tags", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("read_file", ["file"]));
    const active = ["file"];
    const executor = new ToolExecutor(registry, context(active));
    const ctx = context(active, { toolExecutor: executor });

    const res = await enableToolsTool.handler(ctx, { tags: ["foo"] });

    expect(res.success).toBe(false);
    expect(res.output).toContain("foo");
    expect(res.output).toContain("file");
    expect(active).toEqual(["file"]);
  });

  it("counts hidden tools through the same overrides as the schema", () => {
    const tools = [
      tool("read_file", ["file"]),
      tool("web_search", ["web"]),
      tool("plan", [], true),
    ];
    expect(hiddenToolCounts(tools, ["file"])).toEqual({ active: 2, hidden: 1, total: 3 });
    expect(
      hiddenToolCounts(tools, ["file"], { enabled: ["web_search"], disabled: ["plan"] }),
    ).toEqual({ active: 2, hidden: 1, total: 3 });
    expect(hiddenToolCounts(tools, ["file"], { disabled: ["plan"] })).toEqual({
      active: 1,
      hidden: 2,
      total: 3,
    });
  });

  it("lets an allowlisted tool execute even when its tag is not active", () => {
    const registry = new ToolRegistry();
    registry.register(tool("web_search", ["web"]));
    const ctx = context(["file"], { toolAllowlist: ["web_search"] });
    const call: ToolCall = { id: "c1", name: "web_search", arguments: {} };
    expect(earlyToolRejection(registry, ctx, call)).toBeNull();
  });

  it("gives a forked child its own active tags without mutating the parent", () => {
    const parent = ["file"];
    const executor = new ToolExecutor(new ToolRegistry(), context(parent));
    executor.setActiveToolTags(["web"]);
    expect(parent).toEqual(["file"]);
    expect(executor.getActiveToolTags()).toEqual(["web"]);
  });

  it("keeps a forked child's tags isolated from the parent", () => {
    const parent = ["file"];
    const executor = new ToolExecutor(new ToolRegistry(), context(parent));
    const child = executor.fork();
    child.setActiveToolTags(["web"]);
    expect(executor.getActiveToolTags()).toEqual(["file"]);
    expect(child.getActiveToolTags()).toEqual(["web"]);
  });
});
