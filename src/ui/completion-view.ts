// Отрисовка списка кандидатов автодополнения в терминале.
//
// Вынесено из `line-editor.ts`: это чистое представление кандидатов, а не
// состояние редактора (правило 6 AGENTS).
import stringWidth from "string-width";
import { pc } from "./colors";

/** Кандидат дополнения (совместимо с `CompletionItem` комплитера). */
export interface CompletionCandidate {
  value: string;
  description?: string;
}

/**
 * Строки списка кандидатов, обрезанные по ширине терминала. Слишком длинные
 * строки режутся по ВИДИМЫМ колонкам (кодпоинтов мало для CJK/emoji).
 */
export function renderCompletionRows(
  matches: CompletionCandidate[],
  limit: number,
): string[] {
  if (limit <= 0) return matches.map(() => "");
  return matches.map((m) => {
    const plain = m.description ? `  ${m.value}  ${m.description}` : `  ${m.value}`;
    if (stringWidth(plain) <= limit) {
      return m.description ? `  ${m.value}  ${pc.dim(m.description)}` : `  ${m.value}`;
    }
    let acc = "";
    let w = 0;
    for (const ch of plain) {
      const cw = stringWidth(ch);
      if (w + cw > limit - 1) break;
      acc += ch;
      w += cw;
    }
    return `${acc}…`;
  });
}
