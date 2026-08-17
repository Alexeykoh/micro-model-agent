import { describe, it, expect } from "vitest";
import { webFetchTool } from "../../src/tools/web-fetch";

describe("web_fetch tool with real URLs", () => {
  it("should fetch and clean zed.dev HTML content", async () => {
    const result = await webFetchTool.handler({} as any, { url: "https://zed.dev/" });

    if (!result.success && result.output.includes("Fetch failed")) {
      return;
    }

    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
    expect(result.output.length).toBeLessThanOrEqual(15100);
    expect(result.output).not.toContain("<script>");
    expect(result.output).not.toContain("<style>");
  });

  it("should truncate large content with marker", async () => {
    const result = await webFetchTool.handler({} as any, { url: "https://zed.dev/" });

    if (!result.success) return;

    if (result.output.length > 15000) {
      expect(result.output).toContain("truncated");
    }
  });

  it("should handle errors gracefully", async () => {
    const result = await webFetchTool.handler({} as any, {
      url: "https://this-domain-does-not-exist-12345.com",
    });

    expect(result.success).toBe(false);
  });
});
