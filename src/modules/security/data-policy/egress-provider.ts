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
import { isIpPrivate } from "../ip-guard";
import type { PolicyContext } from "./context";
import { createGuard } from "./guard";
import { DEFAULT_DATA_POLICY } from "./defaults";
import { TokenMap } from "./tokens";
import type { EgressGuard, EgressTarget, GuardDiagnostic } from "./types";
import { noteEgressTarget } from "./turn-journal";

/** Минимальный вид записи провайдера (security не импортирует providers-типы). */
export interface ProviderEntryRef {
  type: string;
  baseUrl: string;
  /** Сессия, для которой собирается провайдер (маршрутизация журнала DLP). */
  sessionId?: string;
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

/**
 * Хост в локальной сети/VPN: приватные и служебные диапазоны IPv4/IPv6.
 * Такой провайдер (LM Studio/Ollama на другой машине, Hamachi, Tailscale-LAN)
 * не является внешним egress — пути к проекту ему нужны как есть. Hamachi
 * исторически раздаёт адреса из 25.0.0.0/8, поэтому он тоже локальный.
 */
export function isLocalNetworkHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIpPrivate(h)) return true;
  // Hamachi legacy 25/8 (не покрыт стандартными private-диапазонами).
  return /^25\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** IPv4-литерал → 32-битное число; не литерал — undefined. */
function ipv4ToInt(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n < 0 || n > 255) return undefined;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/** Совпадает ли IPv4-хост с CIDR-записью (`10.0.0.0/8`). */
function matchesIpv4Cidr(host: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  if (bitsRaw === undefined) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const hostInt = ipv4ToInt(host);
  const baseInt = ipv4ToInt(base);
  if (hostInt === undefined || baseInt === undefined) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (hostInt & mask) === (baseInt & mask);
}

/** Запись allowlist совпала с хостом: точное имя, `*.corp`/`.corp` или IP/CIDR. */
function hostMatchesEntry(host: string, entry: string): boolean {
  const listed = (hostOf(entry) ?? entry).toLowerCase().replace(/^\[|\]$/g, "");
  if (!listed) return false;
  if (listed === host) return true;
  // Маска подсети (`10.0.0.0/8`) — только для IP-литералов.
  if (listed.includes("/") && matchesIpv4Cidr(host, listed)) return true;
  // Маска домена: `*.corp` или `.corp` (spec §6, «маска .corp»).
  const suffix = listed.startsWith("*.") ? listed.slice(1) : listed.startsWith(".") ? listed : "";
  return suffix.length > 1 && host.endsWith(suffix);
}

/**
 * Доверенный ли хост: loopback, локальная сеть/VPN или совпадение в allowlist
 * (точное имя, `*.corp`/`.corp`, IP или CIDR).
 */
export function isTrustedHost(host: string, trustedHosts: readonly string[]): boolean {
  if (isLoopbackHost(host) || isLocalNetworkHost(host)) return true;
  return trustedHosts.some((entry) => hostMatchesEntry(host, entry));
}

/** Зависимости фабрики: живой конфиг + машинный контекст workspace. */
export interface ProviderEgressDeps {
  /** Живой конфиг (читается на каждый билд, чтобы hot-rebuild видел правку). */
  getConfig: () => AppConfig;
  ctx: PolicyContext;
}

/**
 * Приёмник диагностики guard'а. Живёт отдельно от фабрики, потому что
 * `SessionManager` создаётся позже провайдерной фазы; session-фаза выставляет
 * его через `setEgressDiagnosticSink` (INV-15: fail-open не молчит).
 */
let diagnosticSink: ((d: GuardDiagnostic) => void) | null = null;

/** Зарегистрировать приёмник диагностики egress (null — отключить). */
export function setEgressDiagnosticSink(sink: ((d: GuardDiagnostic) => void) | null): void {
  diagnosticSink = sink;
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
    const target: EgressTarget = { kind: "provider", trusted, host };
    // Назначение нужно и чистому ходу (0 редакций) — запоминаем при сборке.
    noteEgressTarget(entry.sessionId, target);
    return createGuard({
      config,
      target,
      ctx: deps.ctx,
      map,
      onDiagnostic: (d) =>
        diagnosticSink?.(entry.sessionId ? { ...d, sessionId: entry.sessionId } : d),
    });
  };
}
