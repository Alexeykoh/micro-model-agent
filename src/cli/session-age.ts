/**
 * Компактный возраст сессии для таблицы `/sessions`. Полная дата (19 символов)
 * на 80 колонках срезается до «2026-10…», поэтому показываем «5м назад» —
 * оно влезает в шапку и читается без домысливания.
 */
import { t } from "../i18n/index";

/** Сколько прошло с `updatedAt`; пустая строка, если дата битая. */
export function sessionAge(updatedAt: string, now: number = Date.now()): string {
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return "";
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return t("session.age.now");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("session.age.min", { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t("session.age.hour", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("session.age.day", { n: days });
  // Старше месяца — дата без года: список сессий локальный и короткий.
  return updatedAt.slice(5, 10).replace("-", ".");
}
