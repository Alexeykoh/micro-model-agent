/** Правила PII РФ: контакты, СНИЛС, ИНН, ОГРН, паспорт, карты, IBAN, дата рождения. */
import type { Finding } from "../../types";
import type { Range } from "../../normalize";
import { innValid, ibanValid, luhnValid, ogrnValid, snilsValid } from "./checksums";
import { digitsOnly, runRules, type PiiRule } from "./util";

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
  { kind: "birthdate", re: /(?<!\d)\d{2}[.\-/]\d{2}[.\-/]\d{4}(?!\d)/g, confidence: 0.4 },
  { kind: "birthdate", re: /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g, confidence: 0.4 },
];

/** Находки PII РФ. */
export function detectRfPii(text: string, excluded: readonly Range[]): Finding[] {
  return runRules(text, RF_RULES, excluded);
}
