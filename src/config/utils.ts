// Общие хелперы конфига: deep-merge и RegExp-безопасный JSON.
// Раньше дублировались в config.ts и domains.ts, причём копии разошлись
// (config.ts присваивал RegExp по ссылке, domains.ts спредом ломал его в {}).
/** Проверка на plain-объект (не массив/RegExp/Date). */
export function isPlainObject(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Глубокий мерж объектов. Массивы, скаляры и не-plain значения (RegExp, Date)
 * из source заменяют target по ссылке: спред RegExp молча ломал бы его в {}.
 */
export function deepMerge<T>(target: T, source: Partial<T>): T {
  const result: Record<string, unknown> = {
    ...(target as unknown as Record<string, unknown>),
  };
  const srcRec = source as unknown as Record<string, unknown>;
  const tgtRec = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(source as object)) {
    const srcVal = srcRec[key];
    const tgtVal = tgtRec[key];
    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Partial<Record<string, unknown>>,
      );
    } else if (srcVal !== undefined) {
      result[key] = srcVal;
    }
  }
  return result as T;
}

/**
 * JSON-replacer: сериализует RegExp как {__regex, source, flags}, чтобы они
 * переживали round-trip JSON.stringify/parse.
 */
export function regexReplacer(_key: string, value: unknown): unknown {
  if (value instanceof RegExp) {
    return { __regex: true, source: value.source, flags: value.flags };
  }
  return value;
}

/** JSON-reviver: восстанавливает RegExp, сериализованные через regexReplacer. */
export function regexReviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).__regex === true
  ) {
    const { source, flags } = value as { source: string; flags: string };
    try {
      return new RegExp(source, flags);
    } catch {
      return value;
    }
  }
  return value;
}