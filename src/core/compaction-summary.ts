// Человекочитаемая сводка компакции для `content` в session.jsonl: причина +
// итерация и отчёт «до → после» (токены/качество/сообщения/ходы) со стадией
// сокращения. Вынесено из `session-logger.ts` (правило ≤300 / file-size
// ceiling), чтобы Trace показывал «сколько и что убрали» без разбора
// структурированных полей лога.

/** Вход сводки: поля `logCompaction` (все, кроме reason/iteration, опциональны). */
export interface CompactionInfo {
  reason: string;
  iteration: number;
  tokensBefore?: number;
  tokensAfter?: number;
  qualityBefore?: number;
  qualityAfter?: number;
  messagesBefore?: number;
  messagesAfter?: number;
  removedTurns?: number;
  keptTurns?: number;
  reducedBy?: number;
  strategy?: string;
}

/** Собирает строку-отчёт компакции для `content`. */
export function compactionSummary(info: CompactionInfo): string {
  const bits: string[] = [];
  if (typeof info.tokensBefore === "number" && typeof info.tokensAfter === "number") {
    const delta = info.reducedBy ?? info.tokensBefore - info.tokensAfter;
    bits.push(`tokens ${info.tokensBefore}→${info.tokensAfter} (−${delta})`);
  }
  if (typeof info.qualityBefore === "number" && typeof info.qualityAfter === "number") {
    bits.push(`quality ${info.qualityBefore}→${info.qualityAfter}`);
  }
  if (typeof info.messagesBefore === "number" && typeof info.messagesAfter === "number") {
    bits.push(`messages ${info.messagesBefore}→${info.messagesAfter}`);
  }
  if (typeof info.removedTurns === "number" || typeof info.keptTurns === "number") {
    bits.push(`turns −${info.removedTurns ?? 0}/+${info.keptTurns ?? 0}`);
  }
  if (info.strategy) bits.push(info.strategy);
  const head = `${info.reason}, iteration ${info.iteration}`;
  return bits.length ? `${head} — ${bits.join(", ")}` : head;
}
