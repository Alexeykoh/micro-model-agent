/**
 * Диагностика сессии по сигнатурам (`mma session diagnose`, спека W5).
 *
 * Разбор боевого `session.jsonl` — это чтение сотен записей глазами, и он не
 * воспроизводится: тот же вопрос через неделю даёт другой ответ. Модуль
 * превращает разбор в список патологий, каждая из которых уже была причиной
 * реального фикса.
 *
 * Модуль **читает** и ничего не меняет: ни конфиг, ни сессию, ни лог. Иначе
 * инструмент разбора сам становится источником изменений.
 *
 * Каталог сигнатур живёт в `docs/agents/observability.md` (INV-15), а пороги —
 * здесь, именованными константами: их правка не должна выглядеть как «случайно
 * поменялось поведение».
 */

import { gateStall } from "./diagnose-gates";

/** Пороги сигнатур. Числа здесь — контракт, а не магия в коде. */
export const thresholds = {
  /** Компакций подряд без прогресса, после которых это стадл. */
  compactionStall: 3,
  /** Повторов одного падения тула, после которых это паттерн. */
  toolFailureRepeat: 3,
  /** Повторов одного паттерна блокировки. */
  securityBlockRepeat: 2,
  /** Повторов `claim_retry` одного класса. */
  claimRetryRepeat: 2,
  /**
   * Проход гейтов дольше этого — «ход стоял после уже доставленного ответа»
   * (A15). 30 с: крик и аудит вместе должны укладываться в это с запасом, а
   * 120-секундный хвост виден сразу.
   */
  gateStallMs: 30_000,
} as const;

/** Каталог сигнатур: порядок — порядок вывода. */
export const SIGNATURE_KINDS = [
  "compaction_stall",
  "prompt_block_dropped",
  "critic_degraded",
  "gate_stall",
  "tool_failure_repeat",
  "security_block_repeat",
  "claim_retry",
] as const;

export type SignatureKind = (typeof SIGNATURE_KINDS)[number];

/** Найденная патология. `count` — сколько раз, `detail` — чем именно. */
export interface Signature {
  kind: SignatureKind;
  count: number;
  first: string;
  last: string;
  detail: string;
}

/** Итог разбора: сигнатуры плюс сырые счётчики для контекста. */
export interface DiagnoseReport {
  sessionId: string;
  entries: number;
  signatures: Signature[];
  summary: {
    compactionCount: number;
    criticErrors: number;
    blockedCommands: number;
    droppedPromptBlocks: number;
  };
}

/** Минимальный вид записи, который нужен разбору (не весь `SessionLogEntry`). */
type Entry = Record<string, unknown>;

function str(e: Entry, key: string): string | undefined {
  const v = e[key];
  return typeof v === "string" ? v : undefined;
}

function num(e: Entry, key: string): number | undefined {
  const v = e[key];
  return typeof v === "number" ? v : undefined;
}

function byType(entries: Entry[], type: string): Entry[] {
  return entries.filter((e) => e.type === type);
}

/** Компакции подряд: серия, где следующая идёт в пределах 2 минут предыдущей. */
function compactionStall(entries: Entry[]): Signature | null {
  const compactions = byType(entries, "compaction");
  if (compactions.length < thresholds.compactionStall) return null;

  let run = 0;
  let longest = 0;
  let runStart = "";
  let bestStart = "";
  for (let i = 0; i < compactions.length; i++) {
    const ts = str(compactions[i], "ts") ?? "";
    const prev = i > 0 ? str(compactions[i - 1], "ts") : undefined;
    const adjacent =
      prev !== undefined && Math.abs(new Date(ts).getTime() - new Date(prev).getTime()) < 120_000;
    if (i === 0 || !adjacent) {
      if (run > longest) {
        longest = run;
        bestStart = runStart;
      }
      run = 0;
      runStart = ts;
    }
    run++;
  }
  if (run > longest) {
    longest = run;
    bestStart = runStart;
  }
  if (longest < thresholds.compactionStall) return null;

  const last = str(compactions[compactions.length - 1], "ts") ?? "";
  const strategies = new Set(compactions.map((c) => str(c, "strategy") ?? "unknown"));
  const degraded = byType(entries, "context_degraded").length;
  return {
    kind: "compaction_stall",
    count: longest,
    first: bestStart,
    last,
    detail:
      `серия из ${longest} компакций подряд (стратегии: ${[...strategies].join(", ")}); ` +
      `контекст сжимается без прогресса леджера, сигналов context_degraded: ${degraded}`,
  };
}

/** Блоки промпта, не влезшие в бюджет: по подписи и числу токенов. */
function droppedPromptBlocks(entries: Entry[]): Signature[] {
  const dropped = new Map<string, { count: number; tokens: number; first: string; last: string }>();
  for (const e of byType(entries, "context")) {
    const blocks = e.blocks;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks as Entry[]) {
      if (b.included !== false) continue;
      const label = str(b, "label") ?? "unknown";
      const cur = dropped.get(label) ?? { count: 0, tokens: 0, first: "", last: "" };
      const ts = str(e, "ts") ?? "";
      cur.count++;
      cur.tokens = Math.max(cur.tokens, num(b, "tokens") ?? 0);
      cur.first ||= ts;
      cur.last = ts;
      dropped.set(label, cur);
    }
  }
  return [...dropped.entries()]
    .map(([label, v]) => ({
      kind: "prompt_block_dropped" as const,
      count: v.count,
      first: v.first,
      last: v.last,
      detail: `блок «${label}» не влезал в бюджет ${v.count} раз (до ${v.tokens} токенов)`,
    }))
    .sort((a, b) => b.count - a.count);
}

function criticDegraded(entries: Entry[]): Signature | null {
  const errors = byType(entries, "critic_error");
  if (errors.length === 0) return null;
  const operations = new Set(errors.map((e) => str(e, "operation") ?? "critic.verify"));
  return {
    kind: "critic_degraded",
    count: errors.length,
    first: str(errors[0], "ts") ?? "",
    last: str(errors[errors.length - 1], "ts") ?? "",
    detail:
      `критик не дал вердикта ${errors.length} раз (операции: ${[...operations].join(", ")}); ` +
      `ход продолжался как pass — верификация не состоялась`,
  };
}

/** Повторяющиеся отказы тулов: группировка по имени тула. */
function toolFailureRepeat(entries: Entry[]): Signature[] {
  const failures = new Map<
    string,
    { count: number; first: string; last: string; sample: string }
  >();
  for (const e of byType(entries, "tool_result")) {
    if (e.success !== false) continue;
    const tool = str(e, "tool") ?? "unknown";
    const ts = str(e, "ts") ?? "";
    const cur = failures.get(tool) ?? { count: 0, first: ts, last: ts, sample: "" };
    cur.count++;
    cur.last = ts;
    cur.sample ||= (str(e, "content") ?? "").slice(0, 120);
    failures.set(tool, cur);
  }
  return [...failures.entries()]
    .filter(([, v]) => v.count >= thresholds.toolFailureRepeat)
    .map(([tool, v]) => ({
      kind: "tool_failure_repeat" as const,
      count: v.count,
      first: v.first,
      last: v.last,
      detail: `тул ${tool} падал ${v.count} раз; последняя причина: ${v.sample}`,
    }));
}

/** Паттерн блокировки: текст между «is not allowed:» и концом, схлопнутый до сути. */
function blockPattern(content: string): string | null {
  if (!content.includes("[SECURITY BLOCKED]")) return null;
  const m = /is not allowed:\s*(.+)/.exec(content);
  const tail = (m?.[1] ?? content).trim().slice(0, 80);
  return tail.length > 0 ? tail : "SECURITY BLOCKED";
}

function securityBlockRepeat(entries: Entry[]): Signature[] {
  const blocks = new Map<string, { count: number; first: string; last: string }>();
  for (const e of byType(entries, "tool_result")) {
    if (e.success !== false) continue;
    const pattern = blockPattern(str(e, "content") ?? "");
    if (!pattern) continue;
    const ts = str(e, "ts") ?? "";
    const cur = blocks.get(pattern) ?? { count: 0, first: ts, last: ts };
    cur.count++;
    cur.last = ts;
    blocks.set(pattern, cur);
  }
  return [...blocks.entries()]
    .filter(([, v]) => v.count >= thresholds.securityBlockRepeat)
    .map(([pattern, v]) => ({
      kind: "security_block_repeat" as const,
      count: v.count,
      first: v.first,
      last: v.last,
      detail: `паттерн блокировки «${pattern}» повторился ${v.count} раз — модель упирается в одну стену`,
    }));
}

/** Ретраи хода: `claim_retry` с классом (`kind`). */
function claimRetries(entries: Entry[]): Signature[] {
  const retries = new Map<string, { count: number; first: string; last: string }>();
  for (const e of byType(entries, "claim_retry")) {
    const cls = str(e, "kind") ?? "unknown";
    const ts = str(e, "ts") ?? "";
    const cur = retries.get(cls) ?? { count: 0, first: ts, last: ts };
    cur.count++;
    cur.last = ts;
    retries.set(cls, cur);
  }
  return [...retries.entries()]
    .filter(([, v]) => v.count >= thresholds.claimRetryRepeat)
    .map(([cls, v]) => ({
      kind: "claim_retry" as const,
      count: v.count,
      first: v.first,
      last: v.last,
      detail: `ход уходил в ретрай (класс ${cls}) ${v.count} раз — модель не выдавала годный ответ`,
    }));
}

/** Порядок вывода: по каталогу, внутри вида — по частоте. */
const ORDER = new Map(SIGNATURE_KINDS.map((k, i) => [k, i]));

/**
 * Разобрать записи сессии в список сигнатур.
 *
 * Пустая/чистая сессия даёт пустой список, а не исключение: «ничего не
 * нашлось» — валидный результат разбора.
 */
export function diagnoseSession(sessionId: string, entries: Entry[]): DiagnoseReport {
  const signatures: Signature[] = [
    ...(compactionStall(entries) ? [compactionStall(entries)!] : []),
    ...droppedPromptBlocks(entries),
    ...(criticDegraded(entries) ? [criticDegraded(entries)!] : []),
    ...gateStall(entries, thresholds.gateStallMs),
    ...toolFailureRepeat(entries),
    ...securityBlockRepeat(entries),
    ...claimRetries(entries),
  ].sort((a, b) => ORDER.get(a.kind)! - ORDER.get(b.kind)! || b.count - a.count);

  return {
    sessionId,
    entries: entries.length,
    signatures,
    summary: {
      compactionCount: byType(entries, "compaction").length,
      criticErrors: byType(entries, "critic_error").length,
      blockedCommands: byType(entries, "tool_result").filter(
        (e) => e.success === false && (str(e, "content") ?? "").includes("[SECURITY BLOCKED]"),
      ).length,
      droppedPromptBlocks: signatures.filter((s) => s.kind === "prompt_block_dropped").length,
    },
  };
}
