// Localisation for the `mma web` frontend. Dictionary comes from the server
// (`GET /api/i18n`) so the chrome follows `config.locale` without a reload.

import { api } from "./api.js";

export const I18N = { locale: "en", dicts: {} };

export function t(key, params) {
const dict = I18N.dicts[I18N.locale] || I18N.dicts.en || {};
const en = I18N.dicts.en || {};
let template = dict[key];
if (template === undefined) template = en[key];
if (template === undefined) return key;
if (params) {
  Object.keys(params).forEach((k) => {
    template = template.split("{" + k + "}").join(String(params[k]));
  });
}
return template;
}

// Plural form for a `{count}` template: uses `baseKey_one|_few|_many`
// (RU one/few/many; EN one/many) and falls back to `baseKey` if absent.
export function pluralCount(baseKey, n) {
let form;
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

export async function loadI18n() {
const r = await api("/api/i18n");
if (r.ok && r.data) {
  I18N.locale = r.data.locale || "en";
  I18N.dicts = r.data.dicts || {};
}
}
