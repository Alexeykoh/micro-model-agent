import { describe, it, expect } from "vitest";
import {
  createBrowserTool,
  formatScreenshotResult,
  formatScreenshotForTextModel,
} from "../../src/tools/browser";

describe("createBrowserTool", () => {
  it("has correct tool definition", () => {
    const tool = createBrowserTool();
    expect(tool.name).toBe("browser");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters.type).toBe("object");
    const props = tool.parameters.properties as Record<string, any>;
    expect(props.action).toBeDefined();
    expect(props.action.enum).toContain("open");
    expect(props.action.enum).toContain("click");
    expect(props.action.enum).toContain("type");
    expect(props.action.enum).toContain("scroll");
    expect(props.action.enum).toContain("screenshot");
    expect(props.action.enum).toContain("close");
    expect(tool.parameters.required).toContain("action");
  });
});

describe("formatScreenshotForTextModel", () => {
  it("returns text-only message without base64 data", () => {
    const snapshot = 'Page: "Test"\nURL: https://test.com\n[1] link "Home"';
    const result = formatScreenshotForTextModel(snapshot);
    expect(result).toContain("Screenshot captured");
    expect(result).toContain(snapshot);
    expect(result).not.toContain("base64");
    expect(result).not.toContain("data:image");
  });
});

describe("formatScreenshotResult", () => {
  it("includes base64 for vision models", () => {
    const snapshot = 'Page: "Test"';
    const buffer = Buffer.from("fake-png-data");
    const result = formatScreenshotResult(snapshot, buffer, true);
    expect(result).toContain("data:image/png;base64,");
  });

  it("excludes base64 for non-vision models", () => {
    const snapshot = 'Page: "Test"';
    const buffer = Buffer.from("fake-png-data");
    const result = formatScreenshotResult(snapshot, buffer, false);
    expect(result).not.toContain("data:image");
    expect(result).toContain("Screenshot captured");
    expect(result).toContain(snapshot);
  });
});
