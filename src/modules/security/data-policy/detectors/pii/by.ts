/**
 * Правила PII РБ: телефон +375, УНП (9 цифр), личный номер (14 симв.), серия
 * паспорта. УНП и личный номер — без контрольной суммы → пониженный confidence
 * (DEBT(research-by-checksum)).
 */
import type { Finding } from "../../types";
import type { Range } from "../../normalize";
import { runRules, type PiiRule } from "./util";

/** Серии паспорта РБ (регион выдачи). Список неполный — контекстный детектор. */
const BY_PASSPORT_SERIES = [
  "АВ", "АМ", "АН", "АР", "АС", "БА", "БК", "БМ", "БР", "БС",
  "ВМ", "ВР", "ГК", "ГМ", "ДМ", "ЖИ", "ЗК", "ИК", "КВ", "КН",
  "МР", "МС", "НВ", "ПА", "ПК", "РВ", "СА", "СВ", "ТМ", "ФА",
  "ХВ", "ШГ", "RR", "SP", "DP",
];

const BY_RULES: readonly PiiRule[] = [
  {
    kind: "by-phone",
    re: /(?:\+375|375|80)[\s(-]?\d{2}[\s)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g,
    confidence: 0.8,
  },
  { kind: "unp", re: /(?<!\d)\d{9}(?!\d)/g, confidence: 0.4 },
  { kind: "by-id", re: /(?<!\w)\d{7}[A-Z]\d{3}[A-Z]{2}\d(?!\w)/gi, confidence: 0.5 },
  {
    kind: "by-passport",
    re: new RegExp(`(?:${BY_PASSPORT_SERIES.join("|")})\\s?\\d{7}`, "gi"),
    confidence: 0.5,
  },
];

/** Находки PII РБ. */
export function detectByPii(text: string, excluded: readonly Range[]): Finding[] {
  return runRules(text, BY_RULES, excluded);
}
