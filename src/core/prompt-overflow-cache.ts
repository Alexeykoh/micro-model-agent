/**
 * Дисковый кэш суммаризаций переполнения (B9).
 *
 * Вынесено из `prompt-overflow-resolve.ts` (правило ≤300 строк): записи,
 * ключи, чтение (точное + sibling-reuse при смене бюджета) и запись.
 * Без поведения LLM — только best-effort персист на диске.
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { PromptBlockKind } from "./types";
import type { OverflowWarning } from "./prompt-overflow";
import type { Logger } from "../logger/app-logger";
import { estimateTokens } from "../llm/token-counter";

/** Запись дискового кэша суммаризаций (с атрибутами для sibling-reuse). */
export interface SummaryCacheEntry {
  mode: OverflowWarning["mode"];
  text: string;
  /** Класс блока — переиспользуем только внутри своего класса. */
  kind?: PromptBlockKind;
  /** Модель-суммаризатор — чужая выжимка не переиспользуется. */
  model?: string;
  /** Хеш исходного контента — инвалидация правками. */
  contentHash?: string;
  /** Бюджет, под который писалась выжимка. */
  maxTokens?: number;
}

/** Короткий хеш контента для ключей и sibling-сверки. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 24);
}

/** Точный ключ записи: класс + модель + бюджет + контент. */
export function cacheKey(
  kind: PromptBlockKind,
  content: string,
  maxTokens: number,
  model: string,
): string {
  return createHash("sha256").update(`${kind}|${model}|${maxTokens}|${content}`).digest("hex").slice(0, 24);
}

function parseCacheEntry(raw: string): SummaryCacheEntry | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as SummaryCacheEntry;
    if ((parsed.mode === "summary" || parsed.mode === "truncate") && typeof parsed.text === "string" && parsed.text) {
      return parsed;
    }
  } catch {
    // Легаси plain-text запись — считаем попаданием суммаризации
    return { mode: "summary", text };
  }
  return null;
}

/** Точное попадание по ключу; битый кэш — null (идём на повторную суммаризацию). */
export function readCache(cacheDir: string, key: string): SummaryCacheEntry | null {
  try {
    const path = join(cacheDir, `${key}.md`);
    if (!existsSync(path)) return null;
    return parseCacheEntry(readFileSync(path, "utf-8"));
  } catch {
    // Битый кэш — идём на повторную суммаризацию
  }
  return null;
}

/**
 * Sibling-reuse: точный ключ промахнулся (сменился бюджет), но в кэше
 * лежит выжимка того же контента той же моделью под другой бюджет.
 * Влезает — переиспользуем без LLM-вызова.
 */
export function readSiblingCache(
  cacheDir: string,
  kind: PromptBlockKind,
  model: string,
  hash: string,
  maxTokens: number,
  logger?: Logger,
): SummaryCacheEntry | null {
  let entries: string[];
  try {
    entries = readdirSync(cacheDir).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }
  let best: SummaryCacheEntry | null = null;
  for (const file of entries) {
    let entry: SummaryCacheEntry | null = null;
    try {
      entry = parseCacheEntry(readFileSync(join(cacheDir, file), "utf-8"));
    } catch {
      continue;
    }
    if (!entry || entry.kind !== kind || entry.model !== model || entry.contentHash !== hash) continue;
    if (estimateTokens(entry.text) <= maxTokens && (!best || (best.maxTokens ?? 0) < (entry.maxTokens ?? 0))) {
      best = entry;
    }
  }
  if (!best) return null;
  logger?.debug(`Prompt overflow: sibling cache hit for ${kind} (model ${model}, fits ${maxTokens} tok)`);
  return best;
}

/** Best-effort запись: падение кэша не должно ронять агента. */
export function writeCache(cacheDir: string, key: string, entry: SummaryCacheEntry): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, `${key}.md`), JSON.stringify(entry), "utf-8");
  } catch {
    // Best-effort — падение кэша не должно ронять агента
  }
}
