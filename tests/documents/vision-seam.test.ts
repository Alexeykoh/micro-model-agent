import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t } from "../../src/i18n/index";
import { imageHandler } from "../../src/modules/documents/handlers/image";
import { buildRegistry } from "../../src/modules/documents/registry";
import { MAX_VISION_BYTES } from "../../src/modules/documents/media";
import { documentReadTool } from "../../src/modules/documents/tools/document-read";
import type { ImageResizePort } from "../../src/core/api/index";
import type { ToolContext } from "../../src/tools/types";

const dir = mkdtempSync(join(tmpdir(), "mma-vision-seam-"));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
writeFileSync(join(dir, "p.png"), PNG);
const registry = buildRegistry({ enabled: true, groups: ["image"], handlers: [imageHandler] });
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const visionCtx = (onDiagnostic?: (d: unknown) => void): ToolContext =>
  ({ baseDir: dir, logger, capabilities: { vision: true }, contextManager: {}, onDiagnostic }) as unknown as ToolContext;

describe("document_read vision core seam", () => {
  it("passes source bytes and MIME into the port and uses its data URL", async () => {
    const prepare = vi.fn(async (bytes: Uint8Array, mime: string) => ({
      dataUrl: "data:image/jpeg;base64,VkFMSUQ=",
      mime,
      bytes: bytes.length,
      resized: true,
    }));
    const port: ImageResizePort = { prepare };

    const res = await documentReadTool(registry, port).handler(visionCtx(), { path: "p.png" });

    expect(prepare).toHaveBeenCalledTimes(1);
    const [bytes, mime] = prepare.mock.calls[0];
    expect(Array.from(bytes)).toEqual(Array.from(PNG));
    expect(mime).toBe("image/png");
    expect(res.success).toBe(true);
    expect(res.images?.[0].image_url.url).toBe("data:image/jpeg;base64,VkFMSUQ=");
  });

  it("rejects a prepared image that still exceeds the vision byte cap", async () => {
    const onDiagnostic = vi.fn();
    const port: ImageResizePort = {
      prepare: async () => ({
        dataUrl: `data:image/jpeg;base64,${"A".repeat(MAX_VISION_BYTES * 2)}`,
        mime: "image/jpeg",
        bytes: MAX_VISION_BYTES * 2,
        resized: true,
      }),
    };

    const res = await documentReadTool(registry, port).handler(visionCtx(onDiagnostic), {
      path: "p.png",
    });

    expect(res.success).toBe(false);
    expect(res.images).toBeUndefined();
    expect(String(res.output)).toBe(
      t("documents.image_too_large", { path: "p.png", limit: "5 MiB" }),
    );
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ source: "module:documents", kind: "failed" }),
    );
  });
});
