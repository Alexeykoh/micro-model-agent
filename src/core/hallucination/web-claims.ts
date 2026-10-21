/**
 * Проверка веб-обоснования числовых утверждений (ses_muwinhpk_2e69iq): 27B
 * собрала md-файл о велосипедах с ценами, которых не было ни на одной успешно
 * прочитанной странице (JS-шеллы/404). `checkUnverifiedOutput` ловит только
 * выдуманный *вывод программы*, а числовые «факты» из веба проходили молча.
 *
 * Детерминированно (без LLM): извлекаем из финального ответа денежные суммы
 * (числа с разделителями разрядов или с валютой рядом) и проверяем, что каждая
 * встречается в тексте, реально полученном сетевыми тулами. Не найдена → одна
 * ограниченная re-check итерация (recall-biased, как artifact/output-проверки).
 */

import type { ClaimContradiction, ClaimToolEvidence } from "./success-claim";
import { unwrapUntrusted } from "../../tools/web-content";

/** Сетевые тулы, чей успешный вывод считается «прочитанным из веба». */
const WEB_TOOLS = new Set(["web_fetch", "web_browse", "browser", "web_search"]);

/** Число с разделителями разрядов (45 000 / 45,000) или просто 4+ цифр. */
const NUMBER_RE = /(\d{1,3}(?:[ \u00A0\u202F,]\d{3})+|\d{4,})/g;

/** Маркер валюты/суммы рядом с числом (для не-сгруппированных 4+ цифр). */
const CURRENCY_RE = /(руб|byn|б\.?\s?р|₽|\$|€|usd|eur|тыс|рублей|rub)/i;

/** Разделители разрядов, которые убираем при нормализации суммы. */
export function normalizeDigits(s: string): string {
  return s.replace(/[ \u00A0\u202F,]/g, "");
}

/**
 * Извлекает денежные суммы из текста. Группированное число (45 000) считается
 * суммой всегда; негруппированное 4+ (15000) — только если рядом (±14 символов)
 * есть валютный маркер. Годы/IDs без валюты рядом не попадают.
 */
export function extractAmountClaims(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(NUMBER_RE)) {
    const raw = m[0];
    const idx = m.index ?? 0;
    const grouped = /[ \u00A0\u202F,]/.test(raw);
    const around = text.slice(Math.max(0, idx - 14), Math.min(text.length, idx + raw.length + 14));
    if (!grouped && !CURRENCY_RE.test(around)) continue;
    out.add(normalizeDigits(raw));
  }
  return [...out];
}

/**
 * Возвращает противоречие, если ответ заявляет денежные суммы, сетевые тулы
 * использовались, но ни одна сумма не встречается в их выводе.
 */
export function checkWebClaims(
  response: string,
  tools: ClaimToolEvidence[],
): ClaimContradiction | null {
  if (!response) return null;
  const claims = extractAmountClaims(response);
  if (claims.length === 0) return null;

  const fetched = tools.filter((t) => t.name && WEB_TOOLS.has(t.name) && t.ok !== false && t.text.trim());
  if (fetched.length === 0) return null; // веб не трогали — не наш класс
  // Рамка недоверенного контента снимается: в corpus нужны сами данные.
  const corpus = fetched.map((t) => normalizeDigits(unwrapUntrusted(t.text))).join("\n");

  const missing = claims.filter((c) => !corpus.includes(c));
  if (missing.length === 0) return null;
  return {
    tool: "web-grounding",
    snippet: `amount(s) absent from fetched pages: ${missing.slice(0, 3).join(", ")}`,
  };
}
