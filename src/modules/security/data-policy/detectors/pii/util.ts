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
  /**
   * Контекстный маркер: правило срабатывает, только если в той же строке рядом
   * с кандидатом есть этот шаблон (например, «дата рождения» для `birthdate`).
   * Без него обычная дата в тексте — не PII. Регэксп не должен быть `g`.
   */
  context?: RegExp;
}

/** Сколько символов по обе стороны от кандидата считать контекстом. */
const CONTEXT_WINDOW = 40;

/** Контекст в той же строке (перенос строки обрывает связь «метка ↔ дата»). */
function hasContext(text: string, start: number, end: number, context: RegExp): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEndRaw = text.indexOf("\n", end);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const window = text.slice(
    Math.max(lineStart, start - CONTEXT_WINDOW),
    Math.min(lineEnd, end + CONTEXT_WINDOW),
  );
  const re = new RegExp(context.source, context.flags.replace("g", ""));
  return re.test(window);
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
      if (rule.context && !hasContext(text, start, end, rule.context)) continue;
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
