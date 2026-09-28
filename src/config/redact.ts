// Маскирование секретов для показа конфига (`mma config show`).
/** Ключи, чьи строковые значения — секреты и маскируются при показе. */
const SECRET_KEYS = new Set([
  "apiKey",
  "api_key",
  "apikey",
  "token",
  "tokens",
  "secret",
  "password",
  "authorization",
  "webhookUrl",
]);

/** Объектные ключи, где чувствительно КАЖДОЕ значение (карты headers/env). */
const SECRET_MAPS = new Set(["headers", "env"]);

const MASK = "***";

function walk(value: unknown, parentKey?: string, depth = 0): unknown {
  if (depth > 100) return value;
  if (typeof value === "string") {
    return parentKey && SECRET_KEYS.has(parentKey) ? MASK : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, parentKey, depth + 1));
  }
  if (value && typeof value === "object" && !(value instanceof RegExp)) {
    if (parentKey && SECRET_MAPS.has(parentKey)) {
      const masked: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>)) masked[k] = MASK;
      return masked;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, k, depth + 1);
    }
    return out;
  }
  return value;
}

/** Возвращает глубокую копию `config` с секретами, заменёнными на `***`. */
export function redactConfigSecrets<T>(config: T): T {
  return walk(config) as T;
}
