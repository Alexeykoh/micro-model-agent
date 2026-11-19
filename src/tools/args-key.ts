/** Стабильная сериализация аргументов тула: сортировка ключей, порядок не влияет. */

export function stableArgsKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableArgsKey);
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, stableArgsKey((value as Record<string, unknown>)[k])]);
    return Object.fromEntries(entries);
  }
  return value;
}
