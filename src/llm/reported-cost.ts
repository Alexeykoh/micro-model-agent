/** Стоимость вызова, которую провайдер сообщил сам (авторитетнее оценки). */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Достаёт стоимость вызова из ответа провайдера.
 *
 * OpenCode Go кладёт её в `opencode.list_cost` (цена по прайсу провайдера с
 * учётом кеша); часть провайдеров — в `usage.cost`. Оценка по токенам
 * используется только когда этих полей нет (INV: показанная цена должна
 * сходиться с биллингом).
 */
export function parseReportedCost(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined;
  const opencode = payload.opencode;
  if (isRecord(opencode)) {
    const value = cost(opencode.list_cost) ?? cost(opencode.cost);
    if (value !== undefined) return value;
  }
  const usage = payload.usage;
  if (isRecord(usage)) {
    return cost(usage.cost) ?? cost(usage.total_cost);
  }
  return undefined;
}
