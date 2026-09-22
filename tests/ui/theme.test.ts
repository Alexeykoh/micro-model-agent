import { describe, it, expect } from "vitest";
import { toolCategory } from "../../src/ui/theme";

describe("toolCategory", () => {
  it("maps tools to their action-category color role", () => {
    expect(toolCategory("read_file")).toBe("recon");
    expect(toolCategory("grep")).toBe("recon");
    expect(toolCategory("write_file")).toBe("mutate");
    expect(toolCategory("edit_file")).toBe("mutate");
    expect(toolCategory("bash")).toBe("execute");
    expect(toolCategory("browser")).toBe("execute");
    expect(toolCategory("plan")).toBe("meta");
    expect(toolCategory("verify")).toBe("meta");
  });

  it("falls back to meta for unknown tools", () => {
    expect(toolCategory("some_future_tool")).toBe("meta");
  });
});
