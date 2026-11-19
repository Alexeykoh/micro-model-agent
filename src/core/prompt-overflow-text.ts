/**
 * Текстовые примитивы резолва переполнения: усечение, метки, сбор ответа LLM.
 *
 * Вынесено из `prompt-overflow-resolve.ts` (правило ≤300 строк). Чистые функции
 * плюс тонкий клиент стриминга; без состояния резолва.
 */
import type { LLMProvider } from "../llm/provider";
import { estimateTokens } from "../llm/token-counter";

/** Грубый фактор символов на токен для стартовой догадки усечения (B8: латиница). */
export const CHARS_PER_TOKEN = 4;

/**
 * Потолок запроса генерации под окно контекста (B10): просить `2×maxTokens`
 * вслепую опасно на малых окнах — вход (целый AGENTS.md) плюс запрос могут
 * не влезть, и суммаризация упадёт целиком. Без окна — старое поведение.
 */
export function capCompletion(
  requested: number,
  promptText: string,
  contextWindow?: number,
): number {
  if (!contextWindow || contextWindow <= 0) return requested;
  const cap = contextWindow - estimateTokens(promptText) - 256;
  if (cap < 256) return Math.min(requested, 256);
  return Math.min(requested, cap);
}

/** Собирает полный текстовый ответ через стриминговый API провайдера. */
export async function collectText(
  provider: LLMProvider,
  prompt: string,
  maxTokens: number,
  sessionId?: string,
): Promise<string> {
  let text = "";
  // Reasoning выкл. Механизм ("none" → /no_think у prompt-tag, reasoning_effort
  // у openai-effort) выбирает САМ провайдер из своей стратегии (INV-R1) — здесь
  // её знать не нужно и нельзя забыть.
  // 2x запас: оценки эвристичны, clamp ниже держит реальный cap (B10: cap —
  // на вызывающей стороне, сюда приходит уже финальное число).
  for await (const chunk of provider.chat([{ role: "user", content: prompt }], undefined, undefined, {
    maxTokens,
    reasoningEffort: "none",
    sessionId,
  })) {
    if (chunk.type === "text" && chunk.content) text += chunk.content;
  }
  return text.trim();
}

/**
 * Жёсткое усечение с гарантией бюджета (B8): фиксированный делитель врёт на
 * нелатинице (кириллица ~2.5 симв/ток — срез «до N×4 символов» даёт ~1.6×N
 * токенов и бюджет рвётся именно на русском тексте). Поэтому режем итеративно
 * до `estimateTokens(cut) ≤ maxTokens`, маркер обрезки входит в бюджет.
 */
export function truncateToTokens(content: string, maxTokens: number): string {
  if (estimateTokens(content) <= maxTokens) return content;
  const suffix = "\n\n[...truncated — read the full file for details...]";
  const suffixTokens = estimateTokens(suffix);
  const bodyBudget = Math.max(1, maxTokens - suffixTokens);
  let maxChars = Math.max(200, bodyBudget * CHARS_PER_TOKEN);
  let cut = content;
  for (let i = 0; i < 3; i++) {
    cut = content.slice(0, maxChars);
    const lastBreak = cut.lastIndexOf("\n");
    if (lastBreak > maxChars * 0.5) cut = cut.slice(0, lastBreak);
    const tokens = estimateTokens(cut);
    if (tokens <= bodyBudget) break;
    maxChars = Math.max(200, Math.floor((maxChars * bodyBudget) / tokens));
  }
  cut = cut.trimEnd();
  while (estimateTokens(cut + suffix) > maxTokens && cut.length > 200) {
    cut = cut.slice(0, Math.floor(cut.length * 0.8)).trimEnd();
  }
  return `${cut}${suffix}`;
}

/** Однострочная метка по первой строке (для варнингов/логов). */
export function blockLabel(content: string): string {
  const first = content.split("\n")[0].trim();
  return first.length > 60 ? `${first.slice(0, 57)}...` : first;
}
