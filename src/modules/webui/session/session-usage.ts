// Персист per-session метрик сайдбара `mma web` (usage последнего хода).
// In-memory `sessionUsage` теряется при reload/restart — маленький файл в
// каталоге сессии переживает и то, и другое.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageSnapshot } from "../state";

const FILE = "web-usage.json";
const SESSION_LOG = "session.jsonl";

/** Минимальный вид записи `llm_usage` (совместим с `SessionLogEntry`). */
export interface LlmUsageEntryLike {
  type?: string;
  promptTokens?: unknown;
  completionTokens?: unknown;
  cachedTokens?: unknown;
}

/**
 * Агрегирует накопленные тоталы из журнала сессии (`llm_usage`): фолбэк для
 * сессий, шедших вне `mma web` (REPL/one-shot) — у них нет `web-usage.json`,
 * а сайдбар без тоталов показывает прочерки. Та же сумма, что считает
 * `mma session show`. Undefined — в журнале нет ни одного `llm_usage`.
 */
export function usageFromLogEntries(
  entries: readonly LlmUsageEntryLike[],
): UsageSnapshot | undefined {
  let seen = false;
  let seenCached = false;
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  for (const e of entries) {
    if (e.type !== "llm_usage") continue;
    seen = true;
    if (typeof e.promptTokens === "number") prompt += e.promptTokens;
    if (typeof e.completionTokens === "number") completion += e.completionTokens;
    if (typeof e.cachedTokens === "number") {
      cached += e.cachedTokens;
      seenCached = true;
    }
  }
  if (!seen) return undefined;
  const snapshot: UsageSnapshot = { promptTokensTotal: prompt, completionTokensTotal: completion };
  if (seenCached) snapshot.cachedTokensTotal = cached;
  return snapshot;
}

/**
 * Тоталы из сырого `session.jsonl` каталога сессии. Битые и шифрованные
 * строки пропускаются (для шифрованных сессий работает путь через
 * `SessionManager.loadSessionLog` в `usage-cache.ts`).
 */
function usageFromSessionLogFile(sessionDir: string): UsageSnapshot | undefined {
  try {
    const path = join(sessionDir, SESSION_LOG);
    if (!existsSync(path)) return undefined;
    const entries: LlmUsageEntryLike[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as LlmUsageEntryLike);
      } catch {
        /* битая/шифрованная строка — пропуск, fail-open */
      }
    }
    return usageFromLogEntries(entries);
  } catch {
    return undefined;
  }
}

/** Сохраняет снимок usage в каталог сессии. Ошибки глотаются (best-effort). */
export function saveSessionUsage(sessionDir: string, usage: UsageSnapshot): void {
  try {
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, FILE), JSON.stringify(usage), "utf-8");
  } catch {
    /* нет прав/диска — метрики не персистим, UI продолжает с in-memory */
  }
}

/**
 * Читает снимок usage из каталога сессии; undefined — нет/битый/нет доступа.
 * Тоталы — максимум персиста и журнала: `web-usage.json` покрывает только
 * веб-эру сессии (первый веб-ход начинал счёт с нуля после REPL-эры), а
 * журнал `llm_usage` знает все вызовы. Максимум монотонно не убывает,
 * поэтому ротация/прунинг журнала не может погасить счёт. Без этого
 * REPL-сессии в вебе показывают прочерки, а следующий ход в вебе наращивал
 * счёт от нуля.
 */
export function loadSessionUsage(sessionDir: string): UsageSnapshot | undefined {
  let persisted: UsageSnapshot | undefined;
  try {
    const path = join(sessionDir, FILE);
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
      if (parsed && typeof parsed === "object") persisted = parsed as UsageSnapshot;
    }
  } catch {
    persisted = undefined;
  }
  return mergeJournalTotals(persisted, usageFromSessionLogFile(sessionDir));
}

/** Тоталы журнала поверх снимка: покомпонентный максимум (см. выше). */
export function mergeJournalTotals(
  snapshot: UsageSnapshot | undefined,
  journal: UsageSnapshot | undefined,
): UsageSnapshot | undefined {
  if (!snapshot) return journal;
  if (!journal) return snapshot;
  return {
    ...snapshot,
    promptTokensTotal: Math.max(snapshot.promptTokensTotal ?? 0, journal.promptTokensTotal ?? 0),
    completionTokensTotal: Math.max(
      snapshot.completionTokensTotal ?? 0,
      journal.completionTokensTotal ?? 0,
    ),
    cachedTokensTotal:
      journal.cachedTokensTotal !== undefined
        ? Math.max(snapshot.cachedTokensTotal ?? 0, journal.cachedTokensTotal)
        : snapshot.cachedTokensTotal,
  };
}
