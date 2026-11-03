/**
 * Блок сводки компакции и граница среза истории. Вынесено из
 * `manager-compaction.ts` (правило 6): тот же текст блока, тот же pinning-набор
 * (задача, фидбек, план, факты, thinking, леджер, «пробовали и не вышло»).
 */
import { extractTriedAndFailed } from "./message-analysis";
import type { Message } from "./message";
import type { ContextState } from "./manager-state";

/**
 * Граница компакции. Не режет группу assistant(tool_calls): сохранённая
 * история не должна начинаться с сиротских role:"tool", а assistant-половина —
 * остаться в уплотняемой части (OpenAI-совместимые бэкенды такие истории отвергают).
 */
export function computeCutoff(messages: Message[], keepLastN: number): number {
  let cutoff = messages.length - keepLastN * 2;
  while (
    cutoff > 0 &&
    (messages[cutoff]?.role === "tool" || messages[cutoff - 1]?.tool_calls?.length)
  ) {
    cutoff--;
  }
  return cutoff;
}

/**
 * Собирает внутренний блок сводки компакции из фактов и pinning-констант
 * (задача, план, thinking, «пробовали и не вышло»).
 */
export function buildCompactionBlock(s: ContextState, oldTurns: Message[]): string {
  const parts: string[] = [];
  parts.push(`[Compressed: ${oldTurns.length} old turns removed]`);

  // Проносим реальную инструкцию юзера — модель не должна терять задачу,
  // над которой работает, лишь потому что уплотнилось 40 ходов. Задача хода
  // фолбэчится на миссию сессии (первую реальную инструкцию), чтобы вставка
  // ошибки/лога в текущем ходе не стирала цель.
  const task = (s.lastUserTask || s.sessionMission).slice(0, 400);
  if (task) parts.push(`[Task: ${task}]`);
  if (s.lastUserFeedback && !task.startsWith(s.lastUserFeedback)) {
    parts.push(`[User feedback: ${s.lastUserFeedback}]`);
  }

  // Ориентируем модель после компакции: активный план нельзя пересоздавать
  // с нуля (см. доку planSummaryProvider).
  const planLine = s.planSummaryProvider?.();
  if (planLine) parts.push(`[Plan: ${planLine}]`);

  for (const line of [
    s.facts.filesLine(),
    s.facts.deletedLine(),
    s.facts.readLine(),
    s.facts.decisionsLine(),
    s.facts.errorsLine(),
  ]) {
    if (line) parts.push(line);
  }

  if (s.thinkingLevel) parts.push(`[Thinking: ${s.thinkingLevel}]`);

  // Леджер: при durable леджере — компактный список адресов-находок (не
  // сырой вывод) + указатель; плюс legacy `[Tool ledger]` для тулов без адреса.
  if (s.compactionSummaryMode !== "off") {
    if (s.ledger) {
      const notes = s.ledger.renderBlock();
      if (notes) parts.push(notes);
    }
    if (s.toolLedger.length > 0) {
      parts.push(`[Tool ledger]\n${s.toolLedger.join("\n")}`);
    }
  }

  const triedAndFailed = extractTriedAndFailed(oldTurns);
  if (triedAndFailed.length > 0) {
    const lines = triedAndFailed.map(
      (t) => `- ${t.tool}(${t.args}): ${t.error} (failed ${t.count}x)`,
    );
    parts.push(`[Already tried & failed — do NOT repeat:]\n${lines.join("\n")}`);
  }

  return parts.join(" ");
}
