// JSON-документы `--json`-прогонов: результат и ошибка с диагностикой.
import type { AgentResult } from "../core/types";

/** Warn/error с шины вывода за `--json`-прогон. */
export interface JsonDiagnostic {
  level: string;
  source: string;
  text: string;
}

/**
 * Машиночитаемый документ завершённого `--json`-прогона. Массив `diagnostics`
 * несёт warn/error-события шины, погашенные человеческим каналом, чтобы
 * машинный потребитель видел провалы проб/конфига/безопасности.
 */
export function buildJsonResult(result: AgentResult, diagnostics: JsonDiagnostic[]) {
  return {
    success: result.success,
    text: result.text,
    error: result.error ?? null,
    iterationCount: result.iterationCount,
    contextUsed: result.contextUsed ?? null,
    contextLimit: result.contextLimit ?? null,
    promptTokens: result.promptTokens ?? null,
    completionTokens: result.completionTokens ?? null,
    totalTokens: result.totalTokens ?? null,
    totalCost: result.totalCost ?? null,
    costBreakdown: result.costBreakdown ?? [],
    cache: result.cache ?? null,
    diagnostics,
  };
}

/** Документ провала для throw, так и не давшего `AgentResult`. */
export function buildJsonError(error: string, diagnostics: JsonDiagnostic[] = []) {
  return {
    success: false,
    text: "",
    error,
    iterationCount: 0,
    diagnostics,
  };
}
