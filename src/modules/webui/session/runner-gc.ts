// Политика вытеснения раннеров сессий: idle + LRU.
//
// Вынесено из `session-pool.ts`: правило «кого выкинуть» — чистая функция,
// её можно тестировать и переиспользовать без самого пула (правило 6 AGENTS).

/** Кого вытеснить: idle дольше `idleMs` и лишние по LRU (свыше `max`). */
export function selectEvictions(
  runnerIds: readonly string[],
  lastActive: ReadonlyMap<string, number>,
  isBusy: (id: string) => boolean,
  now: number,
  idleMs: number,
  max: number,
): string[] {
  const evict: string[] = [];
  for (const id of runnerIds) {
    const at = lastActive.get(id);
    if (at === undefined) continue;
    if (now - at < idleMs) continue;
    if (isBusy(id)) continue;
    evict.push(id);
  }
  const alive = runnerIds.filter((id) => !evict.includes(id));
  if (alive.length <= max) return evict;
  // LRU: первым уходит тот, кого давно не трогали.
  const byAge = [...alive].sort((a, b) => (lastActive.get(a) ?? 0) - (lastActive.get(b) ?? 0));
  for (const id of byAge.slice(0, byAge.length - max)) {
    if (isBusy(id)) continue;
    evict.push(id);
  }
  return evict;
}
