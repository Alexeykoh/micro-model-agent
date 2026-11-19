/**
 * Инварианты петли, проверяемые replay'ем (W7).
 *
 * Проверка значений вскрывает конкретное значение; проверка инварианта —
 * класс дефектов. «Компакций не больше, чем `ceil(N/cooldown)`», «один и тот же
 * паттерн блокировки не повторяется дважды подряд», «за ход не больше
 * 1 + (критик/сабагент) вызовов LLM» — такие утверждения ломаются на любом
 * будущем изменении петли, а не на том конкретном баге, который уже починен.
 *
 * Функции чистые и работают по списку записей `session.jsonl`: их можно
 * проверять и на реальной сессии, и на replay.
 */
import type { SessionLogEntry } from "../../src/modules/session/store";

/**
 * Интервалы (в итерациях) между соседними after-tool компакциями.
 *
 * Дефект C2 был не в общем числе компакций, а в том, что кулдаун после тула не
 * считался: две after-tool компакции на соседних итерациях сжимают контекст
 * дважды подряд, не давая ни леджеру вырасти, ни модели увидеть результат.
 */
export function afterToolCompactionGaps(
  entries: SessionLogEntry[],
  _cooldown = 3,
): number[] {
  const iterations = entries
    .filter((e) => e.type === "compaction" && e.reason === "after-tool")
    .map((e) => e.iteration)
    .filter((i): i is number => typeof i === "number");
  return iterations.slice(1).map((it, i) => it - iterations[i]);
}

/** Компакций на N итераций при кулодауне `cooldown`. */
export function compactionCeiling(iterations: number, cooldown: number): number {
  if (cooldown <= 0) return iterations;
  return Math.ceil(iterations / cooldown);
}

/** Итерации петли: максимальный номер итерации в логе. */
export function maxIteration(entries: SessionLogEntry[]): number {
  let max = 0;
  for (const e of entries) if (typeof e.iteration === "number" && e.iteration > max) max = e.iteration;
  return max;
}

/** Паттерн блокировки из текста `tool_result` или `null`. */
export function blockedPattern(entry: SessionLogEntry): string | null {
  const content = typeof entry.content === "string" ? entry.content : "";
  if (!content.includes("[SECURITY BLOCKED]")) return null;
  return /is not allowed:\s*(.+)/.exec(content)?.[1]?.trim().slice(0, 80) ?? "SECURITY BLOCKED";
}

/** Непрерывная серия одного и того же паттерна блокировки. */
export function longestBlockStreak(entries: SessionLogEntry[]): number {
  const seen = new Map<string, number>();
  let best = 0;
  for (const e of entries) {
    if (e.type !== "tool_result") continue;
    const pattern = blockedPattern(e);
    if (!pattern) continue;
    const run = (seen.get(pattern) ?? 0) + 1;
    seen.set(pattern, run);
    if (run > best) best = run;
  }
  return best;
}

/** Число падений одного тула подряд (без успешного вызова того же тула между ними). */
export function longestToolFailureStreak(entries: SessionLogEntry[]): number {
  const streak = new Map<string, number>();
  let best = 0;
  for (const e of entries) {
    if (e.type !== "tool_result" || !e.tool) continue;
    const run = e.success === false ? (streak.get(e.tool) ?? 0) + 1 : 0;
    streak.set(e.tool, run);
    if (run > best) best = run;
  }
  return best;
}

/** Вызовы LLM на итерацию: сколько записей `llm_usage` приходится на итерацию. */
export function maxLlmCallsPerIteration(entries: SessionLogEntry[]): number {
  const perIteration = new Map<number, number>();
  for (const e of entries) {
    if (e.type !== "llm_usage" || typeof e.iteration !== "number") continue;
    perIteration.set(e.iteration, (perIteration.get(e.iteration) ?? 0) + 1);
  }
  let max = 0;
  for (const n of perIteration.values()) if (n > max) max = n;
  return max;
}

/** Число компакций в логе. */
export function compactionCount(entries: SessionLogEntry[]): number {
  return entries.filter((e) => e.type === "compaction").length;
}

/** Серии компакций без прогресса: соседние по времени в пределах `windowMs`. */
export function compactionRuns(entries: SessionLogEntry[], windowMs = 120_000): number[] {
  const times = entries
    .filter((e) => e.type === "compaction")
    .map((e) => new Date(e.ts).getTime())
    .filter((t) => !Number.isNaN(t));
  const runs: number[] = [];
  let run = 0;
  for (let i = 0; i < times.length; i++) {
    const adjacent = i > 0 && times[i] - times[i - 1] < windowMs;
    if (!adjacent) {
      if (run > 0) runs.push(run);
      run = 0;
    }
    run++;
  }
  if (run > 0) runs.push(run);
  return runs;
}

/** Серии `critic_error` без успешного вердикта между ними. */
export function criticDegradedRuns(entries: SessionLogEntry[]): number[] {
  const runs: number[] = [];
  let run = 0;
  for (const e of entries) {
    if (e.type === "critic_verdict") {
      if (run > 0) runs.push(run);
      run = 0;
    } else if (e.type === "critic_error") {
      run++;
    }
  }
  if (run > 0) runs.push(run);
  return runs;
}

/** `claim_retry` по классам. */
export function claimRetriesByKind(entries: SessionLogEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (e.type !== "claim_retry") continue;
    const kind = e.kind ?? "unknown";
    out.set(kind, (out.get(kind) ?? 0) + 1);
  }
  return out;
}

/** Размер system-промпта в последнем запросе: байты системы + объявления тулов. */
export function systemPromptBytes(messages: Array<{ role: string; content: string }>): number {
  return messages
    .filter((m) => m.role === "system")
    .reduce((sum, m) => sum + m.content.length, 0);
}