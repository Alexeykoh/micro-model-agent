// Политика URL для браузера: нормализация и SSRF-проверка до навигации.
//
// Вынесено из `session.ts`: правило «что можно открывать» живёт отдельно от
// механики сессии, а файл сессии не растёт (правило 6 AGENTS).
import { isUrlAllowedAsync } from "../security/network-validator";
import type { NetworkSecurityConfig } from "../../config/types";

/** Итог проверки URL для браузера. */
export type UrlPolicyResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * Проверяет URL, который модель просит открыть (аудит §2.3):
 * - опасные схемы (file:, chrome:, about:, data:, javascript:) — блок;
 * - приватные адреса и metadata-эндпоинты облака — блок (SSRF);
 * - адрес без схемы — достраивается `https://`.
 */
export async function checkBrowserUrl(
  rawUrl: string,
  networkSecurity?: NetworkSecurityConfig,
): Promise<UrlPolicyResult> {
  const url = rawUrl.trim();
  if (!url) return { ok: false, reason: "URL is required" };
  if (/^(file|chrome|about|data|javascript|view-source):/i.test(url)) {
    return { ok: false, reason: `scheme not allowed: ${url}` };
  }
  const normalized =
    url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;
  const check = await isUrlAllowedAsync(normalized, networkSecurity);
  if (!check.allowed) return { ok: false, reason: check.reason || "URL not allowed" };
  return { ok: true, url: normalized };
}
