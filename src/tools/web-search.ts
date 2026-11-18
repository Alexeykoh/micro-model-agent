/** Веб-поиск: тул `web_search` и shared-функция для автопоиска ошибок. */
import { t } from "../i18n/index";
import type { ToolDefinition, ToolContext } from "./types";
import type { NetworkSecurityConfig } from "../config/types";
import { isUrlAllowed, sanitizeUrl } from "../modules/security/network-validator";
import { logNetworkRequest, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { machinePolicyContext } from "../modules/security/data-policy/context";
import { projectOutboundText } from "../modules/security/data-policy/outbound";
import { wrapUntrusted } from "./web-content";
import {
  clampResultCount,
  planSearchRequest,
  type SearchResult,
  type WebSearchProviderOptions,
} from "./search-providers";

export type { SearchResult, WebSearchProviderOptions } from "./search-providers";
export type { WebSearchProvider } from "../config/web-search-provider";
export { unwrapDdgUrl } from "./search-providers";

/** Итог поиска: успех, результаты, ошибка. */
export interface WebSearchOutcome {
  success: boolean;
  results: SearchResult[];
  error?: string;
  /** true — URL отклонён security-политикой (не I/O-ошибка). */
  blocked?: boolean;
  /** URL реально запрошенного провайдера (аудит, provenance выдачи). */
  url?: string;
}

/** Задержка перед единственным ретраем на 429/503. */
const RETRY_DELAY_MS = 800;

/** Пауза перед ретраем. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Общий веб-поиск для тула `web_search` и автопоиска ошибок (execution-модуль).
 * Провайдер выбирается `providerOptions` (webSearch.provider); `networkConfig` —
 * резолвленная сетевая security-конфигурация (undefined при выключенной
 * безопасности); `requestTimeoutMs` переопределяет таймаут, когда у вызывающего
 * свой (автопоиск — errorWebSearch.requestTimeoutMs).
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
  providerOptions?: WebSearchProviderOptions,
): Promise<WebSearchOutcome> {
  // DLP (E1-семантика): запрос уже спроецирован `projectSearchQuery`.
  const plan = planSearchRequest(providerOptions, query, numResults);
  if (!plan.ok) return { success: false, results: [], error: plan.error };
  const validation = isUrlAllowed(plan.url, networkConfig);
  if (!validation.allowed) {
    return {
      success: false,
      blocked: true,
      results: [],
      url: plan.url,
      error: validation.reason || "URL blocked by security policy",
    };
  }
  const timeoutMs = requestTimeoutMs ?? networkConfig?.requestTimeout ?? 10000;
  try {
    let response = await fetchImpl(plan.url, {
      ...plan.init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Один ретрай на 429/503: поисковик часто отвечает «слишком много
    // запросов», и повтор через 800 мс почти всегда проходит.
    if (response.status === 429 || response.status === 503) {
      await sleep(RETRY_DELAY_MS);
      response = await fetchImpl(plan.url, {
        ...plan.init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    if (!response.ok) {
      return {
        success: false,
        results: [],
        url: plan.url,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    const body = await response.text();
    return {
      success: true,
      results: plan.parse(body, clampResultCount(numResults)),
      url: plan.url,
    };
  } catch (err: unknown) {
    return {
      success: false,
      results: [],
      url: plan.url,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Форматирует выдачу нумерованным списком. */
function formatResults(results: SearchResult[]): string {
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
    .join("\n");
}

/** Ищет в вебе (заголовки + сниппеты); поисковики открывать не надо. */
/**
 * DLP: запрос уходит во внешний поисковик — маскируем его до сети.
 * Семантика E1 (классы, `minConfidence`, флаг `egress.secrets`), но без
 * псевдонимов: отдать поисковику token id бессмысленно и раскрывает ключ.
 * Ошибка классификатора при `failClosed` не выпускает запрос вообще —
 * «не смогли проверить» не равно «можно отправлять» (INV-D4).
 */
export function projectSearchQuery(raw: string, ctx: ToolContext): string {
  const policy = ctx.config?.security?.dataPolicy;
  if (!policy?.enabled || !raw) return raw;
  try {
    return projectOutboundText(
      raw,
      policy,
      { kind: "api", trusted: false },
      machinePolicyContext(ctx.baseDir),
    ).text;
  } catch {
    return policy.failClosed ? "[query hidden by DLP]" : raw;
  }
}

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
    const rawQuery = String(args.query || "");
    const query = projectSearchQuery(rawQuery, ctx);
    const numResults = Number(args.numResults) || 5;
    const ws = ctx.config?.webSearch;
    const providerOptions: WebSearchProviderOptions = {
      provider: ws?.provider,
      apiKey: ws?.apiKey,
      baseUrl: ws?.baseUrl,
    };

    const securityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(ctx.config, ctx.sessionContext).network
      : ctx.config.security?.network;

    const outcome = await performWebSearch(
      query,
      numResults,
      securityConfig,
      undefined,
      undefined,
      providerOptions,
    );
    // Конфигурационная ошибка провайдера: запроса не было — сеть не логируем.
    if (!outcome.url) {
      return {
        success: false,
        output: t("error.search_failed", { message: String(outcome.error ?? "") }),
      };
    }
    const url = outcome.url;
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
