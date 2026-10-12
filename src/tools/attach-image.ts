/** Тул аттача картинки в контекст (файл/URL/буфер обмена). */
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

/** Кладёт картинку в pending-очередь контекста (PNG/JPEG/GIF/WebP). */
export const attachImageTool: ToolDefinition = {
  name: "attach_image",
  security: { caps: [{ fs: "read" }], pathArgs: ["source"] },
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
        // URL — по сетевой политике (SSRF).
        const { isUrlAllowed } = await import("../modules/security/network-validator");
        const { getSessionSecurityConfig } = await import(
          "../modules/security/session-isolation"
        );
        const networkConfig = ctx.sessionContext
          ? getSessionSecurityConfig(ctx.config, ctx.sessionContext).network
          : ctx.config?.security?.network;
        const urlCheck = isUrlAllowed(source, networkConfig);
        if (!urlCheck.allowed) {
          logSecurityBlock(
            ctx.sessionId,
            "network_request",
            urlCheck.reason ?? "attach_image URL blocked",
            source,
          );
          return { success: false, output: `[SECURITY BLOCKED] ${urlCheck.reason}` };
        }
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

        // Пути: глобальная политика + скоуп субагента (та же связка, что у read_file).
        const { isPathInScope } = await import("../modules/security/path-validator");
        const { DEFAULT_SECURITY_CONFIG } = await import("../config/security");
        const validation = isPathInScope(
          ctx.baseDir,
          absPath,
          ctx.scope,
          ctx.config?.security?.paths || DEFAULT_SECURITY_CONFIG.paths,
        );
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

        const result = await loadFileAsDataUrl(absPath);
        dataUrl = result.dataUrl;
      }

      // Картинка идёт в `result.images`: очередь контекста заполняет единообразно
      // `queueToolImages` в tool-batch (там же параллельно персистится для
      // веб-ленты/истории — как browser screenshot).
      if (!ctx.contextManager) {
        return {
          success: false,
          output: t("image.no_context"),
        };
      }

      const sizeKb = Math.round((dataUrl.length * 3) / 4 / 1024);
      return {
        success: true,
        output: t("image.attached", { source, size: `${sizeKb} KB` }),
        images: [{ type: "image_url", image_url: { url: dataUrl } }],
      };
    } catch (err: any) {
      return {
        success: false,
        output: t("image.error", { message: err.message }),
      };
    }
  },
};
