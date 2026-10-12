/** Тул чтения URL в markdown (plain HTTP, без JS; SSRF-защита, cap вывода). */
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import {
  BlockedRedirectError,
  fetchValidated,
  sanitizeUrl,
} from "../modules/security/network-validator";
import { logNetworkRequest, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { DEFAULT_SECURITY_CONFIG } from "../config/security";
import { MAX_PREVIEW_LINES } from "./preview";
import { extractMainContent, looksLikeShell } from "./html-content";

/** Максимум символов до обрезки вывода тула. */
const MAX_CHARS = 5000;

/** Тянет URL в markdown; JS-страницы вернут пустоту — для них тул browser. */
export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  security: { caps: [{ net: true }], urlArgs: ["url"] },
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

    const config = ctx.config || {};
    const securityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(config, ctx.sessionContext).network
      : config.security?.network || DEFAULT_SECURITY_CONFIG.network;
    // SSRF проверяет ToolExecutor (INV-10) до хендлера; каждый хоп редиректа
    // перевадидируется внутри fetchValidated.
    try {
      // Каждый хоп редиректа перевадидируется (SSRF); старый код проверял один
      // хоп и ставил redirect:"follow", оставляя остальные без проверки.
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
      const isHtml = contentType.includes("html");
      const cleaned = isHtml ? extractMainContent(text) : text;

      logNetworkRequest(ctx.sessionId, sanitizeUrl(finalUrl), true, `Status: ${finalResponse.status}`);

      // JS-шелл: много разметки, почти нет текста — не выдаём навигацию за
      // данные. distinct-сигнал (не success), чтобы модель ушла на browser.
      if (isHtml && looksLikeShell(text, cleaned)) {
        return {
          success: false,
          output: t("tool.web_fetch_no_content", { url: sanitizeUrl(finalUrl) }),
          display: t("tool.web_fetch_result", {
            url: sanitizeUrl(url),
            chars: "0",
            lines: "0",
            truncated: "",
          }),
        };
      }

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
