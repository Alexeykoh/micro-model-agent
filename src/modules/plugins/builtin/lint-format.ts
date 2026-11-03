// Advisory-текст, который lint-плагин дописывает в вывод write/edit:
// ошибки синтаксиса, проектного lint и typecheck, результат автофикса.
// Формат блоков — часть контракта с моделью: держим его в одном месте.

/** Сколько последних непустых строк вывода линтера показывать модели. */
const LINT_DETAIL_TAIL_LINES = 5;

/** Хвост вывода линтера: последние непустые строки — самая полезная часть. */
function lintFailureDetail(combined: string): string {
  return combined.trim().split("\n").filter(Boolean).slice(-LINT_DETAIL_TAIL_LINES).join("\n");
}

export function syntaxFailureBlock(error: string): string {
  return `\n\n[Syntax check failed]: ${error}`;
}

export function lintFailureBlock(combined: string): string {
  return `\n\n[Project lint failed]: ${lintFailureDetail(combined)}`;
}

export function typecheckFailureBlock(error: string): string {
  return `\n\n[Project typecheck failed]: ${error}`;
}

export function autoFixedBlock(applied: string[]): string {
  return `\n\n[Auto-fixed]: ${applied.join("; ")}`;
}

export function remainingErrorsBlock(errors: Array<{ code: number; message: string }>): string {
  const lines = errors.map((e) => `TS${e.code}: ${e.message}`).join("\n");
  return `\n\n[Remaining errors]: ${lines}`;
}
