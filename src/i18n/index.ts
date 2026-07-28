import en from './en.json'
import ru from './ru.json'

const locales: Record<string, Record<string, string>> = { en, ru }

let currentLocale = 'en'

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  let result: Record<string, string> = {}
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (typeof val === 'string') {
      result[fullKey] = val
    } else if (typeof val === 'object' && val !== null) {
      result = { ...result, ...flatten(val as Record<string, unknown>, fullKey) }
    }
  }
  return result
}

const flat: Record<string, Record<string, string>> = {}

for (const [name, dict] of Object.entries(locales)) {
  flat[name] = flatten(dict)
}

export function setLocale(locale: string): void {
  if (flat[locale]) {
    currentLocale = locale
  }
}

export function loadLocale(name: string, dict: Record<string, unknown>): void {
  locales[name] = dict as any
  flat[name] = flatten(dict)
}

export function t(key: string, params?: Record<string, string | number>): string {
  const localeDict = flat[currentLocale]
  const enDict = flat['en']
  let template = localeDict?.[key] || enDict?.[key]

  if (!template) return key

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      template = template.replace(`{${k}}`, String(v))
    }
  }

  return template
}
