/**
 * Помнит последнее действие тула, чтобы юзер мог допечатать его полные детали
 * по требованию (`Ctrl+O`), даже когда рендерер прогона уже ушёл.
 *
 * Хранится только последнее действие: это буфер удобства, а не лог. Полный
 * транскрипт живёт в логе сессии.
 */
export interface LastAction {
  /** Id тула — по нему допечатка красится акцентом категории. */
  tool: string;
  label: string;
  args: string;
  status: "ok" | "warn" | "error";
  durationMs: number;
  /** Полные строки тела (пути, дифф, вывод) — копятся вне зависимости от болтливости. */
  body: string[];
}

let last: LastAction | null = null;

/** Запоминает последнее действие. */
export function recordLastAction(action: LastAction): void {
  last = action;
}

/** Данные действия тула для запоминания (последняя карточка). */
export interface ToolActionSnapshot {
  tool: string;
  label: string;
  summary: string;
  error: boolean | undefined;
  durationMs: number;
  /** Первая непустая строка вывода — по ней «мягкая» ошибка отличается от жёсткой. */
  firstBody: string;
  /** Полное тело вывода (для допечатки по Ctrl+O). */
  body: string[];
}

/**
 * Запоминает действие тула для допечатки по `Ctrl+O`: статус выводится из
 * ошибки и первой строки вывода (предупреждение — не ошибка).
 */
export function recordToolAction(snap: ToolActionSnapshot): void {
  const status: "ok" | "warn" | "error" = !snap.error
    ? "ok"
    : snap.firstBody.startsWith("⚠")
      ? "warn"
      : "error";
  recordLastAction({
    tool: snap.tool,
    label: snap.label,
    args: snap.summary,
    status,
    durationMs: snap.durationMs,
    body: snap.body,
  });
}

/** Отдаёт последнее действие (null — не было). */
export function getLastAction(): LastAction | null {
  return last;
}

/** Сбрасывает запомненное действие. */
export function clearLastAction(): void {
  last = null;
}
