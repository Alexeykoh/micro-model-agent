// Проверка уверенности ответа: пустота, повторы, низкое разнообразие лексики.
import type { HallucinationCheckResult } from "./detector";
import { t } from "../../i18n/index";

const MIN_CHARS = 1;
/** Оба ответа должны быть не короче — короткий честный ответ ("Готово.") дважды
 *  подряд не деградация и не должен жечь hallucination-retry. */
const MIN_REPEAT_CHARS = 120;
const MIN_REPEAT_WORDS = 20;
/** Пересечение слов выше порога считается повтором (было 0.5). */
const REPEAT_OVERLAP_THRESHOLD = 0.8;

/** Проверка уверенности: пустой ответ, дословный повтор, низкая diversity. */
export class ConfidenceCheck {
  private previousResponse: string = "";

  /** Запоминает предыдущий ответ для детекции повторов. */
  setPreviousResponse(response: string): void {
    this.previousResponse = response;
  }

  /** Валидирует ответ: retry на пустоту/повтор, warn на низкую diversity, иначе pass. */
  validate(response: string): HallucinationCheckResult {
    if (!response || response.length < MIN_CHARS) {
      return {
        status: "retry",
        kind: "short",
        reason: t("hall.short_response"),
      };
    }

    // Короткие реплики не флагуются: приветствие, скупое подтверждение или
    // однострочник — валидный ответ. Реальное усечение ловит finish_reason
    // провайдера ("length"), пустоту — retry выше.
    const wordCount = response.split(/\s+/).filter(Boolean).length;

    // Языконезависимо: детекция повторов по пересечению слов. Флагуем только
    // если ОБА ответа содержательные — короткий ответ после длинного (или два
    // коротких) не цикл.
    if (this.previousResponse) {
      const prevWords = this.previousResponse.split(/\s+/).filter(Boolean).length;
      const bothSubstantive =
        response.length >= MIN_REPEAT_CHARS &&
        this.previousResponse.length >= MIN_REPEAT_CHARS &&
        wordCount >= MIN_REPEAT_WORDS &&
        prevWords >= MIN_REPEAT_WORDS;
      if (bothSubstantive) {
        const overlap = this.calculateOverlap(response, this.previousResponse);
        if (overlap > REPEAT_OVERLAP_THRESHOLD) {
          return {
            status: "retry",
            kind: "repetition",
            reason: t("hall.repetitive", { pct: Math.round(overlap * 100) }),
          };
        }
      }
    }

    // Языконезависимо: очень низкая diversity слов (одни и те же слова по кругу)
    const words = response
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    if (words.length >= 10) {
      const unique = new Set(words);
      const diversity = unique.size / words.length;
      if (diversity < 0.25) {
        return {
          status: "warn",
          kind: "diversity",
          reason: t("hall.repetitive", {
            pct: Math.round((1 - diversity) * 100),
          }),
        };
      }
    }

    return { status: "pass" };
  }

  private calculateOverlap(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
    const smaller = Math.min(wordsA.size, wordsB.size);
    if (smaller === 0) return 0;
    let matches = 0;
    for (const w of wordsB) if (wordsA.has(w)) matches++;
    return matches / smaller;
  }
}
