import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import type { NetworkSecurityConfig } from "../config/types";
import { isUrlAllowed, sanitizeUrl } from "../modules/security/network-validator";
import { logNetworkRequest, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutcome {
  success: boolean;
  results: SearchResult[];
  error?: string;
  /** true when the URL was blocked by the security policy (not an I/O error). */
  blocked?: boolean;
}

/**
 * Shared web search (DuckDuckGo HTML) used by BOTH the web_search tool and
 * the automatic error search (execution module). `networkConfig` is the
 * resolved security network config (may be undefined when security is off);
 * `requestTimeoutMs` overrides the timeout when the caller has its own
 * setting (the error search uses errorWebSearch.requestTimeoutMs).
 */
export async function performWebSearch(
  query: string,
  numResults: number,
  networkConfig: NetworkSecurityConfig | undefined,
  requestTimeoutMs?: number,
): Promise<WebSearchOutcome> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const validation = isUrlAllowed(url, networkConfig);
  if (!validation.allowed) {
    return {
      success: false,
      blocked: true,
      results: [],
      error: validation.reason || "URL blocked by security policy",
    };
  }
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(requestTimeoutMs ?? networkConfig?.requestTimeout ?? 10000),
    });
    const html = await response.text();
    const results: SearchResult[] = [];
    const snippetRegex =
      /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = snippetRegex.exec(html)) !== null && results.length < numResults) {
      results.push({
        url: match[1].trim(),
        title: match[2].replace(/<[^>]+>/g, "").trim(),
        snippet: match[3].replace(/<[^>]+>/g, "").trim(),
      });
    }
    return { success: true, results };
  } catch (err: any) {
    return { success: false, results: [], error: err.message };
  }
}

function formatResults(results: SearchResult[]): string {
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
    .join("\n");
}

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
    if (ctx.config?.webSearch?.enabled === false) {
      return { success: false, output: t("tool.web_search_disabled") };
    }
    const query = String(args.query || "");
    const numResults = Number(args.numResults) || 5;

    const securityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(ctx.config, ctx.sessionContext).network
      : ctx.config.security?.network;

    const outcome = await performWebSearch(query, numResults, securityConfig);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    if (outcome.blocked) {
      logSecurityBlock(
        ctx.sessionId,
        "network_request",
        outcome.error || "URL blocked by security policy",
        sanitizeUrl(url),
      );
      return {
        success: false,
        output: t("error.search_failed", { message: String(outcome.error) }),
      };
    }
    logNetworkRequest(
      ctx.sessionId,
      sanitizeUrl(url),
      outcome.success,
      `Results: ${outcome.results.length}`,
    );

    if (!outcome.success) {
      return {
        success: false,
        output: t("error.search_failed", { message: String(outcome.error) }),
      };
    }
    if (outcome.results.length === 0) {
      return { success: true, output: t("tool.no_results", { query }) };
    }
    return {
      success: true,
      output: t("tool.search_results", {
        query,
        results: formatResults(outcome.results),
      }),
      display: t("tool.web_search_result", {
        query,
        count: String(outcome.results.length),
      }),
    };
  },
};
