import en from "./en.json";
import ru from "./ru.json";

const locales: Record<string, Record<string, unknown>> = { en, ru };

let currentLocale = "en";

function flatten(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  let result: Record<string, string> = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof val === "string") {
      result[fullKey] = val;
    } else if (typeof val === "object" && val !== null) {
      result = {
        ...result,
        ...flatten(val as Record<string, unknown>, fullKey),
      };
    }
  }
  return result;
}

const flat: Record<string, Record<string, string>> = {};

for (const [name, dict] of Object.entries(locales)) {
  flat[name] = flatten(dict);
}

export function setLocale(locale: string): void {
  if (flat[locale]) {
    currentLocale = locale;
  }
}

/**
 * Flattened dictionaries keyed by locale name. Used by the `mma web` API to
 * ship every translation to the browser so it can localize its own chrome.
 * Read-only by contract — callers must not mutate the returned maps.
 */
export function getFlatDicts(): Record<string, Record<string, string>> {
  return flat;
}

export function loadLocale(name: string, dict: Record<string, unknown>): void {
  locales[name] = dict;
  flat[name] = flatten(dict);
}

/**
 * Опциональный репортёр отсутствующих ключей (debug-диагностика). Wire-ится
 * из bootstrap на logger.debug, чтобы не тянуть logger в i18n (циклы).
 */
let missingKeyReporter: ((key: string) => void) | undefined;

export function setMissingKeyReporter(reporter?: (key: string) => void): void {
  missingKeyReporter = reporter;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const localeDict = flat[currentLocale];
  const enDict = flat.en;
  const template = localeDict?.[key] ?? enDict?.[key];

  if (template === undefined) {
    missingKeyReporter?.(key);
    return key;
  }
  if (!template) return key;

  if (params) {
    let result = template;
    for (const [k, v] of Object.entries(params)) {
      result = result.replaceAll(`{${k}}`, String(v));
    }
    return result;
  }

  return template;
}
