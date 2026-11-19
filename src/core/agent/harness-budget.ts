// Прогноз completion-бюджета до вызова (INV-H1): крупные файловые задачи
// получают повышенный бюджет сразу, а не после первого обрыва. Чистая
// функция — гейт в tests/harness-budgets.test.ts.

/** Пороги: суммарный chars прогноза → бюджет. */
export const PREDICTIVE_BUDGET_SMALL = 8192;
export const PREDICTIVE_BUDGET_LARGE = 16384;

/** Признаки задачи, требующей крупного вывода (файлы, каталог, данные). */
const LARGE_OUTPUT_HINTS =
  /(write_file|append_file|создай|create|напиши|write|файл|file|страница|page|каталог|catalog|products|данные|data|компонент|component|spec|спецификац|deploy|build|scaffold|next\.js|верстк)/i;

function taskText(input: string, historyHint?: string): string {
  return historyHint ? `${input} ${historyHint}` : input;
}

/**
 * Прогноз бюджета для вызова: если задача/история требует крупного вывода —
 * 16384, иначе undefined (дефолт провайдера). Явный override (например,
 * удвоение после обрыва до ответа) побеждает прогноз: прогноз заполняет
 * бюджет только когда ничего явного не выставлено.
 */
export function predictMaxTokens(
  input: string,
  opts: { existingOverride?: number; historyHint?: string } = {},
): number | undefined {
  if (opts.existingOverride !== undefined) return opts.existingOverride;
  const text = taskText(input, opts.historyHint);
  if (!LARGE_OUTPUT_HINTS.test(text)) return undefined;
  return Math.min(PREDICTIVE_BUDGET_LARGE, 32000);
}
