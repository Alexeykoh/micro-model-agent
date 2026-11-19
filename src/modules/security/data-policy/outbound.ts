/**
 * Проекция произвольного внешнего egress, который **не** является LLM-вызовом:
 * поисковый запрос (`web_search`), запросы к внешним HTTP-сервисам. Та же
 * классификация и маски, что у E1 (INV-D1), но без псевдонимов: обратимость
 * нужна только LLM-вызову (ре-гидратация аргументов тула), а внешнему сервису
 * token id бесполезен и только раскрывал бы ключ карты токенов.
 *
 * Путь закрывает бывший долг по payload `web_search`; MCP остаётся отдельной
 * задачей, base64-обёртки — в `detectors/encoded.ts`, split — без надёжного
 * признака.
 */
import type { PolicyContext } from "./context";
import { projectDeep, projectText } from "./project";
import { isTrustedHost } from "./egress-provider";
import type { DataClass, DataPolicyConfig, EgressTarget } from "./types";
import { TokenMap } from "./tokens";

/** Результат проекции наружу. */
export interface OutboundProjection {
  text: string;
  changed: boolean;
  stats: Partial<Record<DataClass, number>>;
}

/**
 * Спроецировать текст для внешней цели. `target.trusted` — доверенный
 * loopback/allowlist: тогда маскируются только секреты (как в E1).
 */
export function projectOutboundText(
  text: string,
  config: DataPolicyConfig,
  target: EgressTarget,
  ctx: PolicyContext,
): OutboundProjection {
  if (!config.enabled || !text) return { text, changed: false, stats: {} };
  const projected = projectText(text, {
    config: { ...config, pseudonymize: false },
    target,
    ctx,
    map: new TokenMap(),
  });
  return { text: projected.text, changed: projected.changed, stats: projected.stats };
}

/**
 * Спроецировать произвольную структуру (аргументы MCP-тула) для внешней цели.
 * Маска без псевдонимов: удалённый сервер не участвует в ре-гидратации.
 */
export function projectOutboundDeep<T>(
  value: T,
  config: DataPolicyConfig,
  target: EgressTarget,
  ctx: PolicyContext,
): { value: T; changed: boolean; stats: Partial<Record<DataClass, number>> } {
  if (!config.enabled) return { value, changed: false, stats: {} };
  const projected = projectDeep(value, {
    config: { ...config, pseudonymize: false },
    target,
    ctx,
    map: new TokenMap(),
  });
  return { value: projected.messages, changed: projected.changed, stats: projected.stats };
}

/**
 * Внешний MCP-сервер: транспорт `http`/`sse` на не-доверенный хост. `stdio` —
 * локальный процесс, `loopback`/приватная сеть — доверенные (как у провайдера).
 * Не распарсили URL — считаем внешним (fail-closed, INV-D4).
 */
export function isExternalServiceUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return !isTrustedHost(host, []);
  } catch {
    return true;
  }
}
