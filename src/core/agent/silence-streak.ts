/**
 * Серия молчания — индикатор того, что пользователь ничего не видит: подряд
 * идущие пакеты тулов, в которых ассистент не сказал ни слова.
 *
 * Счётчик живёт в пределах хода: серия прерывается видимым пользователю
 * текстом (в том числе ответом без вызовов тулов) и не переживает границу
 * хода. Иначе тишина, замеченная в прошлом ходе, убивала новый запрос
 * пользователя на первом же пакете (ses_mwc2p7hh_…, 2026-11-11).
 */
import type { LoopState } from "./loop-state";
import { clearDirective, type DirectiveSink } from "./directives";

/**
 * Обнулить серию молчания и снять директиву «скажи, что делаешь»: условие
 * директивы (пользователь не слышал модели) перестало выполняться.
 */
export function resetSilenceStreak(state: LoopState, sink: DirectiveSink): void {
  state.consecutiveSilentBatches = 0;
  state.narrationNudged = false;
  clearDirective(sink, "narration");
}
