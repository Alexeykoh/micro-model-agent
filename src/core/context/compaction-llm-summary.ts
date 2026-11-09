/**
 * LLM-сводка удалённых turns для компакции (`compactionSummary: "llm"`).
 * Spec: `docs/specs/2026-11-09-compaction-llm-design.md`.
 *
 * Bounded, fail-open: любая ошибка провайдера → `null`, вызывающий слой
 * компактит как в режиме `ledger`. Кэш best-effort на диске:
 * `<project>/.mma/cache/compaction-summaries/<sha256>.md`.
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getMessageText, type LLMProvider } from "../../llm/provider";
import type { Message } from "./message";

/** Таймаут вызова суммаризации (не должен вешать цикл). */
export const LLM_SUMMARY_TIMEOUT_MS = 8000;
/** Целевой размер сводки в токенах. */
export const LLM_SUMMARY_TARGET_TOKENS = 256;
/** Кап входного текста для промпта (символы). */
const OLD_TURNS_TEXT_CAP = 8000;
/** Кап одного tool-результата в тексте turns. */
const TOOL_TEXT_PER_MESSAGE_CAP = 400;

/** Плоский текст удалённых turns для LLM-промпта. */
export function buildOldTurnsText(oldTurns: Message[]): string {
  const lines: string[] = [];
  for (const m of oldTurns) {
    let text = getMessageText(m.content).trim();
    if (!text) continue;
    // Плоско, без разметки: роль + одна строка (хи Keep tool-результаты короткими —
    // детали и так пинит ledger/facts).
    text = text.replace(/\s+/g, " ").slice(0, TOOL_TEXT_PER_MESSAGE_CAP);
    lines.push(`${m.role}: ${text}`);
    if (lines.join("\n").length >= OLD_TURNS_TEXT_CAP) break;
  }
  return lines.join("\n").slice(0, OLD_TURNS_TEXT_CAP);
}

function cacheKey(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function readCache(cacheDir: string, key: string): string | null {
  try {
    const path = join(cacheDir, `${key}.md`);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8").trim();
    return raw ? raw : null;
  } catch {
    return null;
  }
}

function writeCache(cacheDir: string, key: string, text: string): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, `${key}.md`), text, "utf-8");
  } catch {
    // Best-effort — кэш не должен ронять компакцию.
  }
}

/**
 * Суммаризирует старые turns в bullets (~256 токенов) через провайдера.
 * `null` при ошибке/пустом ответе/таймауте — вызывающий идёт ledger-only.
 */
export async function summarizeOldTurns(opts: {
  provider: LLMProvider | null;
  text: string;
  cacheDir: string;
  sessionId?: string;
}): Promise<string | null> {
  const { provider, text, cacheDir, sessionId } = opts;
  const input = text.trim();
  if (!input || !provider) return null;

  const key = cacheKey(input);
  const cached = readCache(cacheDir, key);
  if (cached) return cached;

  const prompt = [
    "Summarize the following past conversation turns as bullet points.",
    `Target length: at most ${LLM_SUMMARY_TARGET_TOKENS} tokens. Be strict.`,
    "Preserve concrete facts: file paths, decisions, what was already tried.",
    "Output ONLY the bullet points.",
    "",
    "--- TURNS START ---",
    input,
    "--- TURNS END ---",
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_SUMMARY_TIMEOUT_MS);
  try {
    let out = "";
    // 2x запас как в prompt-overflow-resolve.collectText: оценки эвристичны.
    for await (const chunk of provider.chat(
      [{ role: "user", content: prompt }],
      undefined,
      controller.signal,
      { maxTokens: LLM_SUMMARY_TARGET_TOKENS * 2, reasoningEffort: "none", sessionId },
    )) {
      if (chunk.type === "text" && chunk.content) out += chunk.content;
    }
    const summary = out.trim();
    if (!summary) return null;
    writeCache(cacheDir, key, summary);
    return summary;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
