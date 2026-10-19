/**
 * Детектор секретов: переиспользует целевые паттерны `data-sanitizer`, но отдаёт
 * позиции находок. Секреты **не** псевдонимизируются (необратимая маска, даже для
 * доверенного провайдера) — только в заголовок авторизации.
 */
import { TARGETED_SECRET_PATTERNS } from "../../data-sanitizer";
import type { Finding } from "../types";
import { excludedRanges, overlapsAny } from "../normalize";

/** Все находки класса `secret`. */
export function detectSecrets(text: string): Finding[] {
  const findings: Finding[] = [];
  const excluded = excludedRanges(text);
  TARGETED_SECRET_PATTERNS.forEach((p, i) => {
    const re = new RegExp(p.pattern.source, p.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (overlapsAny(start, end, excluded)) continue;
      findings.push({
        dataClass: "secret",
        kind: `secret:${i}`,
        start,
        end,
        confidence: 1,
        redact: true,
      });
    }
  });
  return findings;
}
