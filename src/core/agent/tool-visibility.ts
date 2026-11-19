/**
 * Видимость тулов для модели в пределах хода.
 *
 * Тул, который суммарно провалился больше `MAX_TOOL_FAILURES_PER_TURN` раз,
 * отключается на остаток хода (`LoopState.disabledTools`): слабая модель иначе
 * бесконечно повторяет мёртвый тул, чередуя его с успешными вызовами других
 * тулов (наблюдалось: `browser` 17× при отсутствующем bridge-server.mjs, без
 * срабатывания honest-stop, т.к. пакеты не были полностью провальными).
 *
 * Вынесено чистой функцией, чтобы фильтр был юнит-тестируем отдельно от цикла.
 */
export function filterDisabledTools<T extends { name: string }>(
  tools: readonly T[],
  disabled: ReadonlySet<string>,
): T[] {
  if (disabled.size === 0) return tools as T[];
  return tools.filter((t) => !disabled.has(t.name));
}
