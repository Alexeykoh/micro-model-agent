// Фоновый context-probe веб-UI: bootstrap-промис резолвится лениво и светится
// в сайдбаре; старт сервера его не await'ит, чтобы медленный проб не задерживал бинд.
export interface ProbeValue {
  model: string;
  actual: number;
}

/**
 * Подписывается на bootstrap context-probe в фон: `onResolve` получает значение
 * при готовности (`null` — проба не удалась). Без промиса ничего не делает —
 * сайдбар рисует прочерк `pending`.
 */
export function trackContextProbe(
  probePromise: Promise<ProbeValue | null> | undefined,
  onResolve: (value: ProbeValue | null) => void,
): void {
  if (!probePromise) return;
  void probePromise.then(onResolve).catch(() => onResolve(null));
}
