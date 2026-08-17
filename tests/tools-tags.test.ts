import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../src/tools/registry";
import type { ToolDefinition } from "../src/tools/types";
import { buildHiddenToolsBlock } from "../src/tools/hidden-tools-block";
import { enableToolsTool } from "../src/tools/enable-tools";
import { filterToolsByTags } from "../src/tools/filter-tools";
import type { ToolContext } from "../src/tools/types";

function tool(name: string, tags?: string[], alwaysOn?: boolean): ToolDefinition {
  return {
    name,
    description: `${name} desc`,
    parameters: { type: "object", properties: {} },
    tags,
    alwaysOn,
    handler: async () => ({ success: true, output: "" }),
  };
}

describe("buildHiddenToolsBlock", () => {
  it("lists only tools hidden by the active tag set", () => {
    const tools = [
      tool("read_file", ["file"]),
      tool("web_search", ["research"]),
      tool("browser", ["browser", "vision"]),
      tool("plan", undefined, true),
    ];
    const block = buildHiddenToolsBlock(tools, ["file"]);
    expect(block).toContain("web_search");
    expect(block).toContain("browser");
    expect(block).toContain("[research]");
    expect(block).toContain("[browser]");
    expect(block).toContain("[vision]");
    // AlwaysOn + tag-matching tools are not hidden.
    expect(block).not.toContain("read_file");
    expect(block).not.toContain("plan");
  });

  it("returns empty string when nothing is hidden", () => {
    const tools = [tool("read_file", ["file"]), tool("plan", undefined, true)];
    expect(buildHiddenToolsBlock(tools, ["file"])).toBe("");
  });

  it("returns empty string when no tools", () => {
    expect(buildHiddenToolsBlock([], ["file"])).toBe("");
  });

  it("groups hidden tools by their first tag and sorts names", () => {
    const tools = [
      tool("web_fetch", ["research"]),
      tool("web_search", ["research"]),
      tool("remember", ["memory"]),
    ];
    const block = buildHiddenToolsBlock(tools, ["file"]);
    const lines = block.split("\n");
    const researchLine = lines.find((l) => l.startsWith("- [research]"));
    expect(researchLine).toBe("- [research] web_fetch, web_search");
  });
});

describe("enableToolsTool", () => {
  it("pushes new tags into the shared activeToolTags array", async () => {
    const activeToolTags = ["file"];
    const registry = new ToolRegistry();
    registry.register(tool("read_file", ["file"]));
    registry.register(tool("web_search", ["research"]));
    const ctx = {
      activeToolTags,
      toolExecutor: {
        getToolDefinitions: (tags: string[]) => registry.getAllForLLM(tags),
      },
    } as unknown as ToolContext;

    const res = await enableToolsTool.handler(ctx, { tags: ["research"] });
    expect(res.success).toBe(true);
    expect(activeToolTags).toEqual(["file", "research"]);
    expect(res.output).toContain("web_search");
  });

  it("does not duplicate already-active tags", async () => {
    const activeToolTags = ["file"];
    const ctx = {
      activeToolTags,
      toolExecutor: { getToolDefinitions: (tags: string[]) => [] },
    } as unknown as ToolContext;

    const res = await enableToolsTool.handler(ctx, { tags: ["file"] });
    expect(res.success).toBe(true);
    expect(activeToolTags).toEqual(["file"]);
  });

  it("fails when tags array is empty", async () => {
    const ctx = { activeToolTags: [] } as unknown as ToolContext;
    const res = await enableToolsTool.handler(ctx, { tags: [] });
    expect(res.success).toBe(false);
  });

  it("fails when no activeToolTags in context", async () => {
    const ctx = {} as unknown as ToolContext;
    const res = await enableToolsTool.handler(ctx, { tags: ["research"] });
    // Without activeToolTags the handler must not crash; push into nothing and
    // still resolve via toolExecutor if present.
    expect(res.success).toBe(false);
  });
});

describe("filterToolsByTags", () => {
  it("keeps alwaysOn tools for any tag set (MoE/subagent path)", () => {
    const tools = [
      tool("plan", undefined, true),
      tool("read_file", ["file"]),
      tool("web_search", ["research"]),
    ];
    const filtered = filterToolsByTags(tools, ["research"]);
    const names = filtered.map((t) => t.name).sort();
    expect(names).toEqual(["plan", "web_search"]);
  });

  it("returns all tools when tag set is empty (legacy)", () => {
    const tools = [
      tool("read_file", ["file"]),
      tool("web_search", ["research"]),
      tool("plan", undefined, true),
    ];
    expect(filterToolsByTags(tools, [])).toHaveLength(3);
  });

  it("drops untagged non-alwaysOn tools when tags narrow the set", () => {
    const tools = [tool("read_file", ["file"]), tool("untagged")];
    const filtered = filterToolsByTags(tools, ["file"]);
    expect(filtered.map((t) => t.name)).toEqual(["read_file"]);
  });
});
