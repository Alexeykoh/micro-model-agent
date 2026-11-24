import { describe, expect, it } from "bun:test";
import { OP_BY_TOOL, EXCLUDED_TOOLS } from "../../src/modules/changes/capture";
import { registerAllTools } from "../../src/tools/index";
import { ToolRegistry } from "../../src/tools/registry";

describe("file-tool snapshot coverage", () => {
  it("covers or explicitly excludes every fs-write tool with pathArgs", () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const writers = registry.getAll().filter((tool) =>
      tool.security.pathArgs?.length &&
      tool.security.caps.some((cap) => cap.fs === "write" || cap.fs === "any"),
    );
    expect(writers.length).toBeGreaterThan(0);
    for (const tool of writers) {
      expect(OP_BY_TOOL[tool.name] ?? EXCLUDED_TOOLS[tool.name]).toBeTruthy();
    }
  });

  it("documents exclusions with a reason", () => {
    expect(EXCLUDED_TOOLS.create_dir).toBeTruthy();
    expect(EXCLUDED_TOOLS.bash).toBeTruthy();
    expect(EXCLUDED_TOOLS.restore_file).toBeTruthy();
  });
});
