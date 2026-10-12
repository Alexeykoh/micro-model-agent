/**
 * Нудж-механики тела цикла (`TurnCoordinator`, INV-23): учёт «перфекционизм-цикла»
 * по цели мутации и тест/спек-churn. Вынесено из `core/agent.ts`.
 */
import type { ToolCall } from "../../tools/types";
import type { LoopState } from "./loop-state";
import type { Logger } from "../../logger/app-logger";
import type { ContextManager } from "../context/manager";
import { recordArtifactWrite, testChurnFile } from "./artifact-progress";
import { isWorkMutation } from "../../modules/critic/evidence";
import { MUTATION_CYCLE_NUDGE_THRESHOLD } from "./constants";
import { t } from "../../i18n/index";

/**
 * Ключ целевого объекта мутации для детекции «перфекционизм-цикла».
 * edit_file/write_file → путь файла; bash → нормализованная команда.
 * Остальные тулы (read-only, bookkeeping) не считаются мутациями.
 * Внимание: в цикле toolCall.arguments — сырая JSON-строка от провайдера.
 */
export function mutationTargetKey(name: string, rawArgs: unknown): string | null {
  let a: Record<string, unknown> | null = null;
  if (typeof rawArgs === "string") {
    try {
      a = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (rawArgs && typeof rawArgs === "object") {
    a = rawArgs as Record<string, unknown>;
  }
  if (!a) return null;
  if ((name === "edit_file" || name === "write_file") && typeof a.path === "string") {
    return `write:${a.path.replace(/\\/g, "/").toLowerCase()}`;
  }
  if (name === "bash" && typeof a.command === "string") {
    const cmd = a.command.replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase();
    return cmd ? `bash:${cmd}` : null;
  }
  // Bookkeeping-churn: повторы plan/todo над тем же действием с чуть разными
  // аргументами сожгли 10+ итераций (модель «чинила» план вместо работы).
  if ((name === "plan" || name === "todo") && typeof a.action === "string") {
    return `book:${name}:${a.action.toLowerCase()}`;
  }
  // У plan_step нет action — ключ по status, чтобы повторные апдейты
  // били в тот же гард подряд-дубликатов.
  if (name === "plan_step" && typeof a.status === "string") {
    return `book:${name}:${a.status.toLowerCase()}`;
  }
  return null;
}

/**
 * Учитывает цели мутаций батча: прогресс артефактов, счётчики повторов и
 * `mutationsSinceCritic`. Возвращает цели, достигшие порога «перфекционизма».
 */
export function accumulateToolTargets(state: LoopState, toolCalls: ToolCall[]): string[] {
  const cycleNudges: string[] = [];
  for (const tc of toolCalls) {
    // Прогресс тест/спек-артефактов (обобщённо, по пути файла).
    if (
      (tc.name === "write_file" || tc.name === "edit_file") &&
      typeof tc.arguments.path === "string"
    ) {
      recordArtifactWrite(state.artifactChurn, tc.arguments.path);
    }
    const target = mutationTargetKey(tc.name, tc.arguments);
    if (!target) continue;
    const count = (state.toolTargetCounts.get(target) ?? 0) + 1;
    state.toolTargetCounts.set(target, count);
    if (count >= MUTATION_CYCLE_NUDGE_THRESHOLD && !state.cycleNudgedKeys.has(target)) {
      state.cycleNudgedKeys.add(target);
      cycleNudges.push(target);
    }
  }
  for (const tc of toolCalls) {
    if (isWorkMutation(tc.name)) state.mutationsSinceCritic++;
  }
  return cycleNudges;
}

/**
 * Нуджи после батча тулов (не ломая парность assistant(tool_calls) → tool(results)):
 * «перфекционизм-цикл» и тест/спек-churn.
 */
export function applyBatchNudges(
  state: LoopState,
  cycleNudges: string[],
  ctx: { logger: Logger; contextManager: ContextManager },
): void {
  const { logger, contextManager } = ctx;
  if (cycleNudges.length > 0) {
    logger.diagnostic(
      "info",
      `Perfectionism cycle detected (${cycleNudges.length} target(s) at ${MUTATION_CYCLE_NUDGE_THRESHOLD}+ mutations) — nudging model to finalize`,
    );
    contextManager.addMessage({
      role: "user",
      content: `<system-summary>You have already modified or re-run the same target many times (e.g. ${cycleNudges[0]}). If the latest output is correct, STOP polishing and answer with a final text response. More identical edits will not change the result.</system-summary>`,
    });
  }

  // Тест/спек-churn: серия правок тестов без единой production-правки.
  const churnFile = testChurnFile(state.artifactChurn);
  if (churnFile) {
    state.artifactChurn.nudged = true;
    logger.diagnostic(
      "info",
      `Test/spec artifact churn: "${churnFile}" repeatedly edited with no production changes — nudging to implement or change approach`,
    );
    contextManager.addMessage({
      role: "user",
      content: `<system-summary>${t("exec.test_churn_nudge", { file: churnFile })}</system-summary>`,
    });
  }
}
