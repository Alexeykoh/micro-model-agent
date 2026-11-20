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
  const visible = tools.filter((t) => !disabled.has(t.name));
  // AQC-4: если отключён последний тул, оставляем его в схеме — иначе модель
  // сразу переходит к текстовому ответу и failed-batch терминал никогда не
  // срабатывает. Вызов всё равно блокируется детерминированным результатом.
  return visible.length === 0 && tools.length > 0 ? (tools as T[]) : visible;
}
