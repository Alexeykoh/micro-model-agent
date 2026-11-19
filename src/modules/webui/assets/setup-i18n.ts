/** Локализация веб-визарда: словари с сервера и `tr` с плейсхолдерами. */

export const I18N: { locale: string; dicts: Record<string, Record<string, string>> } = {
  locale: "en",
  dicts: {},
};

export function tr(key: string, params?: Record<string, string | number>): string {
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
  const s = tr(key, { count: n });
  return s === key ? tr(baseKey, { count: n }) : s;
}

/** Применяет ответ `/api/i18n` (словари + активная локаль). */
export function applyI18n(data: {
  locale?: string;
  dicts?: Record<string, Record<string, string>>;
}): void {
  I18N.locale = data.locale || "en";
  I18N.dicts = data.dicts || {};
}

/** Смена только словарей (ответ `/api/setup/locale`). */
export function applyDicts(
  dicts: Record<string, Record<string, string>>,
  locale: string,
): void {
  I18N.dicts = dicts;
  I18N.locale = locale;
}
