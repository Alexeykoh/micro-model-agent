import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createBrowserTool,
  formatScreenshotResult,
  formatScreenshotForTextModel,
  modelSupportsVision,
  setBrowserSessionFactoryForTest,
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

describe("modelSupportsVision", () => {
  it("matches vision families and rejects text-only models", () => {
    expect(modelSupportsVision("qwen/qwen2.5-vl-7b")).toBe(true);
    expect(modelSupportsVision("gpt-4o")).toBe(true);
    expect(modelSupportsVision("gemini-2.5-pro")).toBe(true);
    expect(modelSupportsVision("llava:13b")).toBe(true);
    expect(modelSupportsVision("qwen/qwen3.5-9b")).toBe(false);
  });
});

describe("browser action serialization (MoE parallel waves)", () => {
  it("never runs two actions concurrently", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mma-browser-serial-"));
    let active = 0;
    let maxActive = 0;
    const fakeSession = {
      execute: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { success: true, output: "ok" };
      },
      close: async () => {},
    };
    setBrowserSessionFactoryForTest(() => fakeSession as any);
    try {
      const tool = createBrowserTool();
      const ctx = {
        config: { model: "qwen/qwen3.5-9b", browser: {} },
        baseDir: tmpDir,
      } as any;
      await Promise.all([
        tool.handler(ctx, { action: "snapshot" }),
        tool.handler(ctx, { action: "snapshot" }),
        tool.handler(ctx, { action: "snapshot" }),
      ]);
      expect(maxActive).toBe(1);
    } finally {
      setBrowserSessionFactoryForTest(undefined);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
