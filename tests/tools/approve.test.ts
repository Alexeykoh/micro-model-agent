import { describe, it, expect } from "vitest";
import { approveTool } from "../../src/tools/approve";

describe("approveTool", () => {
  it("has correct definition", () => {
    expect(approveTool.name).toBe("approve");
    expect(approveTool.description).toBeTruthy();
    expect(approveTool.interactive).toBe(true);
    expect(approveTool.tags).toContain("core");
    expect(approveTool.parameters.required).toContain("action");
  });
});
