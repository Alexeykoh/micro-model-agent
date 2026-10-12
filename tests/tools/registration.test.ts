import { describe, it, expect } from "vitest";
import { ToolRegistry, registerAllTools } from "../../src/tools/index";

describe("registerAllTools interactive set", () => {
  it("registers question and approve in the main set", () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.has("question")).toBe(true);
    expect(registry.has("approve")).toBe(true);
    expect(registry.get("question")?.interactive).toBe(true);
    expect(registry.get("approve")?.interactive).toBe(true);
  });

  it("stamps every builtin tool with the core owner (INV-1/2)", () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const missing = registry
      .getAll()
      .filter((t) => t.owner !== "core")
      .map((t) => `${t.name}:${t.owner ?? "none"}`);
    expect(missing, `Builtin tools without owner=core: ${missing.join(", ")}`).toEqual([]);
  });
});
