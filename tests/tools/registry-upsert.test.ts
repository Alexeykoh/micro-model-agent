// Реестр тулов: upsert/unregister против строгого register.
import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../src/tools/registry";
import type { ToolDefinition } from "../../src/tools/types";

function tool(name: string, description = "d"): ToolDefinition {
  return { name, description, parameters: { type: "object", properties: {} } };
}

describe("ToolRegistry.upsert / unregister", () => {
  it("register по-прежнему кидает на дубль", () => {
    const registry = new ToolRegistry();
    registry.register(tool("a"));
    expect(() => registry.register(tool("a"))).toThrow();
  });

  it("upsert заменяет определение по имени", () => {
    const registry = new ToolRegistry();
    registry.upsert(tool("a", "first"));
    registry.upsert(tool("a", "second"));
    expect(registry.list()).toEqual(["a"]);
    expect(registry.get("a")?.description).toBe("second");
  });

  it("unregister снимает тул и сообщает, был ли он", () => {
    const registry = new ToolRegistry();
    registry.upsert(tool("a"));
    expect(registry.unregister("a")).toBe(true);
    expect(registry.unregister("a")).toBe(false);
    expect(registry.has("a")).toBe(false);
  });

  it("clone несёт внесённые через upsert определения", () => {
    const registry = new ToolRegistry();
    registry.upsert(tool("a"));
    const copy = registry.clone();
    expect(copy.get("a")).toBeDefined();
  });

  it("stamps the owner passed to register/upsert (INV-1)", () => {
    const registry = new ToolRegistry();
    registry.register(tool("a"), "core");
    registry.upsert(tool("b"), "plugin:x");
    expect(registry.get("a")?.owner).toBe("core");
    expect(registry.get("b")?.owner).toBe("plugin:x");
  });
});