import type { AgentResult } from "../core/types";

/** A warn/error captured from the output bus during a `--json` run. */
export interface JsonDiagnostic {
  level: string;
  source: string;
  text: string;
}

/**
 * Machine-readable result document for a completed `--json` run. The
 * `diagnostics` array carries the warn/error bus events the human channel
 * suppressed, so a machine consumer sees probe/config/security failures.
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

/** Failure document for a throw that never produced an `AgentResult`. */
export function buildJsonError(error: string, diagnostics: JsonDiagnostic[] = []) {
  return {
    success: false,
    text: "",
    error,
    iterationCount: 0,
    diagnostics,
  };
}
