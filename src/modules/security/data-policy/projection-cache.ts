/**
 * Кеш проекции на карту токенов (map — одна на фабрику guard'а, значит на
 * процесс). Вынесено из `project.ts` (правило ≤300).
 *
 * Ключ включает всё, что влияет на результат, кроме самого текста: доверие
 * цели, режим пути, классы, glob-списки, порог уверенности. Иначе смена
 * конфига оставила бы замаскированный ответ по старой политике.
 *
 * Замер до кеша: 4.7 мс на сообщение 1.9 КБ; история 100 сообщений ≈ 0.47 с на
 * каждый LLM-вызов. После: 0.007 мс на повторной проекции.
 */
import type { ProjectPolicy, TextProjection } from "./project";
import type { TokenMap } from "./tokens";

const cache = new WeakMap<TokenMap, Map<string, TextProjection>>();
const MAX_ENTRIES = 2048;

function keyOf(text: string, policy: ProjectPolicy): string {
  const c = policy.config;
  return `${JSON.stringify([
    policy.target.kind,
    policy.target.trusted,
    c.pathMode,
    c.pseudonymize,
    c.egress,
    c.apiHiddenGlobs,
    c.providerBlockGlobs,
    c.minConfidence,
  ])}\0${text}`;
}

/** Готовая проекция этого текста для этой политики, если уже считали. */
export function cachedProjection(
  map: TokenMap,
  policy: ProjectPolicy,
  text: string,
): TextProjection | undefined {
  return cache.get(map)?.get(keyOf(text, policy));
}

/** Запомнить проекцию (с вытеснением самого старого ключа). */
export function rememberProjection(
  map: TokenMap,
  policy: ProjectPolicy,
  text: string,
  result: TextProjection,
): void {
  let bucket = cache.get(map);
  if (!bucket) {
    bucket = new Map();
    cache.set(map, bucket);
  }
  bucket.set(keyOf(text, policy), result);
  if (bucket.size > MAX_ENTRIES) {
    const oldest = bucket.keys().next().value;
    if (oldest !== undefined) bucket.delete(oldest);
  }
}
