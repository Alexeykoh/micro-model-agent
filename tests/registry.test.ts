import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../src/tools/registry";
import { ModuleRegistry } from "../src/modules/registry";
import type { ToolDefinition } from "../src/tools/types";

describe("ModuleRegistry", () => {
  it("listModules() returns registered names", () => {
    const r = new ModuleRegistry();
    r.register({ name: "lsp", getSystemPromptBlock: () => null });
    expect(r.listModules()).toEqual(["lsp"]);
  });

  it("get() returns the module by name", () => {
    const r = new ModuleRegistry();
    r.register({ name: "lsp", getSystemPromptBlock: () => null });
    expect(r.get("lsp")).toBeDefined();
    expect(r.get("nope")).toBeUndefined();
  });
});

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("should register and retrieve a tool", () => {
    const tool: ToolDefinition = {
      name: "test_tool",
      description: "A test tool",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ success: true, output: "done" }),
    };
    registry.register(tool, "core");
    expect(registry.get("test_tool")).toMatchObject({ name: "test_tool", owner: "core" });
  });

  it("should throw on duplicate registration", () => {
    const tool: ToolDefinition = {
      name: "dup",
      description: "dup",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ success: true, output: "" }),
    };
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/dup/);
  });

  it("should list all tool names", () => {
    registry.register({
      name: "a",
      description: "a",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ success: true, output: "" }),
    });
    registry.register({
      name: "b",
      description: "b",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ success: true, output: "" }),
    });
    expect(registry.list()).toEqual(["a", "b"]);
  });

  it("should return all tool definitions", () => {
    registry.register({
      name: "x",
      description: "x desc",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ success: true, output: "" }),
    });
    const defs = registry.getAll();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("x");
  });

  it("should check if tool exists", () => {
    expect(registry.has("nonexistent")).toBe(false);
    registry.register({
      name: "exists",
      description: "",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ success: true, output: "" }),
    });
    expect(registry.has("exists")).toBe(true);
  });

  it("should filter tools by tags", () => {
    registry.register({
      name: "read_file",
      description: "",
      parameters: { type: "object", properties: {} },
      tags: ["file", "code"],
      handler: async () => ({ success: true, output: "" }),
    });
    registry.register({
      name: "bash",
      description: "",
      parameters: { type: "object", properties: {} },
      tags: ["shell"],
      handler: async () => ({ success: true, output: "" }),
    });
    registry.register({
      name: "browser",
      description: "",
      parameters: { type: "object", properties: {} },
      tags: ["browser", "vision"],
      handler: async () => ({ success: true, output: "" }),
    });

    const fileTools = registry.getByTags(["file"]);
    expect(fileTools).toHaveLength(1);
    expect(fileTools[0].name).toBe("read_file");

    const codeShellTools = registry.getByTags(["code", "shell"]);
    expect(codeShellTools).toHaveLength(2);
    expect(codeShellTools.map((t) => t.name).sort()).toEqual(["bash", "read_file"]);

    const browserVision = registry.getByTags(["browser", "vision"]);
    expect(browserVision).toHaveLength(1);
    expect(browserVision[0].name).toBe("browser");
  });

  it("should return LLM-safe tool definitions filtered by tags", () => {
    registry.register({
      name: "write_file",
      description: "Writes files",
      parameters: { type: "object", properties: {} },
      tags: ["file"],
      handler: async () => ({ success: true, output: "" }),
    });

    const all = registry.getAllForLLM();
    expect(all.some((t) => t.name === "write_file")).toBe(true);
    expect(all[0]).not.toHaveProperty("handler");
    expect(all[0]).not.toHaveProperty("tags");

    const filtered = registry.getAllForLLM(["shell"]);
    expect(filtered.some((t) => t.name === "write_file")).toBe(false);
  });

  it("keeps alwaysOn tools when filtering by tags", () => {
    registry.register({
      name: "plan",
      description: "Plans",
      parameters: { type: "object", properties: {} },
      alwaysOn: true,
      handler: async () => ({ success: true, output: "" }),
    });
    registry.register({
      name: "write_file",
      description: "Writes",
      parameters: { type: "object", properties: {} },
      tags: ["file"],
      handler: async () => ({ success: true, output: "" }),
    });
    registry.register({
      name: "web_search",
      description: "Search",
      parameters: { type: "object", properties: {} },
      tags: ["research"],
      handler: async () => ({ success: true, output: "" }),
    });

    const visible = registry.getAllForLLM(["file"]);
    const names = visible.map((t) => t.name).sort();
    expect(names).toEqual(["plan", "write_file"]);

    // Untagged non-alwaysOn tools are hidden when tags narrow the set.
    registry.register({
      name: "untagged",
      description: "x",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ success: true, output: "" }),
    });
    const names2 = registry.getAllForLLM(["file"]).map((t) => t.name);
    expect(names2).not.toContain("untagged");
  });

  it("returns every tool when no tags given (legacy)", () => {
    registry.register({
      name: "plan",
      description: "p",
      parameters: { type: "object", properties: {} },
      alwaysOn: true,
      handler: async () => ({ success: true, output: "" }),
    });
    registry.register({
      name: "web_search",
      description: "w",
      parameters: { type: "object", properties: {} },
      tags: ["research"],
      handler: async () => ({ success: true, output: "" }),
    });
    const names = registry
      .getAllForLLM()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["plan", "web_search"]);
  });
});
