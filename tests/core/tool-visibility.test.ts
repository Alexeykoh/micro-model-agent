import { describe, it, expect } from "vitest";
import { filterDisabledTools } from "../../src/core/agent/tool-visibility";

describe("filterDisabledTools", () => {
  const tools = [{ name: "read_file" }, { name: "browser" }, { name: "bash" }];

  it("returns the same array when nothing is disabled", () => {
    expect(filterDisabledTools(tools, new Set())).toBe(tools);
  });

  it("removes disabled tools by name", () => {
    const out = filterDisabledTools(tools, new Set(["browser"]));
    expect(out.map((t) => t.name)).toEqual(["read_file", "bash"]);
  });

  it("can disable several", () => {
    const out = filterDisabledTools(tools, new Set(["browser", "bash"]));
    expect(out.map((t) => t.name)).toEqual(["read_file"]);
  });
});
