/** Веб-поиск (DuckDuckGo HTML): тул и shared-функция для автопоиска ошибок. */
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import type { NetworkSecurityConfig } from "../config/types";
import { isUrlAllowed, sanitizeUrl } from "../modules/security/network-validator";
import { logNetworkRequest, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { readMmaVersion } from "../core/version";
import { wrapUntrusted } from "./web-content";

/** Элемент выдачи: заголовок, URL, сниппет. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Итог поиска: успех, результаты, ошибка. */
export interface WebSearchOutcome {
  success: boolean;
  results: SearchResult[];
  error?: string;
  /** true — URL отклонён security-политикой (не I/O-ошибка). */
  blocked?: boolean;
}

/** Задержка перед единственным ретраем на 429/503. */
const RETRY_DELAY_MS = 800;

/** User-Agent: поисковики режут запросы без него. */
function userAgent(): string {
  return `micro-models-agent/${readMmaVersion()}`;
}

/** Пауза перед ретраем. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Разворачивает редирект DuckDuckGo `//duckduckgo.com/l/?uddg=<enc>` в прямой
 * URL. Иначе выдача отдаёт непроходимые редирект-ссылки, и модель не может по
 * ним перейти (`web_fetch` вернёт обёртку DDG). Не-DDG/битые URL — как есть.
 */
export function unwrapDdgUrl(url: string): string {
  try {
    const u = new URL(url, "https://duckduckgo.com");
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname) && u.pathname === "/l/") {
      const target = u.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Общий веб-поиск (DuckDuckGo HTML) для тула web_search и автопоиска ошибок
 * (execution-модуль). `networkConfig` — резолвленная сетевая security-конфигурация
 * (undefined при выключенной безопасности); `requestTimeoutMs` переопределяет
 * таймаут, когда у вызывающего свой (автопоиск — errorWebSearch.requestTimeoutMs).
 *
 * Статус ответа проверяется: 429/503 — это не «пустая выдача», а ошибка
 * (аудит §2.1). `fetchImpl` — точка подмены для тестов.
 */
export async function performWebSearch(
  query: string,
  numResults: number,
  networkConfig: NetworkSecurityConfig | undefined,
  requestTimeoutMs?: number,
  fetchImpl: typeof fetch = fetch,
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
  const timeoutMs = requestTimeoutMs ?? networkConfig?.requestTimeout ?? 10000;
  try {
    let response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": userAgent() },
    });
    // Один ретрай на 429/503: поисковик часто отвечает «слишком много
    // запросов», и повтор через 800 мс почти всегда проходит.
    if (response.status === 429 || response.status === 503) {
      await sleep(RETRY_DELAY_MS);
      response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": userAgent() },
      });
    }
    if (!response.ok) {
      return {
        success: false,
        results: [],
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    const html = await response.text();
    const results: SearchResult[] = [];
    const snippetRegex =
      /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = snippetRegex.exec(html)) !== null && results.length < numResults) {
      results.push({
        url: unwrapDdgUrl(match[1].trim()),
        title: match[2].replace(/<[^>]+>/g, "").trim(),
        snippet: match[3].replace(/<[^>]+>/g, "").trim(),
      });
    }
    return { success: true, results };
  } catch (err: any) {
    return { success: false, results: [], error: err.message };
  }
}

/** Форматирует выдачу нумерованным списком. */
function formatResults(results: SearchResult[]): string {
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
    .join("\n");
}

/** Ищет в вебе (заголовки + сниппеты); поисковики открывать не надо. */
export const webSearchTool: ToolDefinition = {
  name: "web_search",
  security: { caps: [{ net: true }] },
  icon: "🌍",
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
      const message = String(outcome.error);
      const status = /^HTTP (\d{3})/.exec(message)?.[1];
      return {
        success: false,
        output: t("error.search_failed", { message }),
        ...(status
          ? {
              errorMeta: {
                code: `http_${status}`,
                retryable: status === "429" || Number(status) >= 500,
              },
            }
          : {}),
      };
    }
    if (outcome.results.length === 0) {
      return { success: true, output: t("tool.no_results", { query }) };
    }
    return {
      success: true,
      // Сниппеты — тоже недоверенный текст (аудит §2.14).
      output: wrapUntrusted(
        url,
        t("tool.search_results", {
          query,
          results: formatResults(outcome.results),
        }),
      ),
      display: t("tool.web_search_result", {
        query,
        count: String(outcome.results.length),
      }),
    };
  },
};
