/** Правила PII РФ: контакты, СНИЛС, ИНН, ОГРН, паспорт, карты, IBAN, дата рождения. */
import type { Finding } from "../../types";
import type { Range } from "../../normalize";
import { innValid, ibanValid, luhnValid, ogrnValid, snilsValid } from "./checksums";
import { digitsOnly, runRules, type PiiRule } from "./util";

/**
 * Метка даты рождения рядом с датой. Голая дата — не PII: `16.11.2026` в
 * ответе модели («сегодня, 16.11.2026») или `Session 2026-10-28` не должны
 * превращаться в `<PII:…>` (баг DLP-редакции ответов пользователю).
 */
const BIRTH_CONTEXT =
  /(?:дата\s+рождения|день\s+рождения|д\.\s*р\.|г\.\s*р\.|родил(?:ся|ась|ись)|род\.|(?<![\p{L}])born(?![\p{L}])|(?<![\p{L}])birth(?:day|date)?(?![\p{L}])|date\s+of\s+birth|(?<![\p{L}])dob(?![\p{L}]))/iu;

const RF_RULES: readonly PiiRule[] = [
  { kind: "email", re: /[\w.%+-]+@[\w-]+\.[A-Za-z]{2,}/g, confidence: 0.9 },
  { kind: "ru-phone", re: /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g, confidence: 0.8 },
  {
    kind: "snils",
    re: /\d{3}[-\s]?\d{3}[-\s]?\d{3}[-\s]?\d{2}/g,
    confidence: 0.9,
    digits: digitsOnly,
    validate: (d) => snilsValid(d),
  },
  {
    kind: "inn",
    re: /(?<!\d)(?:\d{10}|\d{12})(?!\d)/g,
    confidence: 0.85,
    validate: (m) => innValid(m),
  },
  {
    kind: "ogrn",
    re: /(?<!\d)(?:\d{13}|\d{15})(?!\d)/g,
    confidence: 0.8,
    validate: (m) => ogrnValid(m),
  },
  {
    kind: "card",
    re: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    confidence: 0.8,
    digits: digitsOnly,
    validate: (d) => luhnValid(d),
  },
  {
    kind: "iban",
    re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    confidence: 0.85,
    validate: (m) => ibanValid(m),
  },
  { kind: "ru-passport", re: /(?<!\d)\d{2}\s?\d{2}\s?\d{6}(?!\d)/g, confidence: 0.5 },
  // Дата — PII только рядом с меткой рождения: «сегодня, 16.11.2026» и даты
  // релизов/сессий остаются текстом. ISO со временем (`…T09:12`) — машинное
  // поле, не дата рождения (гвард `tests/security/pii-iso-timestamps.test.ts`).
  {
    kind: "birthdate",
    re: /(?<!\d)\d{2}[.\-/]\d{2}[.\-/]\d{4}(?!\d)/g,
    confidence: 0.85,
    context: BIRTH_CONTEXT,
  },
  {
    kind: "birthdate",
    re: /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)(?!T\d{2}:\d{2})/g,
    confidence: 0.85,
    context: BIRTH_CONTEXT,
  },
];

/** Находки PII РФ. */
export function detectRfPii(text: string, excluded: readonly Range[]): Finding[] {
  return runRules(text, RF_RULES, excluded);
}
