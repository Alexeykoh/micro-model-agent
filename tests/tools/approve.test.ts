import { describe, it, expect, vi } from "vitest";
import { approveTool } from "../../src/tools/approve";
import type { PromptIO } from "../../src/tools/prompt-io";

function fakeIO(index: number): PromptIO {
  return {
    askText: vi.fn(async () => ""),
    askChoice: vi.fn(async () => [index]),
  };
}

describe("approveTool", () => {
  it("has correct definition", () => {
    expect(approveTool.name).toBe("approve");
    expect(approveTool.description).toBeTruthy();
    expect(approveTool.interactive).toBe(true);
    expect(approveTool.tags).toContain("core");
    expect(approveTool.parameters.required).toContain("action");
  });

  it("returns approved when the user picks yes through promptIO", async () => {
    const io = fakeIO(0);
    const result = await approveTool.handler({ promptIO: io } as any, { action: "delete" });
    expect(result.success).toBe(true);
    expect(io.askChoice).toHaveBeenCalledOnce();
  });

  it("returns rejected when the user picks no through promptIO", async () => {
    const io = fakeIO(1);
    const result = await approveTool.handler({ promptIO: io } as any, { action: "delete" });
    expect(result.success).toBe(false);
  });

  it("short-circuits in exitOnComplete mode without prompting", async () => {
    const io = fakeIO(0);
    const result = await approveTool.handler({ promptIO: io, exitOnComplete: true } as any, {
      action: "delete",
    });
    expect(result.success).toBe(false);
    expect(io.askChoice).not.toHaveBeenCalled();
  });
});
