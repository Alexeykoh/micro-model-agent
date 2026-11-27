import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../src/tools/registry";
import type { ToolDefinition } from "../src/tools/types";
import { buildHiddenToolsBlock } from "../src/tools/hidden-tools-block";
import { enableToolsTool } from "../src/tools/enable-tools";
import { filterToolsByTags, filterToolsWithOverrides } from "../src/tools/filter-tools";
import { rememberTool } from "../src/tools/remember";
import { recallTool } from "../src/tools/recall";
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
    expect(block).toContain("web_search [research]");
    expect(block).toContain("browser [browser, vision]");
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

  it("returns empty string for the wide set: empty tags mean all tools are visible (L4)", () => {
    const tools = [
      tool("read_file", ["file"]),
      tool("web_search", ["research"]),
      tool("plan", undefined, true),
    ];
    expect(buildHiddenToolsBlock(tools, [])).toBe("");
  });

  it("lists each hidden tool once with all tags, sorted by name", () => {
    const tools = [
      tool("web_search", ["web", "research"]),
      tool("attach_image", ["image", "vision"]),
      tool("web_fetch", ["web", "research"]),
      tool("remember", ["memory"]),
    ];
    const block = buildHiddenToolsBlock(tools, ["file"]);
    expect(block.split("\n").filter((l) => l.startsWith("- "))).toEqual([
      "- attach_image [image, vision]",
      "- remember [memory]",
      "- web_fetch [web, research]",
      "- web_search [web, research]",
    ]);
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
      toolExecutor: { getToolDefinitions: (_tags: string[]) => [] },
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

  it("is a no-op when all tools are already visible (wide mode, L4)", async () => {
    const activeToolTags: string[] = [];
    const ctx = {
      activeToolTags,
      toolExecutor: { getToolDefinitions: () => [] },
    } as unknown as ToolContext;
    const res = await enableToolsTool.handler(ctx, { tags: ["research"] });
    expect(res.success).toBe(true);
    expect(activeToolTags).toEqual([]);
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

describe("filterToolsWithOverrides", () => {
  const tools = [
    tool("read_file", ["file"], true),
    tool("web_search", ["research"]),
    tool("plan", undefined, true),
  ];

  it("adds a force-enabled tool outside the active tags", () => {
    const names = filterToolsWithOverrides(tools, ["file"], { enabled: ["web_search"] }).map(
      (t) => t.name,
    );
    expect(names).toEqual(["read_file", "web_search", "plan"]);
  });

  it("removes a force-disabled tool even when it is alwaysOn", () => {
    const names = filterToolsWithOverrides(tools, ["file"], {
      disabled: ["plan"],
    }).map((t) => t.name);
    expect(names).toEqual(["read_file"]);
  });

  it("keeps the tag baseline when no overrides are set", () => {
    expect(filterToolsWithOverrides(tools, ["file"]).map((t) => t.name)).toEqual([
      "read_file",
      "plan",
    ]);
  });
});

describe("memory tools", () => {
  it("are hidden by default and return with the memory tag", () => {
    expect(filterToolsByTags([rememberTool, recallTool], ["file", "code"])).toEqual([]);
    expect(filterToolsByTags([rememberTool, recallTool], ["memory"]).map((t) => t.name)).toEqual([
      "remember",
      "recall",
    ]);
  });
});
