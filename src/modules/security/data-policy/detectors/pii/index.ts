/** Детектор PII (РФ + РБ, regex + контрольные суммы + контекстный confidence). */
import type { Finding } from "../../types";
import { excludedRanges } from "../../normalize";
import { detectRfPii } from "./rf";
import { detectByPii } from "./by";

export { detectRfPii } from "./rf";
export { detectByPii } from "./by";
export * from "./checksums";

/** Все находки класса `pii` (РФ + РБ). Минимум — `excluded` считается один раз. */
export function detectPii(text: string, excluded = excludedRanges(text)): Finding[] {
  return [...detectRfPii(text, excluded), ...detectByPii(text, excluded)];
}
