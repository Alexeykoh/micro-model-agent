// Политика проб провайдера из веб-визарда: SSRF-защита и rate-limit.
//
// Проба провайдера — исходящий запрос от машины пользователя по URL, который
// прислал браузер. Без проверки это SSRF (в т.ч. к метаданным облака) и
// бесплатный прокси (аудит §6.9).
import { isMetadataHost } from "../../security/ip-guard";

/** Сколько проб в минуту допустимо с одного адреса. */
export const SETUP_PROBE_RATE_PER_MIN = 10;

/** Окно rate-limit, мс. */
const RATE_WINDOW_MS = 60_000;

/** Счётчики проб: ключ `ip` → { count, resetAt }. */
const counters = new Map<string, { count: number; resetAt: number }>();

/**
 * Проверка baseUrl провайдера перед пробой.
 *
 * @returns текст ошибки или `undefined`, если адрес можно пробовать.
 */
export async function validateProviderBaseUrl(baseUrl: string): Promise<string | undefined> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "invalid-base-url";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "invalid-base-url";
  }
  const host = url.hostname;
  // Локальные провайдеры (Ollama/LM Studio на 127.0.0.1) легальны — визард
  // для них и существует. А вот метаданные облака — нет.
  if (isMetadataHost(host)) {
    return "blocked-host";
  }
  if (!isIpLiteral(host)) {
    const addresses = await resolveAll(host);
    if (addresses.some((address) => isMetadataHost(address))) {
      return "blocked-host";
    }
  }
  return undefined;
}

/** Резолв хоста в адреса (пустой список при ошибке). */
async function resolveAll(host: string): Promise<string[]> {
  try {
    const { lookup } = await import("node:dns/promises");
    const rows = await lookup(host, { all: true });
    return rows.map((row) => row.address);
  } catch {
    return [];
  }
}

/** Локальный IP — не считается «интернет-адресом» для rate-limit. */
function isIpLiteral(host: string): boolean {
  return /^[0-9.]+$/.test(host) || host.includes(":");
}

/**
 * Rate-limit проб: не больше `SETUP_PROBE_RATE_PER_MIN` в минуту с одного IP.
 *
 * Считается по паре «клиент + маршрут»: визард шлёт несколько проб разных
 * маршрутов (models/test/context), и они не должны съедать лимит друг друга.
 *
 * @returns true, если запрос можно обработать.
 */
export function allowSetupProbe(clientKey: string): boolean {
  const now = Date.now();
  const entry = counters.get(clientKey);
  if (!entry || now > entry.resetAt) {
    counters.set(clientKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= SETUP_PROBE_RATE_PER_MIN) return false;
  entry.count++;
  return true;
}

/** Сброс счётчиков — для тестов. */
export function resetSetupProbeRateLimit(): void {
  counters.clear();
}
