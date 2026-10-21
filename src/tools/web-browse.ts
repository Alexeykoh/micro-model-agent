/** Тул чтения веб-страницы в plain text (без JS; SSRF-защита, cap вывода). */
import { t } from "../i18n/index";
import type { ToolDefinition, ToolResult } from "./types";
import {
  BlockedRedirectError,
  fetchValidated,
  sanitizeUrl,
} from "../modules/security/network-validator";
import { logNetworkRequest, logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { MAX_PREVIEW_LINES } from "./preview";
import { extractReadableContent, htmlToText } from "./html-content";
import { httpError, networkError } from "./web-errors";
import type { NetworkSecurityConfig } from "../config/types";

/** Потолок символов до построчной обрезки. */
const MAX_CHARS = 3000;

/** Параметры загрузки страницы: конфиг сети, подмена fetch (тесты), сессия. */
export interface WebBrowseOptions {
  securityConfig?: NetworkSecurityConfig;
  /** Точка подмены для тестов; по умолчанию глобальный `fetch`. */
  fetchImpl?: typeof fetch;
  sessionId?: string;
}

/**
 * Чтение страницы целиком (ядро тула, вынесено для тестируемости).
 *
 * Отличие от `web_fetch`: страница берётся целиком (границы блоков сохраняются
 * переводами строк), без извлечения main-контента. Статус проверяется ДО
 * чтения тела — 404 это ошибка, а не контент (аудит §2.2).
 */
export async function performWebBrowse(
  url: string,
  opts: WebBrowseOptions = {},
): Promise<ToolResult> {
  const { securityConfig, fetchImpl = fetch, sessionId } = opts;
  try {
    const { response } = await fetchValidated(
      url,
      securityConfig,
      { signal: AbortSignal.timeout(securityConfig?.requestTimeout || 15000) },
      fetchImpl,
    );
    if (!response.ok) {
      logNetworkRequest(sessionId, sanitizeUrl(url), false, `Status: ${response.status}`);
      return httpError(url, response.status, response.statusText);
    }
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    const isHtml = contentType.includes("html");
    // Строка страницы целиком: границы блоков сохраняются (переводы строк),
    // иначе модель получала 3000 символов навигации одной строкой.
    const stripped = isHtml ? htmlToText(text) : text;
    const extracted = isHtml ? extractReadableContent(text) : null;

    logNetworkRequest(sessionId, sanitizeUrl(url), true, `Status: ${response.status}`);

    if (extracted?.shell) {
      return {
        success: false,
        output: t("tool.web_fetch_no_content", { url: sanitizeUrl(url) }),
        display: t("tool.web_browse_result", {
          url: sanitizeUrl(url),
          chars: "0",
          lines: "0",
          truncated: "",
        }),
      };
    }

    const fullChars = stripped.length;
    const fullLines = stripped.split("\n").length;
    // Кап — инструментный (3000 символов), не глобальный сетевой.
    const maxChars = MAX_CHARS;

    let content: string;
    if (stripped.length > maxChars) {
      content = stripped.slice(0, maxChars) + t("file.truncated");
    } else {
      content = stripped;
    }
    const contentLines = content.split("\n");
    if (contentLines.length > MAX_PREVIEW_LINES) {
      content =
        contentLines.slice(0, MAX_PREVIEW_LINES).join("\n") +
        `\n... (${contentLines.length - MAX_PREVIEW_LINES} more lines)`;
    }
    const truncated =
      stripped.length > maxChars || fullLines > MAX_PREVIEW_LINES
        ? t("file.truncated").trim()
        : "";

    return {
      success: true,
      output: content || t("file.empty_page"),
      display: t("tool.web_browse_result", {
        url: sanitizeUrl(url),
        chars: String(fullChars),
        lines: String(fullLines),
        truncated,
      }),
    };
  } catch (err: any) {
    if (err instanceof BlockedRedirectError) {
      logSecurityBlock(sessionId, "network_request", err.reason, sanitizeUrl(url));
      return { success: false, output: `[SECURITY BLOCKED] redirect: ${err.reason}` };
    }
    logNetworkRequest(sessionId, sanitizeUrl(url), false, `Error: ${err.message}`);
    return networkError(url, err.message);
  }
}

/** Читает страницу в plain text; JS-приложения вернут пустоту — для них browser. */
export const webBrowseTool: ToolDefinition = {
  name: "web_browse",
  security: { caps: [{ net: true }], urlArgs: ["url"] },
  icon: "🌐",
  description: `Fetch and read a web page. Returns the whole page as plain text (max ${MAX_PREVIEW_LINES} lines / ${MAX_CHARS} chars). This is a plain HTTP request — it does NOT execute JavaScript, so JS-rendered single-page apps (weather sites, dashboards, modern SPAs) return empty or near-empty content. For such pages use the "browser" tool instead.`,
  tags: ["research"],
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
    },
    required: ["url"],
  },
  handler: async (ctx, args) => {
    const url = String(args.url || "");
    const securityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(ctx.config, ctx.sessionContext).network
      : ctx.config.security?.network;
    return performWebBrowse(url, { securityConfig, sessionId: ctx.sessionId });
  },
};
