import type { HallucinationCheckResult } from "./detector";
import { t } from "../../i18n/index";

const MIN_CHARS = 1;
const MIN_WORDS = 5;
/** Both responses must be this long before repetition applies — a short
 *  honest answer ("Done." / "The build passes.") repeated twice is not
 *  degeneration and must not burn a hallucination retry. */
const MIN_REPEAT_CHARS = 120;
const MIN_REPEAT_WORDS = 20;
/** Word-overlap above this threshold counts as repetition (was 0.5). */
const REPEAT_OVERLAP_THRESHOLD = 0.8;

export class ConfidenceCheck {
  private previousResponse: string = "";

  setPreviousResponse(response: string): void {
    this.previousResponse = response;
  }

  validate(response: string): HallucinationCheckResult {
    if (!response || response.length < MIN_CHARS) {
      return {
        status: "retry",
        kind: "short",
        reason: t("hall.short_response"),
      };
    }

    // Language-agnostic: very short response with no structured content
    const wordCount = response.split(/\s+/).filter(Boolean).length;
    const hasStructure = /```|^\s*[-*]\s|^\s*\d+\.\s|<[^>]+>/m.test(response);
    if (wordCount < MIN_WORDS && !hasStructure) {
      return {
        status: "warn",
        kind: "short",
        reason: t("hall.short_response"),
      };
    }

    // Language-agnostic: repetition detection via word overlap. Only flag when
    // BOTH the current and the previous response are substantive — a short
    // answer after a long one (or two short answers) is not a loop.
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

    // Language-agnostic: very low word diversity (same words repeated)
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
