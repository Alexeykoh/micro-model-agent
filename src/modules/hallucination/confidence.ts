import type { HallucinationCheckResult } from "./factual";
import { t } from "../../i18n/index";

const MIN_CHARS = 1;
const MIN_WORDS = 5;

export class ConfidenceCheck {
  private previousResponse: string = "";

  setPreviousResponse(response: string): void {
    this.previousResponse = response;
  }

  validate(response: string): HallucinationCheckResult {
    if (!response || response.length < MIN_CHARS) {
      return { status: "retry", reason: t("hall.short_response") };
    }

    // Language-agnostic: very short response with no structured content
    const wordCount = response.split(/\s+/).filter(Boolean).length;
    const hasStructure = /```|^\s*[-*]\s|^\s*\d+\.\s|<[^>]+>/m.test(response);
    if (wordCount < MIN_WORDS && !hasStructure) {
      return {
        status: "warn",
        reason: t("hall.short_response"),
      };
    }

    // Language-agnostic: repetition detection via word overlap
    if (this.previousResponse) {
      const overlap = this.calculateOverlap(response, this.previousResponse);
      if (overlap > 0.5) {
        return {
          status: "retry",
          reason: t("hall.repetitive", { pct: Math.round(overlap * 100) }),
        };
      }
    }

    // Language-agnostic: very low word diversity (same words repeated)
    const words = response.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (words.length >= 10) {
      const unique = new Set(words);
      const diversity = unique.size / words.length;
      if (diversity < 0.25) {
        return {
          status: "warn",
          reason: t("hall.repetitive", { pct: Math.round((1 - diversity) * 100) }),
        };
      }
    }

    return { status: "pass" };
  }

  private calculateOverlap(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = b.toLowerCase().split(/\s+/);
    if (wordsB.length === 0) return 0;
    const matches = wordsB.filter((w) => wordsA.has(w));
    return matches.length / wordsB.length;
  }
}
