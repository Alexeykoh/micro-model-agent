import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import {
  BlockedRedirectError,
  fetchValidated,
  isUrlAllowed,
  sanitizeUrl,
} from "../modules/security/network-validator";
import { logNetworkRequest, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { DEFAULT_SECURITY_CONFIG } from "../config/security";
import { MAX_PREVIEW_LINES } from "./preview";

const MAX_CHARS = 5000;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&[^;]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  icon: "⬇️",
  description:
    'Fetch a URL and convert its content to markdown. Use for reading documentation, APIs, web pages. This is a plain HTTP request without a browser engine — it does NOT run JavaScript, so JS-rendered single-page apps (weather sites, dashboards, modern SPAs) return empty or near-empty content; use the "browser" tool for those.',
  tags: ["research"],
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
    },
    required: ["url"],
  },
  handler: async (ctx, args) => {
    const url = String(args.url);

    // Get session-specific security config
    const config = ctx.config || {};
    const securityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(config, ctx.sessionContext).network
      : config.security?.network || DEFAULT_SECURITY_CONFIG.network;
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

    try {
      // Every redirect hop is re-validated (SSRF); the old code re-checked one
      // hop then used redirect:"follow", leaving later hops unchecked.
      const { response: finalResponse, finalUrl } = await fetchValidated(url, securityConfig, {
        signal: AbortSignal.timeout(securityConfig?.requestTimeout || 15000),
      });
      if (!finalResponse.ok) {
        return {
          success: false,
          output: t("error.http", {
            status: finalResponse.status,
            statusText: finalResponse.statusText,
          }),
        };
      }
      const contentType = finalResponse.headers.get("content-type") || "";
      const text = await finalResponse.text();
      const cleaned = contentType.includes("html") ? stripHtml(text) : text;

      logNetworkRequest(ctx.sessionId, sanitizeUrl(finalUrl), true, `Status: ${finalResponse.status}`);

      const fullChars = cleaned.length;
      const fullLines = cleaned.split("\n").length;
      const maxChars = securityConfig?.maxResponseSize || MAX_CHARS;

      let content: string;
      if (cleaned.length > maxChars) {
        content = cleaned.slice(0, maxChars) + t("file.truncated");
      } else {
        content = cleaned;
      }
      const contentLines = content.split("\n");
      if (contentLines.length > MAX_PREVIEW_LINES) {
        content =
          contentLines.slice(0, MAX_PREVIEW_LINES).join("\n") +
          `\n... (${contentLines.length - MAX_PREVIEW_LINES} more lines)`;
      }
      const truncated =
        cleaned.length > maxChars || fullLines > MAX_PREVIEW_LINES
          ? t("file.truncated").trim()
          : "";

      return {
        success: true,
        output: content || t("file.empty_page"),
        display: t("tool.web_fetch_result", {
          url: sanitizeUrl(url),
          chars: String(fullChars),
          lines: String(fullLines),
          truncated,
        }),
      };
    } catch (e: any) {
      if (e instanceof BlockedRedirectError) {
        logSecurityBlock(ctx.sessionId, "network_request", e.reason, sanitizeUrl(url));
        return { success: false, output: `[SECURITY BLOCKED] redirect: ${e.reason}` };
      }
      logNetworkRequest(ctx.sessionId, sanitizeUrl(url), false, `Error: ${e.message}`);
      return {
        success: false,
        output: t("error.fetch_failed", { message: e.message }),
      };
    }
  },
};
