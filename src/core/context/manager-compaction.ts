/**
 * Компакция контекста: summarize → prune tool results → aggressive → hard drop,
 * чистка протухших tool-результатов и счётчики значимости. Вынесено из
 * `manager.ts` (правило 6); порядок стадий, счётчики и пороги те же. Блок
 * сводки и граница среза — в `manager-compaction-block.ts`.
 */
import { getMessageText } from "../../llm/provider";
import { absorbLedgers } from "./ledger-absorb";
import { reassertStandingDirectives } from "./standing-directives";
import type { Message } from "./message";
import { KEEP_LAST_N, type CompactOptions, type CompactResult } from "./manager-types";
import type { ContextState } from "./manager-state";
import { estimatedTokens, invalidateEstimate } from "./manager-estimate";
import { qualityScore } from "./manager-quality";
import { stampSeq } from "./manager-history";
import { buildCompactionBlock, computeCutoff } from "./manager-compaction-block";

/** Подмечает прогресс durable-леджера для трекера «компакция без прогресса». */
function noteCompactionProgress(s: ContextState): void {
  s.compactionProgress.note(s.ledger?.totalRecorded() ?? 0);
}

/** Уплотняет историю: старые ходы → сводка фактов, свежие — дословно. Null, если уплотнять нечего. */
export function compact(s: ContextState, opts?: CompactOptions): CompactResult | null {
  const keepLastN = opts?.keepLastN ?? KEEP_LAST_N;
  // Снимаем состояние ДО компакции ПЕРЕД сбросом/ростом счётчиков —
  // qualityBefore обязан отражать контекст, который реально видела модель.
  const tokensBefore = estimatedTokens(s);
  const qualityBefore = qualityScore(s);
  const messagesBefore = s.messages.length;

  // Сбрасываем счётчик, даже если уплотнять нечего — иначе
  // needsCompaction() вечно true после 15 итераций с малым числом сообщений.
  s.iterationsSinceCompaction = 0;
  if (s.messages.length <= keepLastN * 2) return null;

  const cutoff = computeCutoff(s.messages, keepLastN);
  const oldTurns = s.messages.slice(0, cutoff);
  const recentTurns = s.messages.slice(cutoff);

  s.facts.extract(oldTurns);
  absorbLedgers(
    oldTurns,
    s.ledger,
    s.compactionSummaryMode !== "off",
    s.toolLedger,
    s.toolLedgerKeys,
  );

  s.compactedBlock = buildCompactionBlock(s, oldTurns);
  const summary: Message = stampSeq(s, {
    role: "user",
    content: `<system-summary>${s.compactedBlock}</system-summary>`,
  });
  // T4: сводка производна от сжатого ввода — taint переходит.
  if (oldTurns.some((m) => s.book.isTainted(m))) s.book.markTainted(summary);

  const firstSystem = s.messages.find((m) => m.role === "system");
  // Чистим протухшие system-summary из свежих ходов против вложенности
  const freshRecent = recentTurns.filter((m) => {
    if (m.role !== "user") return true;
    const text = getMessageText(m.content);
    return !text.startsWith("<system-summary>");
  });
  s.messages = [...(firstSystem ? [firstSystem] : []), summary, ...freshRecent];
  // Директивы харнесса живут в отдельном реестре: компакция вырезала все
  // `<system-summary>`, а условие директивы (стрик) осталось активным — модель
  // теряла указание и больше не получала его (§1.5 аудита).
  const reassert = reassertStandingDirectives(s.standingDirectives, s.messages);
  if (reassert) {
    s.messages.push(
      stampSeq(s, { role: "user", content: `<system-summary>${reassert}</system-summary>` }),
    );
  }
  s.iterationsSinceCompaction = 0;
  // Компакция переписала историю — baseline калибровки недействителен.
  invalidateEstimate(s);

  return finalizeCompact(s, {
    opts,
    summary,
    oldTurns,
    freshRecent,
    tokensBefore,
    qualityBefore,
    messagesBefore,
  });
}

/** Собирает результат компакции, решает значимость и ведёт счётчик/onCompact. */
function finalizeCompact(
  s: ContextState,
  ctx: {
    opts?: CompactOptions;
    summary: Message;
    oldTurns: Message[];
    freshRecent: Message[];
    tokensBefore: number;
    qualityBefore: number;
    messagesBefore: number;
  },
): CompactResult {
  const tokensAfter = estimatedTokens(s);
  const reducedBy = ctx.tokensBefore - tokensAfter;
  // Значимое сокращение: только тогда инкрементим счётчик и зовём onCompact.
  // No-op (reducedBy <= minReduction) не логируется и не искажает качество.
  const significant = ctx.opts?.minReduction === undefined || reducedBy > ctx.opts.minReduction;
  if (significant) {
    s.compactionCount++;
    // INV-15: прогресс-прокси — размер durable-леджера после поглощения адресов.
    noteCompactionProgress(s);
  }
  const result: CompactResult = {
    removedTurns: ctx.oldTurns.length,
    keptTurns: ctx.freshRecent.length,
    tokensBefore: ctx.tokensBefore,
    tokensAfter,
    qualityBefore: ctx.qualityBefore,
    qualityAfter: qualityScore(s),
    messagesBefore: ctx.messagesBefore,
    messagesAfter: s.messages.length,
    summary: s.compactedBlock ?? "",
    reducedBy,
    strategy:
      ctx.opts?.keepLastN !== undefined && ctx.opts.keepLastN < KEEP_LAST_N
        ? "aggressive"
        : "summarize",
  };
  if (significant && s.onCompact) s.onCompact(ctx.summary);
  return result;
}

/**
 * Stage A: детерминированная чистка старых tool-результатов (содержимое →
 * короткая заглушка). Никогда не трогает последние `protectLast` сообщений.
 * @returns число очищенных результатов.
 */
export function pruneStaleToolResults(
  s: ContextState,
  toolResultKeep = s.toolResultKeep,
  protectLast = KEEP_LAST_N,
): number {
  const toolIdx: number[] = [];
  for (let i = 0; i < s.messages.length; i++) {
    if (s.messages[i].role === "tool") toolIdx.push(i);
  }
  const protectedFrom = s.messages.length - protectLast;
  const keepFrom = toolIdx.length - toolResultKeep;
  let pruned = 0;
  for (let j = 0; j < toolIdx.length; j++) {
    const i = toolIdx[j];
    if (i >= protectedFrom) continue;
    if (j >= keepFrom) continue;
    const m = s.messages[i];
    const text = getMessageText(m.content);
    if (text.startsWith("[tool result pruned")) continue;
    s.messages[i] = { ...m, content: "[tool result pruned to save context]" };
    pruned++;
  }
  if (pruned > 0) invalidateEstimate(s);
  return pruned;
}