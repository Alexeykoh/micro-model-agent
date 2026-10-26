// Диагноз повторных падений тула: промах модели, конкретная причина или systemic.

/** Диагноз повторных падений тула для записи в память. */
export interface RepeatedFailureDiagnosis {
  /** true — промах модели, а не системы: в глобальную память не писать. */
  skip: boolean;
  cause: string;
  solution: string;
}

/**
 * Диагноз по сигнатуре ошибок (ses_mup6p61q): раньше в память шёл boilerplate
 * («проверьте зависимости») и туда же попадали собственные промахи модели
 * (несуществующий путь теста как «системная проблема bash»).
 * - bash с «не найдено/не сматчилось» по именованной моделью цели → skip;
 * - edit_file «строка не найдена» → гипотеза расхождения якоря (CRLF/устаревшее
 *   чтение), а не сломанный тул;
 * - остальное → запись с наблюдаемыми заголовками ошибок.
 */
export function diagnoseRepeatedFailures(
  tool: string,
  headlines: string[],
): RepeatedFailureDiagnosis {
  const genericCause =
    "Repeated failures suggest a systemic problem (config, environment, or a broken tool), not a one-off";
  const genericSolution =
    "Check the error message, verify the tool's dependencies are installed/configured, and consider a different tool";

  const modelMiss =
    tool === "bash"
      ? [/did not match any test files?/i, /no such file/i, /cannot find (the )?path/i]
      : [];
  if (
    headlines.length > 0 &&
    headlines.every(
      (h) => /^\(exit code \d+\)$/.test(h.trim()) || modelMiss.some((re) => re.test(h)),
    )
  ) {
    return {
      skip: true,
      cause: "Model named a wrong target (path/filter); the tool itself works",
      solution: "Re-check the target path or filter instead of blaming the tool",
    };
  }

  if (tool === "edit_file" && headlines.some((h) => /string not found|не найдена/i.test(h))) {
    return {
      skip: false,
      cause:
        "Anchor mismatch between the model anchor and file content — often CRLF vs LF line endings or a stale read, not a broken tool",
      solution:
        "Re-read the exact block with read_file and retry with a short unique single-line anchor",
    };
  }

  return { skip: false, cause: genericCause, solution: genericSolution };
}
