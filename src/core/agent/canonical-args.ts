// src/core/agent/canonical-args.ts
/**
 * Стабильная идентичность вызова тула для детекции дословных повторов:
 * имя + канонические аргументы (рекурсивная сортировка ключей, нормализация
 * path-подобных значений). Совпадает ⟺ вызов буквально тот же.
 */
const PATH_ARG_KEYS = new Set(["path", "file", "workdir", "cwd", "dir", "directory", "target"]);

/** Нормализует значение path-аргумента: слеши → `/`, срез `./`, срез хвостового `/`. */
function normalizePathString(value: string): string {
  let v = value.replace(/\\/g, "/");
  while (v.startsWith("./")) v = v.slice(2);
  if (v.length > 1) v = v.replace(/\/+$/, "");
  return v;
}

function stableStringify(value: unknown, pathValue: boolean): string {
  if (value === null || typeof value !== "object") {
    if (pathValue && typeof value === "string") return JSON.stringify(normalizePathString(value));
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v, false)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], PATH_ARG_KEYS.has(k))}`)
    .join(",")}}`;
}

/** Канонический ключ вызова: `name::canonicalArgs`. */
export function canonicalArgsKey(name: string, args: unknown): string {
  return `${name}::${stableStringify(args, false)}`;
}
