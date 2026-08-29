/** Levenshtein edit distance between two strings (case-insensitive). */
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
 * The known command whose name is within `maxDistance` of `input`, or
 * `undefined` when nothing is close enough. Used to catch subcommand typos
 * (`mma sesion list`) that would otherwise be silently sent to the LLM.
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
