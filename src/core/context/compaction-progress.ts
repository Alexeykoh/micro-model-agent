// Детектор «компакция без прогресса» (INV-15). Серия компакций, не прибавивших
// ни одного нового адреса в durable-леджер, — сигнал вырожденной петли: модель
// сжимает историю, ничего не узнавая (именно эта петля дала крайний прогон).
// Диагностика fail-open: не меняет поведение компакции, только делает деградацию
// различимой в `session.jsonl`. Вынесено из `manager.ts` (правило ≤300 строк;
// потолок файла уже на пределе).

/** Порог серии: столько компакций подряд без роста леджера считаются деградацией. */
const NO_PROGRESS_THRESHOLD = 2;

/** Диагностика отсутствия прогресса компакции. */
export interface ProgressDiagnostic {
  /** Вид сигнала: пока только `"no-progress"`. */
  kind: string;
  /** Длина серии компакций без прогресса (на момент эмита). */
  compactions: number;
}

/**
 * Считает серию компакций без роста durable-леджера. Прогресс-прокси —
 * монотонный `totalRecorded()` леджера (не `size()`: тот насыщается на cap и на
 * длинной сессии выглядел бы как «нет прогресса»): новая находка (`path:line`)
 * увеличивает счётчик, повторное чтение того же адреса — нет.
 */
export class CompactionProgressTracker {
  private lastSize = 0;
  private streak = 0;
  private sink: ((d: ProgressDiagnostic) => void) | null = null;

  /** Ставит sink диагностики (или снимает его при `null`). */
  setSink(fn: ((d: ProgressDiagnostic) => void) | null): void {
    this.sink = fn;
  }

  /**
   * Фиксирует размер леджера после компакции. Рост сбрасывает серию, отсутствие
   * роста — копит. На пороге серия эмитится И сбрасывается: иначе сигнал
   * повторялся бы на каждой следующей компакции подряд и терял смысл «началась
   * вырожденная серия» (решение: один сигнал на серию).
   */
  note(ledgerSize: number): void {
    if (ledgerSize > this.lastSize) this.streak = 0;
    else this.streak++;
    this.lastSize = ledgerSize;
    if (this.streak < NO_PROGRESS_THRESHOLD) return;
    const compactions = this.streak;
    this.streak = 0;
    try {
      this.sink?.({ kind: "no-progress", compactions });
    } catch {
      // FAIL-OPEN (INV-15): диагностика не должна ронять ход.
    }
  }

  /** Сбрасывает состояние (clear() менеджера). */
  reset(): void {
    this.lastSize = 0;
    this.streak = 0;
  }
}
