import { describe, expect, it } from "vitest";
import { mcpToolSecurity } from "../../../src/modules/mcp/tool-shape";

describe("MCP: pathArgs выводятся из input-схемы", () => {
  it("поля-пути становятся pathArgs", () => {
    const decl = mcpToolSecurity({
      type: "object",
      properties: { file_path: { type: "string" }, query: { type: "string" } },
    });
    expect(decl.pathArgs).toEqual(["file_path"]);
    expect(decl.manual?.reason).toContain("mcp");
  });

  it("массивы путей и синонимы", () => {
    const decl = mcpToolSecurity({
      type: "object",
      properties: { paths: { type: "array" }, directory: {}, cwd: {} },
    });
    expect(decl.pathArgs).toEqual(["paths", "directory"]);
  });

  it("без path-полей декларация остаётся manual-only", () => {
    const decl = mcpToolSecurity({ type: "object", properties: { query: {} } });
    expect(decl.pathArgs).toBeUndefined();
    expect(decl.manual).toBeDefined();
  });

  it("битая схема не роняет регистрацию", () => {
    expect(mcpToolSecurity({} as never).pathArgs).toBeUndefined();
    expect(mcpToolSecurity({ properties: [] } as never).pathArgs).toBeUndefined();
  });
});
