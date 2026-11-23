/**
 * Учёт повторных загрузок одного домена за ход. Отличается от
 * `duplicateBatches`: сессия GYM24 делала 9 web_fetch на разные URL, но
 * фактически перечитывала те же источники — канонический ключ вызова это
 * не ловил, и `wastefulToolCalls` оставался нулевым.
 */
/** С какого повторного загрузки домена считаем вызов напрасным. */
export const WEB_REPEAT_WASTE_THRESHOLD = 3;

const hostCounts = new Map<string, number>();

/** Учесть загрузку URL; true — этот вызов уже напрасный. */
export function recordWebFetchHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const count = (hostCounts.get(host) ?? 0) + 1;
  hostCounts.set(host, count);
  return count > WEB_REPEAT_WASTE_THRESHOLD;
}

/** Сброс между ходами/тестами. */
export function resetWebRepeat(): void {
  hostCounts.clear();
}

/** Хелпер для lifecycle вызова: одна строка в tool-batch-calls. */
export function recordWebWaste(
  state: { wastefulToolCalls: number },
  toolName: string,
  args: Record<string, unknown> | undefined,
): void {
  if (
    (toolName === "web_fetch" || toolName === "web_browse") &&
    typeof args?.url === "string" &&
    recordWebFetchHost(args.url)
  ) {
    state.wastefulToolCalls++;
  }
}
