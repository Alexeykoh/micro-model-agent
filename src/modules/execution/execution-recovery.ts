/**
 * Сборка recovery-сообщения для модели (execution-плагин).
 *
 * Вынесено из `execution-plugin.ts` (правило 6): чистая сборка текста —
 * классификация причины + контекст последней ошибки компиляции.
 */
import { extractFileLikeTokens, stripUrls } from "../../core/hallucination/js-identifiers";

/** Контекст ошибки компиляции, который стоит показать модели. */
export interface RecoveryContext {
  /** Текст recovery-гайданса (по первичной причине). */
  recovery: string;
  /** Стабильная машиночитаемая классификация причины. */
  diagnostic?: string;
  /** Ошибки typecheck/compile, записанные за ход. */
  typecheckFailures: Map<string, string>;
  /** Описание текущего шага плана (для выбора относящейся ошибки). */
  stepDescription?: string;
}

/**
 * Собирает текст recovery-сообщения: сначала классификация причины, затем
 * гайданс и, если есть, последняя ошибка компиляции (модель должна знать, ПОЧЕМУ
 * застряла).
 */
export function buildRecoveryText(ctx: RecoveryContext): string {
  const { recovery, diagnostic, typecheckFailures, stepDescription } = ctx;
  let tscContext = "";
  if (typecheckFailures.size > 0) {
    if (stepDescription) {
      const stepFiles = extractFileLikeTokens(stripUrls(stepDescription));
      for (const [file, error] of typecheckFailures) {
        if (!file || stepFiles.some((f) => file.endsWith(f) || f.endsWith(file))) {
          tscContext = `\nLast compile error: ${error}`;
          break;
        }
      }
    }
    if (!tscContext) {
      const first = typecheckFailures.entries().next().value;
      if (first) tscContext = `\nLast compile error: ${first[1]}`;
    }
  }
  return `${diagnostic ? `${diagnostic}\n` : ""}${recovery}${tscContext}`;
}
