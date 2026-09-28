// i18n: плоские словари en/ru, t(key, params) с фолбэком на английский.
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

/**
 * Переключает текущую локаль. Неизвестное имя игнорируется.
 * @param locale имя локали ("en" | "ru").
 */
export function setLocale(locale: string): void {
  if (flat[locale]) {
    currentLocale = locale;
  }
}

/**
 * Плоские словари по именам локалей. Нужны веб-API, чтобы отдать все переводы
 * в браузер для локализации его интерфейса. Только чтение — не мутировать.
 */
export function getFlatDicts(): Record<string, Record<string, string>> {
  return flat;
}

/**
 * Подменяет/добавляет словарь локали в рантайме (плагины, тесты).
 * @param name имя локали; @param dict вложенный словарь переводов.
 */
export function loadLocale(name: string, dict: Record<string, unknown>): void {
  locales[name] = dict;
  flat[name] = flatten(dict);
}

/**
 * Ставит обработчик отсутствующих ключей (debug-диагностика). Подключается
 * из bootstrap на logger.debug, чтобы не тянуть логер в i18n (циклы).
 */
let missingKeyReporter: ((key: string) => void) | undefined;

export function setMissingKeyReporter(reporter?: (key: string) => void): void {
  missingKeyReporter = reporter;
}

/**
 * Переводит ключ с подстановкой `{params}`. Нет ключа — вернёт сам ключ.
 * @param key точечный ключ; @param params значения подстановок.
 */
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
