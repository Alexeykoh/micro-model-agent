import { describe, it, expect } from "vitest";
import { filterToolsByTags } from "../../src/tools/filter-tools";
import type { ToolDefinition } from "../../src/tools/types";

describe("filterToolsByTags", () => {
  const tools: ToolDefinition[] = [
    {
      name: "read_file",
      description: "",
      parameters: {},
      tags: ["file", "code"],
      handler: async () => ({ success: true, output: "" }),
    },
    {
      name: "write_file",
      description: "",
      parameters: {},
      tags: ["file", "code"],
      handler: async () => ({ success: true, output: "" }),
    },
    {
      name: "bash",
      description: "",
      parameters: {},
      tags: ["shell", "code"],
      handler: async () => ({ success: true, output: "" }),
    },
    {
      name: "web_search",
      description: "",
      parameters: {},
      tags: ["research"],
      handler: async () => ({ success: true, output: "" }),
    },
    {
      name: "browser",
      description: "",
      parameters: {},
      tags: ["browser", "vision"],
      handler: async () => ({ success: true, output: "" }),
    },
    {
      name: "question",
      description: "",
      parameters: {},
      tags: ["core"],
      handler: async () => ({ success: true, output: "" }),
    },
    {
      name: "untagged",
      description: "",
      parameters: {},
      handler: async () => ({ success: true, output: "" }),
    },
  ];

  it("returns all tools when no tags are specified", () => {
    const result = filterToolsByTags(tools, []);
    expect(result).toHaveLength(tools.length);
  });

  it("filters by a single tag", () => {
    const result = filterToolsByTags(tools, ["file"]);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toEqual(["read_file", "write_file"]);
  });

  it("filters by multiple tags (OR logic)", () => {
    const result = filterToolsByTags(tools, ["shell", "research"]);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toEqual(["bash", "web_search"]);
  });

  it("filters by browser+vision tags", () => {
    const result = filterToolsByTags(tools, ["browser", "vision"]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("browser");
  });

  it("excludes untagged tools when filtering", () => {
    const result = filterToolsByTags(tools, ["core"]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("question");
  });

  it("returns empty array for nonexistent tag", () => {
    const result = filterToolsByTags(tools, ["nonexistent"]);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when all tools are untagged and tag filter is applied", () => {
    const untaggedTools: ToolDefinition[] = [
      {
        name: "a",
        description: "",
        parameters: {},
        handler: async () => ({ success: true, output: "" }),
      },
    ];
    const result = filterToolsByTags(untaggedTools, ["file"]);
    expect(result).toHaveLength(0);
  });
});
