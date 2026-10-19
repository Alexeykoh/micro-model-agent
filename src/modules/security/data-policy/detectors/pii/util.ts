/** Общий прогон правила PII: regex-кандидат + опциональная контрольная сумма. */
import type { Finding } from "../../types";
import { overlapsAny, type Range } from "../../normalize";

export interface PiiRule {
  kind: string;
  re: RegExp;
  confidence: number;
  /** Доп. проверка кандидата (например, контрольная сумма). true = принять. */
  validate?: (match: string) => boolean;
  /** Цифры для проверки (если отличается от match). */
  digits?: (match: string) => string;
}

/** Прогоняет правила, возвращает находки класса `pii` вне исключённых диапазонов. */
export function runRules(text: string, rules: readonly PiiRule[], excluded: readonly Range[]): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      if (overlapsAny(start, end, excluded)) continue;
      if (rule.validate && !rule.validate(rule.digits ? rule.digits(m[0]) : m[0])) continue;
      findings.push({
        dataClass: "pii",
        kind: rule.kind,
        start,
        end,
        confidence: rule.confidence,
        redact: true,
      });
    }
  }
  return findings;
}

/** Вытащить только цифры из строки. */
export function digitsOnly(s: string): string {
  return s.replace(/\D+/g, "");
}
