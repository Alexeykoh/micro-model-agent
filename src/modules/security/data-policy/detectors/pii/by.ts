/**
 * Правила PII РБ: телефон +375, УНП (9 цифр), личный номер (14 симв.), серия
 * паспорта. УНП и личный номер проверяются контрольной суммой: верная даёт
 * высокий confidence, неверная остаётся находкой с пониженным confidence —
 * математическая проверка не отбрасывает кандидата молча.
 */
import type { Finding } from "../../types";
import type { Range } from "../../normalize";
import { runRules, type PiiRule } from "./util";
import { byIdValid, unpValid } from "./checksums";

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
  return runRules(text, BY_RULES, excluded).map((finding) => {
    if (finding.kind !== "unp" && finding.kind !== "by-id") return finding;
    const candidate = text.slice(finding.start, finding.end);
    const valid = finding.kind === "unp" ? unpValid(candidate) : byIdValid(candidate);
    return { ...finding, confidence: valid ? 0.85 : finding.kind === "unp" ? 0.25 : 0.3 };
  });
}
