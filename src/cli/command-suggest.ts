// Подсказки при опечатках в командах: расстояние Левенштейна.
/** Редакционное расстояние Левенштейна между строками (без учёта регистра). */
export function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return 0;
  const prev = new Array<number>(t.length + 1);
  const curr = new Array<number>(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= t.length; j++) prev[j] = curr[j];
  }
  return prev[t.length];
}

/**
 * Известная команда, чьё имя в пределах `maxDistance` от `input`, или
 * `undefined`, если близких нет. Ловит опечатки в субкомандах
 * (`mma sesion list`), которые иначе молча ушли бы в LLM.
 */
export function closestCommand(
  input: string,
  known: string[],
  maxDistance = 2,
): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const k of known) {
    const d = levenshtein(input, k);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return bestDist <= maxDistance ? best : undefined;
}
