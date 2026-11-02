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
import { projectText } from "./project";
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
