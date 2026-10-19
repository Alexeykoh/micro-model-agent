/**
 * E1-адаптер движка DLP: фабрика `EgressGuard` для записей провайдера.
 *
 * Доверие определяется по **распарсенному** хосту `baseUrl` (loopback или
 * allowlist `security.dataPolicy.trustedHosts`), не по строке целиком (§6.2).
 * Фабрика читает живой конфиг на каждый билд, чтобы `setConfigValue` +
 * `provider.rebuild` подхватывали смену политики. Карта токенов общая для всех
 * записей процесса (INV-D11) — ре-гидратация работает и после failover.
 */
import type { AppConfig } from "../../../config/types";
import type { PolicyContext } from "./context";
import { createGuard } from "./guard";
import { DEFAULT_DATA_POLICY } from "./defaults";
import { TokenMap } from "./tokens";
import type { EgressGuard } from "./types";

/** Минимальный вид записи провайдера (security не импортирует providers-типы). */
export interface ProviderEntryRef {
  type: string;
  baseUrl: string;
}

/** Хост `baseUrl`: пробуем как есть, затем с `http://` (URL без схемы). */
export function providerHost(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  return hostOf(baseUrl) ?? hostOf(`http://${baseUrl}`);
}

function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Loopback-хост (localhost, 127/8, ::1, 0.0.0.0) — доверенный без allowlist. */
export function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** Доверенный ли хост: loopback или точное совпадение в allowlist. */
export function isTrustedHost(host: string, trustedHosts: readonly string[]): boolean {
  if (isLoopbackHost(host)) return true;
  return trustedHosts.some((entry) => {
    const listed = hostOf(entry) ?? entry.toLowerCase().replace(/^\[|\]$/g, "");
    return listed === host;
  });
}

/** Зависимости фабрики: живой конфиг + машинный контекст workspace. */
export interface ProviderEgressDeps {
  /** Живой конфиг (читается на каждый билд, чтобы hot-rebuild видел правку). */
  getConfig: () => AppConfig;
  ctx: PolicyContext;
}

/**
 * Собрать фабрику guard'ов для записей провайдера. Регистрируется в слое
 * провайдеров через `setEgressGuard` до первой сборки (провайдерная фаза
 * bootstrap) — покрывает и активную, и managed-фабрику (критик/эксперт, R17).
 */
export function createProviderEgressFactory(
  deps: ProviderEgressDeps,
): (entry: ProviderEntryRef) => EgressGuard<unknown, unknown> | undefined {
  const map = new TokenMap();
  return (entry) => {
    const config = deps.getConfig().security?.dataPolicy ?? DEFAULT_DATA_POLICY;
    if (!config.enabled) return undefined;
    const host = providerHost(entry.baseUrl);
    // Не смогли распарсить хост — считаем внешним (fail-closed), а не доверенным.
    const trusted = host !== undefined && isTrustedHost(host, config.trustedHosts);
    return createGuard({
      config,
      target: { kind: "provider", trusted, host },
      ctx: deps.ctx,
      map,
    });
  };
}
