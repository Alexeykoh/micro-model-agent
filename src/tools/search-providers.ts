/**
 * Провайдеры веб-поиска: DuckDuckGo HTML (default, без ключа), Tavily API и
 * SearXNG. Модуль только планирует HTTP-запрос и разбирает тело ответа:
 * `performWebSearch` (`web-search.ts`) валидирует URL сетевой политикой,
 * ретраит 429/503 и приводит ошибки к одному контракту.
 */
import { t } from "../i18n/index";
import { readMmaVersion } from "../core/version";
import { WEB_SEARCH_PROVIDERS, type WebSearchProvider } from "../config/web-search-provider";

export type { WebSearchProvider };

/** Элемент выдачи: заголовок, URL, сниппет. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Провайдер-специфичные поля `webSearch` (ключ и адрес инстанса). */
export interface WebSearchProviderOptions {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Запросить URL картинок выдачи (webSearch.images). */
  images?: boolean;
}

/** Готовый запрос: URL (для allowlist/SSRF), init и парсер тела. */
export interface SearchRequestPlan {
  ok: true;
  url: string;
  init: RequestInit;
  parse(body: string, numResults: number): SearchParsed;
}

/** Разобранная выдача: результаты + URL картинок (если провайдер их дал). */
export interface SearchParsed {
  results: SearchResult[];
  images: string[];
}

/** Провайдер не сконфигурирован: сеть не трогаем, пользователю — причина. */
export interface SearchRequestFailure {
  ok: false;
  error: string;
}

/** URL API Tavily (ключ уходит заголовком, не в query). */
const TAVILY_URL = "https://api.tavily.com/search";

/** User-Agent: поисковики режут запросы без него. */
function userAgent(): string {
  return `micro-models-agent/${readMmaVersion()}`;
}

/** Число результатов: целое 1..20 (вне диапазона — честный клэмп). */
export function clampResultCount(n: number): number {
  const value = Math.floor(Number(n));
  if (!Number.isFinite(value)) return 5;
  return Math.min(20, Math.max(1, value));
}

/** Неизвестное значение из конфига (старый/битый файл) — default DDG. */
export function resolveProvider(options?: WebSearchProviderOptions): WebSearchProvider {
  const value = options?.provider;
  return WEB_SEARCH_PROVIDERS.includes(value as WebSearchProvider)
    ? (value as WebSearchProvider)
    : "duckduckgo";
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

/** Разбор HTML-выдачи DDG: заголовок + сниппет в одной паре узлов. */
function parseDdg(body: string, numResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const snippetRegex =
    /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = snippetRegex.exec(body)) !== null && results.length < numResults) {
    results.push({
      url: unwrapDdgUrl(match[1].trim()),
      title: match[2].replace(/<[^>]+>/g, "").trim(),
      snippet: match[3].replace(/<[^>]+>/g, "").trim(),
    });
  }
  return results;
}

/** Строковое поле JSON-выдачи; отсутствующее/нестроковое — "". */
function field(row: Record<string, unknown>, name: string): string {
  const v = row[name];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Разбор JSON-конверта `{results: [...], images?: [...]}` (Tavily и SearXNG
 * делят форму). Битый JSON — ошибка, а не «пустая выдача».
 */
function parseJsonEnvelope(body: string, provider: WebSearchProvider): {
  results: Record<string, unknown>[];
  images: string[];
} {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(t("error.search_bad_response", { provider }));
  }
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const rows = Array.isArray(obj.results) ? (obj.results as unknown[]) : [];
  const imgUrls = Array.isArray(obj.images)
    ? (obj.images as unknown[]).filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
  return {
    results: rows.filter((r): r is Record<string, unknown> => !!r && typeof r === "object"),
    images: imgUrls.map((v) => v.trim()),
  };
}

/** `{title, url, content}` → элементы выдачи (до `numResults`). */
function mapRows(rows: Record<string, unknown>[], numResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  for (const row of rows) {
    if (results.length >= numResults) break;
    const url = field(row, "url");
    if (!url) continue;
    results.push({
      title: field(row, "title") || url,
      url,
      snippet: field(row, "content"),
    });
  }
  return results;
}

/** Строки без дублей и пустых значений. */
function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/** Tavily: выдача + `images` (при `include_images`). */
function parseTavily(body: string, numResults: number): SearchParsed {
  const env = parseJsonEnvelope(body, "tavily");
  return { results: mapRows(env.results, numResults), images: dedupeStrings(env.images) };
}

/** SearXNG: выдача + `img_src`/`thumbnail_src` строк. */
function parseSearxng(body: string, numResults: number): SearchParsed {
  const env = parseJsonEnvelope(body, "searxng");
  const images = env.results.flatMap((row) => {
    const src = field(row, "img_src") || field(row, "thumbnail_src");
    return src ? [src] : [];
  });
  return { results: mapRows(env.results, numResults), images: dedupeStrings(images) };
}

/** База SearXNG: только абсолютный http(s) URL, без хвостового слэша. */
function searxngBase(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Планирует запрос выбранного провайдера. Конфигурационные ошибки (нет ключа
 * Tavily, нет/битый `baseUrl` SearXNG) — явный отказ, а не тихий fallback на
 * другой источник: пользователь должен видеть, что выбранный провайдер не готов.
 */
export function planSearchRequest(
  options: WebSearchProviderOptions | undefined,
  query: string,
  numResults: number,
): SearchRequestPlan | SearchRequestFailure {
  const provider = resolveProvider(options);
  const count = clampResultCount(numResults);
  if (provider === "tavily") {
    const apiKey = (options?.apiKey ?? "").trim();
    if (!apiKey) return { ok: false, error: t("error.search_key_missing", { provider }) };
    return {
      ok: true,
      url: TAVILY_URL,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "user-agent": userAgent(),
        },
        body: JSON.stringify({
          query,
          max_results: count,
          search_depth: "basic",
          ...(options?.images ? { include_images: true } : {}),
        }),
      },
      parse: parseTavily,
    };
  }
  if (provider === "searxng") {
    const base = searxngBase(options?.baseUrl);
    if (!base) return { ok: false, error: t("error.search_base_url_invalid", { provider }) };
    return {
      ok: true,
      url: `${base}/search?q=${encodeURIComponent(query)}&format=json`,
      init: { headers: { "user-agent": userAgent() } },
      parse: parseSearxng,
    };
  }
  return {
    ok: true,
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    init: { headers: { "user-agent": userAgent() } },
    parse: (body, n) => ({ results: parseDdg(body, n), images: [] }),
  };
}
