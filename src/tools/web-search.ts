import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import {
  isUrlAllowed,
  sanitizeUrl,
} from "../modules/security/network-validator";
import {
  logNetworkRequest,
  logSecurityBlock,
} from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web for information. Returns search results with titles and snippets. Use this for search queries instead of opening search engines (Google/Yandex/Bing) in the browser — they block headless browsers.",
  tags: ["research"],
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      numResults: {
        type: "number",
        description: "Number of results (default 5)",
      },
    },
    required: ["query"],
  },
  handler: async (ctx, args) => {
    const query = String(args.query || "");
    const numResults = Number(args.numResults) || 5;

    // Build search URL
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    // Get session-specific security config
    const securityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(ctx.config, ctx.sessionContext).network
      : ctx.config.security?.network;
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
        output: `[SECURITY BLOCKED] Search URL is not allowed: ${validation.reason}`,
      };
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(securityConfig?.requestTimeout || 10000),
      });
      const html = await response.text();
      const results: string[] = [];
      const snippetRegex =
        /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      let count = 0;
      while ((match = snippetRegex.exec(html)) !== null && count < numResults) {
        const href = match[1].trim();
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        const snippet = match[3].replace(/<[^>]+>/g, "").trim();
        results.push(`${count + 1}. ${title}\n   URL: ${href}\n   ${snippet}`);
        count++;
      }

      // Log successful network request
      logNetworkRequest(
        ctx.sessionId,
        sanitizeUrl(url),
        true,
        `Results: ${results.length}`,
      );

      if (results.length === 0) {
        return { success: true, output: t("tool.no_results", { query }) };
      }
      return {
        success: true,
        output: t("tool.search_results", {
          query,
          results: results.join("\n"),
        }),
        display: t("tool.web_search_result", {
          query,
          count: String(results.length),
        }),
      };
    } catch (err: any) {
      logNetworkRequest(
        ctx.sessionId,
        sanitizeUrl(url),
        false,
        `Error: ${err.message}`,
      );
      return {
        success: false,
        output: t("error.search_failed", { message: err.message }),
      };
    }
  },
};
