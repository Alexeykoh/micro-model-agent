import { existsSync } from "fs";
import { resolve } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import {
  loadFileAsDataUrl,
  loadUrlAsDataUrl,
  readClipboardImage,
  bufferToDataUrl,
} from "../llm/image-utils";
import { logSecurityBlock } from "../modules/security/audit-log";

export const attachImageTool: ToolDefinition = {
  name: "attach_image",
  icon: "🖼️",
  description:
    "Attach an image to the conversation from a file path, URL, or clipboard. The image will be included in the next message sent to the model. Supports PNG, JPEG, GIF, WebP.",
  tags: ["vision", "image"],
  parameters: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description:
          'Image source: file path (e.g. "./screenshot.png"), URL (e.g. "https://example.com/img.png"), or "clipboard" to read from system clipboard.',
      },
    },
    required: ["source"],
  },
  handler: async (ctx, args) => {
    const source = String(args.source ?? "").trim();
    if (!source) {
      return { success: false, output: t("image.source_required") };
    }

    try {
      let dataUrl: string;

      if (source.toLowerCase() === "clipboard") {
        const clipBuf = await readClipboardImage();
        if (!clipBuf) {
          return {
            success: false,
            output: t("image.clipboard_empty"),
          };
        }
        const result = await bufferToDataUrl(clipBuf);
        dataUrl = result.dataUrl;
      } else if (source.startsWith("http://") || source.startsWith("https://")) {
        const result = await loadUrlAsDataUrl(source);
        dataUrl = result.dataUrl;
      } else {
        const absPath = resolve(ctx.baseDir, source);
        if (!existsSync(absPath)) {
          return {
            success: false,
            output: t("image.not_found", { path: source }),
          };
        }

        // Security: check path scope
        if (ctx.scope) {
          const { isPathInScope } = await import("../modules/security/path-validator");
          const validation = isPathInScope(ctx.baseDir, absPath, ctx.scope);
          if (!validation.allowed) {
            logSecurityBlock(
              ctx.sessionId,
              "file_read",
              validation.reason ?? "attach_image out of scope",
              absPath,
            );
            return {
              success: false,
              output: t("file.path_not_allowed", { path: source }),
            };
          }
        }

        const result = await loadFileAsDataUrl(absPath);
        dataUrl = result.dataUrl;
      }

      // Add the image as a pending content part on the context manager
      if (!ctx.contextManager) {
        return {
          success: false,
          output: t("image.no_context"),
        };
      }

      ctx.contextManager.addPendingImage({
        type: "image_url",
        image_url: { url: dataUrl },
      });

      const sizeKb = Math.round((dataUrl.length * 3) / 4 / 1024);
      return {
        success: true,
        output: t("image.attached", { source, size: `${sizeKb} KB` }),
      };
    } catch (err: any) {
      return {
        success: false,
        output: t("image.error", { message: err.message }),
      };
    }
  },
};
