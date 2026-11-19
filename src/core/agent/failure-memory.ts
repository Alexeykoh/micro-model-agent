// Запись повторных падений тулов в глобальную память: дедуп и порог systemic.
import { t } from "../../i18n/index";
import type { Logger } from "../../logger/app-logger";
import type { MemoryStore } from "../../modules/memory/store";
import type { ToolCall } from "../types";
import type { ToolResult } from "../../tools/types";
import type { ContextManager } from "../context/manager";
import type { LoopState } from "./loop-state";
import { issueDirective } from "./directives";
import { diagnoseRepeatedFailures } from "./failure-diagnosis";
import {
  MAX_TOOL_FAILURES_PER_TURN,
  MIN_REPEATED_TOOL_FAILURES,
} from "./constants";

/** Информационные тулы: их «Not found» — ожидаемый ответ, не поломка. */
const INFO_TOOLS = new Set(["file_info"]);
/** Транзиентные сетевые тулы: 404/TLS не systemic. */
const TRANSIENT_TOOLS = new Set(["web_fetch", "web_search", "web_browse"]);

export interface FailureMemoryDeps {
  memoryStore?: MemoryStore;
  contextManager: ContextManager;
  logger: Logger;
}

/** Сколько разных тулов падало в этом ходе (для порога systemic). */
export function countDistinctFailingTools(state: LoopState): number {
  let count = 0;
  for (const entry of state.toolFailureCounts.values()) if (entry.count > 0) count++;
  return count;
}

/**
 * Учёт общих неудач тула (не только подряд): правило в память при накоплении.
 * Транзиентные/информационные тулы исключены. Общий «systemic» вывод пишется
 * только при ≥3 разных падающих тулах — одна сломанная команда или аргумент
 * не должна отравлять память.
 */
export function recordRepeatedToolFailure(
  state: LoopState,
  call: ToolCall,
  result: ToolResult,
  deps: FailureMemoryDeps,
): void {
  if (
    result.success ||
    result.blocked ||
    INFO_TOOLS.has(call.name) ||
    TRANSIENT_TOOLS.has(call.name)
  ) {
    return;
  }
  const key = call.name;
  const prev = state.toolFailureCounts.get(key) ?? { count: 0, error: "", samples: [] };
  prev.count++;
  const errText = String(result.output ?? "");
  prev.error = errText.slice(0, 200);
  const headline = errText.split("\n")[0].slice(0, 160).trim();
  if (headline && !prev.samples.includes(headline) && prev.samples.length < 3) {
    prev.samples.push(headline);
  }
  state.toolFailureCounts.set(key, prev);

  // Мёртвый тул отключаем на остаток хода (счётчик суммарный, не стрик).
  if (prev.count >= MAX_TOOL_FAILURES_PER_TURN && !state.toolDisabledNudged.has(key)) {
    state.toolDisabledNudged.add(key);
    state.disabledTools.add(key);
    deps.logger.diagnostic(
      "warn",
      `Tool ${key} failed ${prev.count}x — disabling it for the rest of the turn`,
    );
    issueDirective(deps.contextManager, "tool_disabled", t("exec.tool_disabled", { tool: key }));
  }

  if (prev.count < MIN_REPEATED_TOOL_FAILURES || state.memoryRuleRecorded.has(key)) return;
  const diagnosis = diagnoseRepeatedFailures(key, prev.samples);
  if (diagnosis.skip) return;

  state.memoryRuleRecorded.add(key);
  if (deps.memoryStore) {
    deps.memoryStore.appendRule(
      "errors",
      `Tool ${key} failed ${prev.count}x (${prev.samples.join(" | ") || prev.error})`,
      diagnosis.cause,
      diagnosis.solution,
    );
    deps.logger.diagnostic("warn", `Recorded repeated ${key} failures to memory (${prev.count}x)`);
  }
}
