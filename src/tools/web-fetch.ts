/** Тул чтения URL в markdown (plain HTTP, без JS; SSRF-защита, cap вывода). */
import { t } from "../i18n/index";
import type { ToolDefinition, ToolResult } from "./types";
import {
  BlockedRedirectError,
  fetchValidated,
  sanitizeUrl,
} from "../modules/security/network-validator";
import { logNetworkRequest, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { DEFAULT_SECURITY_CONFIG } from "../config/security";
import { MAX_PREVIEW_LINES } from "./preview";
import { extractReadableContent } from "./html-content";
import { httpError, networkError } from "./web-errors";
import { wrapUntrusted } from "./web-content";
import type { NetworkSecurityConfig } from "../config/types";

/** Максимум символов до обрезки вывода тула. */
const MAX_CHARS = 5000;

/** Параметры загрузки URL: конфиг сети, подмена fetch (тесты), сессия для аудита. */
export interface WebFetchOptions {
  securityConfig?: NetworkSecurityConfig;
  /** Точка подмены для тестов; по умолчанию глобальный `fetch`. */
  fetchImpl?: typeof fetch;
  sessionId?: string;
}

/**
 * Загрузка URL в текст (ядро тула, вынесено для тестируемости).
 */
export async function performWebFetch(
  url: string,
  opts: WebFetchOptions = {},
): Promise<ToolResult> {
  const { securityConfig, fetchImpl = fetch, sessionId } = opts;
  // SSRF проверяет ToolExecutor (INV-10) до хендлера; каждый хоп редиректа
  // перевадидируется внутри fetchValidated.
  try {
    const { response: finalResponse, finalUrl } = await fetchValidated(
      url,
      securityConfig,
      { signal: AbortSignal.timeout(securityConfig?.requestTimeout || 15000) },
      fetchImpl,
    );
    if (!finalResponse.ok) {
      logNetworkRequest(sessionId, sanitizeUrl(finalUrl), false, `Status: ${finalResponse.status}`);
      return httpError(finalUrl, finalResponse.status, finalResponse.statusText);
    }
    const contentType = finalResponse.headers.get("content-type") || "";
    const text = await finalResponse.text();
    const isHtml = contentType.includes("html");
    const extracted = isHtml ? extractReadableContent(text) : null;
    const cleaned = extracted ? extracted.text : text;

    logNetworkRequest(sessionId, sanitizeUrl(finalUrl), true, `Status: ${finalResponse.status}`);

    // JS-шелл: много разметки, почти нет текста — не выдаём навигацию за
    // данные. distinct-сигнал (не success), чтобы модель ушла на browser.
    if (extracted?.shell) {
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
    // Кап — ИНСТРУМЕНТНЫЙ (5000 символов), а не глобальный сетевой: тот
    // обслуживает download_file, где лимит задаёт max_bytes.
    const maxChars = MAX_CHARS;

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
      // Содержимое страницы — недоверенные данные: рамка отделяет их от
      // инструкций (аудит §2.14).
      output: content ? wrapUntrusted(finalUrl, content) : t("file.empty_page"),
      display: t("tool.web_fetch_result", {
        url: sanitizeUrl(url),
        chars: String(fullChars),
        lines: String(fullLines),
        truncated,
      }),
    };
  } catch (e: any) {
    if (e instanceof BlockedRedirectError) {
      logSecurityBlock(sessionId, "network_request", e.reason, sanitizeUrl(url));
      return { success: false, output: `[SECURITY BLOCKED] redirect: ${e.reason}` };
    }
    logNetworkRequest(sessionId, sanitizeUrl(url), false, `Error: ${e.message}`);
    return networkError(url, e.message);
  }
}

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
    return performWebFetch(url, { securityConfig, sessionId: ctx.sessionId });
  },
};
