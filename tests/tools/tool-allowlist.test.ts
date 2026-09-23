import { describe, it, expect, beforeEach } from "vitest";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";
import type { ToolContext } from "../../src/tools/types";

function makeCtx(): ToolContext {
  return {
    config: {} as any,
    baseDir: "/tmp",
    logger: {
      info() {}, error() {}, warn() {}, debug() {},
      logToolCall() {}, logToolOutput() {},
    } as any,
  };
}

describe("tool allowlist", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let executor: ToolExecutor;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register({
      name: "remember", description: "", parameters: { type: "object", properties: {} },
      tags: ["memory"],
      handler: async () => ({ success: true, output: "ok" }),
    });
    registry.register({
      name: "bash", description: "", parameters: { type: "object", properties: {} },
      tags: ["code"], alwaysOn: false,
      handler: async () => ({ success: true, output: "ran" }),
    });
    registry.register({
      name: "project_map", description: "", parameters: { type: "object", properties: {} },
      alwaysOn: true,
      handler: async () => ({ success: true, output: "map" }),
    });
    ctx = makeCtx();
    executor = new ToolExecutor(registry, ctx, { getAllPlugins: () => [] });
  });

  it("exposes every allowlisted tool regardless of tags or alwaysOn", () => {
    ctx.toolAllowlist = ["remember", "question"];
    const names = executor.getToolDefinitions(["code"]).map((t) => t.name);
    expect(names).toEqual(["remember"]);
  });

  it("excludes alwaysOn tools not in the allowlist", () => {
    ctx.toolAllowlist = ["remember"];
    const names = executor.getToolDefinitions().map((t) => t.name);
    expect(names).not.toContain("project_map");
  });

  it("rejects execution of a tool outside the allowlist", async () => {
    ctx.toolAllowlist = ["remember"];
    const res = await executor.execute({ id: "c1", name: "bash", arguments: {} });
    expect(res.success).toBe(false);
    expect(res.output).toContain("not allowed");
  });
});
