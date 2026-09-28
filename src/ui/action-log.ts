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

/** Отдаёт последнее действие (null — не было). */
export function getLastAction(): LastAction | null {
  return last;
}

/** Сбрасывает запомненное действие. */
export function clearLastAction(): void {
  last = null;
}
