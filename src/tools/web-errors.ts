// Единый формат ошибок web-тулов (аудит §2.10–§2.13): сообщение называет URL
// и код, `errorMeta` даёт машиночитаемый код и признак ретрая.
//
// Раньше каждый web-тул формировал ошибку по-своему (`error.http`, `error.
// fetch_failed`, `error.fetch_url_failed`), и модель не могла понять, какой из
// трёх запросов не удался и стоит ли повторять.
import { t } from "../i18n/index";
import { sanitizeUrl } from "../modules/security/network-validator";
import type { ToolResult } from "./types";

/** HTTP-ошибка: URL + статус + машиночитаемый код. */
export function httpError(url: string, status: number, statusText: string): ToolResult {
  return {
    success: false,
    output: t("error.fetch_http", {
      url: sanitizeUrl(url),
      status: String(status),
      statusText: statusText || String(status),
    }),
    errorMeta: {
      code: `http_${status}`,
      retryable: status === 429 || status >= 500,
    },
  };
}

/** Сетевая ошибка (таймаут, DNS, обрыв) — с URL и признаком ретрая. */
export function networkError(url: string, message: string): ToolResult {
  return {
    success: false,
    output: t("error.fetch_network", {
      url: sanitizeUrl(url),
      message,
    }),
    errorMeta: { code: "fetch_failed", retryable: true },
  };
}
