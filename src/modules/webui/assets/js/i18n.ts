// Localisation for the `mma web` frontend. Dictionary comes from the server
// (`GET /api/i18n`) so the chrome follows `config.locale` without a reload.

import { api } from "./api.js";

export type Dict = Record<string, string>;
export interface I18nState {
  locale: string;
  dicts: Record<string, Dict>;
}
export interface I18nPayload {
  locale?: string;
  dicts?: Record<string, Dict>;
}

export const I18N: I18nState = { locale: "en", dicts: {} };

// Mirrors of the last server payload. The pre-paint boot reads them so the
// splash never flashes EN/dark before the saved RU/light UI.
const CACHE_KEY = "mma-i18n";
const LOCALE_KEY = "mma-locale";

function cacheGet(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function cacheSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    /* private mode / quota: the cache is an optimisation, never a dependency */
  }
}

/** Hydrates {@link I18N} from localStorage; true when a usable cache existed. */
export function hydrateI18nCache(): boolean {
  const raw = cacheGet(CACHE_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as I18nPayload;
    if (!parsed || typeof parsed.locale !== "string" || !parsed.dicts || typeof parsed.dicts !== "object") {
      return false;
    }
    I18N.locale = parsed.locale;
    I18N.dicts = parsed.dicts;
    return true;
  } catch {
    return false;
  }
}

/** True when a dictionary is already available (cache hit or server reply). */
export function hasCachedI18n(): boolean {
  return Object.keys(I18N.dicts).length > 0;
}

hydrateI18nCache();

export function t(key: string, params?: Record<string, string | number>): string {
  const dict = I18N.dicts[I18N.locale] || I18N.dicts.en || {};
  const en = I18N.dicts.en || {};
  let template: string | undefined = dict[key];
  if (template === undefined) template = en[key];
  if (template === undefined) return key;
  if (params) {
    Object.keys(params).forEach((k) => {
      template = (template as string).split("{" + k + "}").join(String(params[k]));
    });
  }
  return template;
}

// Plural form for a `{count}` template: uses `baseKey_one|_few|_many`
// (RU one/few/many; EN one/many) and falls back to `baseKey` if absent.
export function pluralCount(baseKey: string, n: number): string {
  let form: string;
  if (I18N.locale === "ru") {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) form = "one";
    else if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) form = "few";
    else form = "many";
  } else {
    form = n === 1 ? "one" : "many";
  }
  const key = baseKey + "_" + form;
  const s = t(key, { count: n });
  return s === key ? t(baseKey, { count: n }) : s;
}

export async function loadI18n(): Promise<void> {
  const r = await api<I18nPayload>("/api/i18n");
  if (r.ok && r.data) {
    I18N.locale = r.data.locale || "en";
    I18N.dicts = r.data.dicts || {};
    cacheSet(LOCALE_KEY, I18N.locale);
    cacheSet(CACHE_KEY, JSON.stringify({ locale: I18N.locale, dicts: I18N.dicts }));
  }
}
