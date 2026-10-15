/**
 * Политика исходящих HTTP-вызовов каркаса (спека W13, решение D5).
 *
 * `isUrlAllowed` защищает вызовы, инициированные моделью (INV-10, в
 * `ToolExecutor`). Здесь — вызовы, которые делает сам каркас: webhook
 * нотификатора аудита и push-доставка Job-объекта. Их адресат приходит из
 * конфига или из тела HTTP-запроса, то есть из недоверенного источника для
 * `mma serve` без токена.
 *
 * Политика fail-closed и **не зависит** от `security.network.enabled`: тот флаг
 * описывает модельные вызовы, и его выключение не открывает внутреннюю сеть для
 * каркаса. Loopback и приватные диапазоны запрещены, пока пользователь явно не
 * поднимет `security.network.allowPrivateOutbound` — он снимает и SSRF-проверку,
 * и дефолтные deny-записи loopback-адресов, иначе флаг был бы недостижим.
 * Прочие доменные записи deny/allow пользователя флаг не трогает.
 */
import type { NetworkSecurityConfig } from "../../config/types";
import type { Diagnostic } from "../../output/types";
import { isIpPrivate, type NetworkValidationResult } from "./network-validator";

/** Вход проверки исходящего вызова. */
export interface OutboundPolicyOptions {
  /** Доменная политика и флаг `allowPrivateOutbound`; undefined — только базовые правила. */
  networkConfig?: NetworkSecurityConfig;
  /** Операция для диагностики: `"audit.webhook"`, `"service.callback"`. */
  operation: string;
  /** Куда записать отказ (INV-14). Без sink отказ всё равно бросается. */
  onDiagnostic?: (diag: Diagnostic) => void;
}

/** Отказ политики исходящих вызовов: до сетевого вызова, ретраям не подлежит. */
export class OutboundPolicyError extends Error {
  constructor(
    public readonly reason: string,
    public readonly operation: string,
  ) {
    super(`outbound blocked (${operation}): ${reason}`);
    this.name = "OutboundPolicyError";
  }
}

/** Диагностика отказа (INV-13/INV-14): причина обязательна, иначе «сломано» = «не было». */
function blockedDiagnostic(source: Diagnostic["source"], opts: OutboundPolicyOptions, reason: string): Diagnostic {
  return {
    source,
    operation: opts.operation,
    kind: "blocked",
    cause: reason,
    recoverable: false,
  };
}

/**
 * Разрешён ли адресат исходящего вызова каркаса.
 *
 * Порядок: схема → приватный адрес (если не разрешён флагом) → доменные списки.
 * Доменные списки применяются только при `security.network.enabled`, иначе флаг
 * доменов не имеет смысла.
 */
export function checkOutboundUrl(
  url: string,
  source: Diagnostic["source"],
  opts: OutboundPolicyOptions,
): NetworkValidationResult {
  const deny = (reason: string): NetworkValidationResult => {
    opts.onDiagnostic?.(blockedDiagnostic(source, opts, reason));
    return { allowed: false, reason };
  };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny(`invalid URL: ${url}`);
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    return deny(`scheme "${scheme}" is not allowed`);
  }

  const host = parsed.hostname.toLowerCase();
  const allowPrivate = opts.networkConfig?.allowPrivateOutbound === true;
  if (isIpPrivate(host) && !allowPrivate) {
    return deny(`private address "${host}" is blocked (SSRF)`);
  }

  const net = opts.networkConfig;
  if (!net?.enabled) return { allowed: true };

  for (const denied of net.deniedDomains ?? []) {
    const d = denied.toLowerCase();
    // Дефолтный deny-list перечисляет те же loopback-адреса, что и SSRF-проверка.
    // Явный `allowPrivateOutbound` снимает оба — иначе флаг был бы недостижим.
    if (allowPrivate && isIpPrivate(d)) continue;
    if (host === d || host.endsWith(`.${d}`)) return deny(`domain "${host}" is denied`);
  }

  const allowed = net.allowedDomains ?? [];
  if (allowed.length > 0 && !allowed.some((a) => host === a.toLowerCase() || host.endsWith(`.${a.toLowerCase()}`))) {
    return deny(`domain "${host}" is not in the allowed list`);
  }

  return { allowed: true };
}

/**
 * `fetch` через политику исходящих вызовов: проверка ДО сетевого вызова, отказ —
 * {@link OutboundPolicyError} (ретраям не подлежит: адресат не изменится).
 */
export async function fetchOutbound(
  url: string,
  source: Diagnostic["source"],
  opts: OutboundPolicyOptions,
  init: RequestInit = {},
): Promise<Response> {
  const check = checkOutboundUrl(url, source, opts);
  if (!check.allowed) throw new OutboundPolicyError(check.reason || "URL not allowed", opts.operation);
  return fetch(url, init);
}