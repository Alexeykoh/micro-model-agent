import { describe, it, expect, beforeEach } from "vitest";
import { ModuleRegistry } from "../src/modules/registry";
import type { AgentModule } from "../src/modules/types";

describe("ModuleRegistry", () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = new ModuleRegistry();
  });

  it("should register a module", () => {
    const mod: AgentModule = { name: "test" };
    registry.register(mod);
    expect(registry.get("test")).toBe(mod);
  });

  it("should collect prompt blocks from modules", () => {
    const mod: AgentModule = {
      name: "test",
      getSystemPromptBlock: () => ({
        content: "test block",
        priority: "normal",
        essential: false,
        estimatedTokens: 10,
      }),
    };
    registry.register(mod);
    const blocks = registry.collectPromptBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("test block");
  });

  it("stamps the module name as the block owner (INV-1/17)", () => {
    const mod: AgentModule = {
      name: "indexer",
      getSystemPromptBlock: () => ({
        content: "map",
        priority: "normal",
        essential: false,
        estimatedTokens: 10,
      }),
    };
    registry.register(mod);
    expect(registry.collectPromptBlocks()[0].source).toBe("indexer");
  });

  it("keeps an explicit block owner over the module name", () => {
    const mod: AgentModule = {
      name: "indexer",
      getSystemPromptBlock: () => ({
        source: "custom",
        content: "map",
        priority: "normal",
        essential: false,
        estimatedTokens: 10,
      }),
    };
    registry.register(mod);
    expect(registry.collectPromptBlocks()[0].source).toBe("custom");
  });

  it("should collect tool definitions", () => {
    const mod: AgentModule = {
      name: "test",
      getToolDefinitions: () => [
        {
          name: "my_tool",
          description: "tool desc",
          parameters: { type: "object", properties: {} },
          handler: async () => ({ success: true, output: "" }),
        },
      ],
    };
    registry.register(mod);
    const tools = registry.collectToolDefinitions();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("my_tool");
  });

  it("should collect plugins", () => {
    const plugin = {
      name: "test-plugin",
      onBeforeTool: () => true,
    };
    const mod: AgentModule = {
      name: "test",
      getPlugin: () => plugin,
    };
    registry.register(mod);
    const plugins = registry.collectPlugins();
    expect(plugins).toHaveLength(1);
  });

  it("should list all registered module names", () => {
    registry.register({ name: "a" });
    registry.register({ name: "b" });
    expect(registry.listModules()).toEqual(["a", "b"]);
  });
});
