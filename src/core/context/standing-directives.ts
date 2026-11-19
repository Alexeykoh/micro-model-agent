/**
 * Стоящие директивы харнесса (§1.5 аудита).
 *
 * Директивы вставляются в контекст как `<system-summary>`, который компакция
 * вырезает; реестр (`ContextManager.standingDirectives`, карта `id → текст`)
 * позволяет вернуть их после компакции. Операция «вернуть» — здесь, чтобы
 * менеджер контекста не рос (§6 правила о размере файлов).
 */
import type { Message } from "./message";
import { getMessageText } from "../../llm/provider";

/** Реестр директив: `id → текст директивы`. */
export type StandingDirectiveMap = Map<string, string>;

/**
 * Возвращает текст директив, которых нет в истории (одним сообщением), либо
 * undefined, если все директивы уже в контексте.
 */
export function reassertStandingDirectives(
  registry: StandingDirectiveMap,
  messages: Message[],
): string | undefined {
  if (registry.size === 0) return undefined;
  const present = messages.map((m) => getMessageText(m.content)).join("\n");
  const missing = [...registry.values()].filter((text) => text && !present.includes(text));
  if (missing.length === 0) return undefined;
  return missing.join("\n");
}
