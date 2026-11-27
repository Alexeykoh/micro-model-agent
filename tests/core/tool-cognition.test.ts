import { describe, expect, it } from "vitest";
import {
  buildHiddenToolsBlock,
  buildToolContractBlock,
  hiddenToolCounts,
} from "../../src/tools/hidden-tools-block";
import { estimateTokens } from "../../src/llm/token-counter";
import type { ToolDefinition } from "../../src/tools/types";

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

const tools = [
  tool("read_file", ["file"]),
  tool("bash", ["code"]),
  tool("enable_tools", [], true),
  tool("web_search", ["web", "research"]),
  tool("web_fetch", ["web", "research"]),
  tool("append_file", ["file-advanced"]),
  tool("remember", ["memory"]),
];

describe("tool cognition prompt", () => {
  it("teaches that only JSON schemas are callable and gives a worked self-report", () => {
    const contract = buildToolContractBlock({ active: 3, hidden: 4, total: 7 });
    expect(contract).toContain("JSON function schemas");
    expect(contract).toContain("KNOWLEDGE");
    expect(contract).toContain("IF asked");
    expect(contract).toContain("3 callable now");
    expect(contract).toContain('enable_tools ["web"]');
    expect(contract).not.toContain("Names below are NOT in your tool list");
    expect(estimateTokens(contract)).toBeLessThanOrEqual(180);
  });

  it("groups locked names by tag instead of presenting a flat owned-tools list", () => {
    const catalog = buildHiddenToolsBlock(tools, ["file", "code"]);
    expect(catalog).toContain("- web: web_fetch, web_search");
    expect(catalog).toContain("- file-advanced: append_file");
    expect(catalog).toContain("- memory: remember");
    expect(catalog).not.toContain("read_file");
    expect(catalog).not.toContain("do not describe them as available");
  });

  it("counts active, hidden and total from the same visibility rule as the schema", () => {
    expect(hiddenToolCounts(tools, ["file", "code"])).toEqual({
      active: 3,
      hidden: 4,
      total: 7,
    });
  });

  it("keeps contract plus catalog within the block budget", () => {
    const counts = hiddenToolCounts(tools, ["file", "code"]);
    const total =
      estimateTokens(buildToolContractBlock(counts)) +
      estimateTokens(buildHiddenToolsBlock(tools, ["file", "code"]));
    expect(total).toBeLessThanOrEqual(580);
  });
});
