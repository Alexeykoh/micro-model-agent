import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { isUrlAllowed, sanitizeUrl } from "../modules/security/network-validator";
import { isPathWritable } from "../modules/security/path-validator";
import {
  logNetworkRequest,
  logFileWrite,
  logSecurityBlock,
} from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { DEFAULT_SECURITY_CONFIG } from "../config/security";
import { safeResolvePath } from "./path-utils";

/** Default cap for a single download (bytes). Chunked responses without a
 * content-length header are checked after the body is read. */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export const downloadFileTool: ToolDefinition = {
  name: "download_file",
  description:
    'Download a file (image, archive, binary, font, etc.) from a URL and save it to disk. Returns only the path, size and content type — read the saved file with read_file/attach_image afterwards. Use this for binary files; web_fetch/web_browse return text only and cannot save bytes.',
  tags: ["file", "research"],
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to download" },
      path: {
        type: "string",
        description: "Destination path (relative to the working directory)",
      },
      max_bytes: {
        type: "number",
        description: "Optional size cap in bytes (default 100 MB)",
      },
    },
    required: ["url", "path"],
  },
  handler: async (ctx, args) => {
    const url = String(args.url || "").trim();
    const path = String(args.path || "").trim();
    if (!url || !path) {
      return { success: false, output: t("tool.invalid_params") };
    }

    // Network security: same rules as web_fetch/web_browse.
    const securityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(ctx.config, ctx.sessionContext).network
      : ctx.config.security?.network || DEFAULT_SECURITY_CONFIG.network;
    const validation = isUrlAllowed(url, securityConfig);
    if (!validation.allowed) {
      logSecurityBlock(
        ctx.sessionId,
        "network_request",
        validation.reason || "URL blocked by security policy",
        sanitizeUrl(url),
      );
      return {
        success: false,
        output: `[SECURITY BLOCKED] URL is not allowed: ${validation.reason}`,
      };
    }

    // Path safety: resolve against baseDir and verify writability.
    const resolved = safeResolvePath(ctx.baseDir, path);
    const scopeCheck = isPathWritable(
      ctx.baseDir,
      resolved,
      ctx.scope,
      ctx.config.security?.paths,
    );
    if (!scopeCheck.allowed) {
      logSecurityBlock(
        ctx.sessionId,
        "file_write",
        scopeCheck.reason || "Path not allowed",
        path,
      );
      return {
        success: false,
        output: t("file.path_not_allowed", {
          path: `${path} — ${scopeCheck.reason}`,
        }),
      };
    }

    const maxBytes =
      Number(args.max_bytes) > 0 ? Number(args.max_bytes) : MAX_DOWNLOAD_BYTES;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(securityConfig?.requestTimeout || 15000),
      });
      if (!response.ok) {
        logNetworkRequest(ctx.sessionId, sanitizeUrl(url), false, `Status: ${response.status}`);
        return {
          success: false,
          output: t("error.http", {
            status: response.status,
            statusText: response.statusText,
          }),
        };
      }

      const contentLength = Number(response.headers.get("content-length") || "0");
      if (contentLength > maxBytes) {
        logNetworkRequest(ctx.sessionId, sanitizeUrl(url), false, `Too large: ${contentLength}`);
        return {
          success: false,
          output: t("tool.download_too_large", { max: String(maxBytes) }),
        };
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        logNetworkRequest(ctx.sessionId, sanitizeUrl(url), false, `Too large: ${buffer.byteLength}`);
        return {
          success: false,
          output: t("tool.download_too_large", { max: String(maxBytes) }),
        };
      }

      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, buffer);

      const contentType =
        response.headers.get("content-type")?.split(";")[0]?.trim() || "unknown";

      logNetworkRequest(ctx.sessionId, sanitizeUrl(url), true, `Status: ${response.status}`);
      logFileWrite(ctx.sessionId, resolved, true, `Downloaded ${buffer.byteLength} bytes`);

      return {
        success: true,
        output: t("tool.downloaded", {
          url: sanitizeUrl(url),
          path: resolved,
          size: String(buffer.byteLength),
          type: contentType,
        }),
      };
    } catch (e: any) {
      logNetworkRequest(ctx.sessionId, sanitizeUrl(url), false, `Error: ${e.message}`);
      return {
        success: false,
        output: t("error.fetch_failed", { message: e.message }),
      };
    }
  },
};
