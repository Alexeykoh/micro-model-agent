import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createBrowserTool,
  formatScreenshotForTextModel,
  screenshotToImagePart,
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

  it("tells text-only models to prefer DOM/API assertions (ses_mup6p61q F3)", () => {
    // 7 browser-вызовов вслепую: скриншот недоступен текстовой модели,
    // снапшоты не показали сайдбар — API/DOM-проверки были бы сразу точнее.
    const tool = createBrowserTool();
    expect(tool.description).toContain("Without vision");
    expect(tool.description).toContain("/api/");
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

describe("screenshotToImagePart", () => {
  it("wraps the screenshot as an image_url content part", async () => {
    const part = await screenshotToImagePart(Buffer.from("fake-png-data"));
    expect(part.type).toBe("image_url");
    expect(part.image_url.url.startsWith("data:image/")).toBe(true);
  });
});

describe("browser screenshot delivery by capability", () => {
  const withSession = async (
    capabilities: { vision?: boolean } | undefined,
    run: (result: any) => void,
  ) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mma-browser-shot-"));
    const fakeSession = {
      execute: async () => ({
        success: true,
        output: 'Page: "Test"',
        screenshot: Buffer.from("fake-png-data"),
      }),
      close: async () => {},
    };
    setBrowserSessionFactoryForTest(() => fakeSession as any);
    try {
      const tool = createBrowserTool();
      const ctx = { config: { browser: {} }, baseDir: tmpDir, capabilities } as any;
      run(await tool.handler(ctx, { action: "screenshot" }));
    } finally {
      setBrowserSessionFactoryForTest(undefined);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  };

  it("returns an image part for a vision model, never base64 in the text output", async () => {
    await withSession({ vision: true }, (result) => {
      expect(result.images).toHaveLength(1);
      expect(result.images[0].type).toBe("image_url");
      expect(result.output).not.toContain("data:image");
      expect(result.output).not.toContain("base64");
    });
  });

  it("returns a text-only snapshot when the model has no vision", async () => {
    await withSession({ vision: false }, (result) => {
      expect(result.images).toBeUndefined();
      expect(result.output).toContain("Screenshot captured");
      expect(result.output).not.toContain("data:image");
    });
  });

  it("defaults to text-only when capabilities are unknown", async () => {
    await withSession(undefined, (result) => {
      expect(result.images).toBeUndefined();
      expect(result.output).not.toContain("data:image");
    });
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
