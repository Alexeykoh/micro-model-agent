import { describe, it, expect } from "vitest";
import { MCPModule } from "../src/modules/mcp/module";

/**
 * MCP-тулы не должны попадать в дефолтный набор: их 27+ (Playwright), и
 * маленькие модели ломаются на втором ходе. Они доступны через
 * `enable_tools ["mcp"]`, а не через общий тег `code`.
 */
describe("MCP tools are on-demand", () => {
  it("discovered MCP tool carries only the mcp tag", () => {
    const mod = new MCPModule({} as any);
    (mod as any).discovered = [
      {
        serverName: "playwright",
        toolName: "browser_navigate",
        description: "Navigate",
        inputSchema: {},
      },
    ];

    const defs = mod.getToolDefinitions();

    expect(defs).toHaveLength(1);
    expect(defs[0].tags).toEqual(["mcp"]);
  });

  it("connect placeholder is also on-demand", () => {
    const mod = new MCPModule({} as any);
    (mod as any).serverConfigs = new Map([["playwright", { name: "playwright", command: "x" }]]);

    const defs = mod.getToolDefinitions();

    expect(defs).toHaveLength(1);
    expect(defs[0].tags).toEqual(["mcp"]);
  });
});
