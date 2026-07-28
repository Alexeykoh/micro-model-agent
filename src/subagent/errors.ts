/** Паттерны ошибок которые НЕ триггерят specialist (trivial) */
export const TRIVIAL_ERROR_PATTERNS = [
  /no results? found/i,
  /pattern .* matched 0 results/i,
  /0 files? matched/i,
  /command not found.*grep/i,
  /not a directory/i,
];

/** Паттерны ошибок которые ВСЕГДА требуют specialist (не trivial) */
export const NON_TRIVIAL_ERROR_PATTERNS = [
  /unexpected token/i,
  /syntaxerror/i,
  /cannot find module/i,
  /module not found/i,
  /permission denied/i,
  /enoent/i,
  /eacces/i,
];

/**
 * Проверяет является ли ошибка тривиальной (не требует specialist).
 *
 * @param toolName - имя инструмента
 * @param errorOutput - текст ошибки
 * @returns true если ошибка тривиальная
 */
export function isTrivialError(toolName: string, errorOutput: string): boolean {
  // Синтаксические и критические ошибки — ВСЕГДА не trivial
  if (NON_TRIVIAL_ERROR_PATTERNS.some((p) => p.test(errorOutput))) {
    return false;
  }

  // grep_search/glob_search с 0 результатами — нормальное поведение
  if (toolName === "grep_search" || toolName === "glob_search") {
    if (
      /0 results|0 files|no match/i.test(errorOutput) &&
      errorOutput.length < 200
    ) {
      return true;
    }
  }
  // Любая ошибка < 10 символов — скорее всего trivia
  if (errorOutput.length < 10) return true;

  return TRIVIAL_ERROR_PATTERNS.some((p) => p.test(errorOutput));
}

/**
 * Контекст для specialist'а — фокусированное описание ошибки.
 *
 * @param toolName - имя упавшего инструмента
 * @param toolArgs - аргументы которые были переданы
 * @param errorOutput - текст ошибки
 * @param userTask - исходный запрос пользователя (краткое описание)
 * @param attemptCount - сколько раз ошибка повторилась
 * @returns Текст задачи для specialist'а
 */
export function buildSpecialistTask(
  toolName: string,
  toolArgs: Record<string, unknown>,
  errorOutput: string,
  userTask: string,
  attemptCount: number,
): string {
  const argsStr = JSON.stringify(toolArgs, null, 2);

  // Специфичные подсказки для web_browse evaluate
  let webHints = "";
  if (toolName === "web_browse" && String(toolArgs?.action) === "evaluate") {
    const code = String(toolArgs?.value ?? toolArgs?.code ?? "");
    webHints = [
      "",
      'web_browse evaluate: "value" is JS code executed in browser context.',
      "- return statements work: return document.title",
      `- Current code that failed: ${code.slice(0, 300)}`,
    ].join("\n");
  }

  return [
    `The tool "${toolName}" has failed ${attemptCount} times with the same error while working on: "${userTask.slice(0, 200)}"`,
    "",
    `Failed tool call:`,
    `  Tool: ${toolName}`,
    `  Arguments: ${argsStr}`,
    "",
    `Error output:`,
    `  ${errorOutput.slice(0, 500)}`,
    webHints,
    "",
    `Your task: Diagnose WHY this tool call fails and FIX the underlying problem.`,
    `  - Read the relevant files to understand the actual state`,
    `  - Fix the root cause (wrong path, missing file, syntax error, etc.)`,
    `  - If the tool call arguments are wrong, correct them`,
    `  - If the file doesn't exist, create it`,
    `  - Return a clear summary of what you found and what you fixed`,
  ].join("\n");
}
