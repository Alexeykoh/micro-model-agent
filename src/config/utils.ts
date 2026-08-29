// src/config/utils.ts
// Shared deep-merge + RegExp-safe JSON helpers. Previously duplicated across
// config.ts and domains.ts, where the two copies had drifted (config.ts
// assigned RegExp by reference; domains.ts spread it into {} and destroyed it).

export function isPlainObject(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep merge two objects. Arrays, scalars, and non-plain values (RegExp, Date)
 * in source replace target by reference — spreading a RegExp would silently
 * destroy it to {}.
 */
export function deepMerge<T>(target: T, source: Partial<T>): T {
  const result: Record<string, unknown> = { ...(target as any) };
  for (const key of Object.keys(source as object)) {
    const srcVal = (source as any)[key];
    const tgtVal = (target as any)[key];
    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else if (srcVal !== undefined) {
      result[key] = srcVal;
    }
  }
  return result as T;
}

/**
 * JSON replacer that serializes RegExp objects as {__regex, source, flags}
 * so they survive JSON.stringify/parse round-trips.
 */
export function regexReplacer(_key: string, value: unknown): unknown {
  if (value instanceof RegExp) {
    return { __regex: true, source: value.source, flags: value.flags };
  }
  return value;
}

/**
 * JSON reviver that restores RegExp objects serialized by regexReplacer.
 */
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