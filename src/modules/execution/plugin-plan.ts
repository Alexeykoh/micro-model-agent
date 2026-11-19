// Плановая и typecheck-логика execution-плагина (вынесено из
// `execution-plugin.ts`, правило 6): nudge создания плана, учёт мутаций без
// плана, пофайловые compile-фейлы и авто-детект delete-намерения.
import { t } from "../../i18n/index";
import { extractFileLikeTokens, stripUrls } from "../../core/hallucination/js-identifiers";
import { bashMutatesFiles } from "./bash-mutation";
import { extractBrokenFiles, normalizeBrokenPath } from "./broken-files";
import { switchStepToDelete } from "./plan-steps";
import {
  PLAN_NUDGE_THRESHOLD,
  type ExecutionPluginDeps,
  type ExecutionThinkContext,
} from "./plugin-state";
import type { ToolCall, ToolResult } from "../../tools/types";

/**
 * Гейт для `plan update status=done`: реджектит, пока последний write/edit
 * репортит compile-ошибку. Фейл без привязки к файлу блокирует весь проект;
 * иначе именованные токены файлов шага матчатся против битых (суффикс пути,
 * регистронезависимо). Шаг без файлов обвинить не в чем — его done остаётся
 * vacuous. Возвращает первую ошибку для показа модели, или null чтобы пустить.
 */
export function stepTypecheckGate(
  failures: ReadonlyMap<string, string>,
  stepDescription: string,
): string | null {
  if (failures.size === 0) return null;
  const projectError = failures.get("");
  if (projectError) return projectError;
  const stepTokens = extractFileLikeTokens(stripUrls(stepDescription)).map((p) =>
    normalizeBrokenPath(p).toLowerCase(),
  );
  if (stepTokens.length === 0) return null;
  for (const [file, err] of failures) {
    const f = normalizeBrokenPath(file).toLowerCase();
    if (stepTokens.some((tok) => f.endsWith(tok) || tok.endsWith(f))) return err;
  }
  return null;
}

/**
 * Evidence-based nudge плана (правило #10 — без голого счётчика итераций,
 * без keyword-классификации задач): только когда агент реально сделал
 * файл-мутирующие вызовы (write/edit/bash/download) без плана, ему нужен план.
 */
export function nudgePlanIfNeeded(deps: ExecutionPluginDeps, ctx: ExecutionThinkContext): void {
  const mutations = deps.state.mutationsWithoutPlan;
  if (mutations >= PLAN_NUDGE_THRESHOLD && !deps.state.planNudgeSent && ctx.contextManager) {
    deps.state.planNudgeSent = true;
    ctx.contextManager.addMessage({
      role: "user",
      content: `<system-summary>${t("exec.plan_nudge", {
        count: String(mutations),
      })}</system-summary>`,
    });
  }
}

/**
 * Считаем файл-мутирующие вызовы БЕЗ активного плана — питают
 * evidence-based nudge создания плана. Для bash судим по команде:
 * `docker ps`/`ls` — чтение, а не «изменяющие файлы»
 * (гвард: tests/modules/execution/plan-nudge-mutation.test.ts).
 */
export function recordPlanMutation(
  deps: ExecutionPluginDeps,
  toolName: string,
  args: Record<string, unknown>,
): void {
  if (deps.trackerRef.current) return;
  const isFileTool =
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "download_file" ||
    toolName === "delete_file" ||
    toolName === "move_file";
  const isBashWrite =
    toolName === "bash" &&
    bashMutatesFiles(typeof args.command === "string" ? args.command : "");
  if (isFileTool || isBashWrite) deps.state.mutationsWithoutPlan++;
}

/**
 * Трекаем compile-фейлы пофайлово: done-gate плана реджектит "done", пока
 * последняя правка не компилируется (было: агент маркил шаги done, а
 * проектный typecheck фейлился на каждой записи — каскад "починю позже").
 * ЧИСТЫЙ результат чистит карту: дебаунснутый проектный tsc перегнал и
 * прошёл (или tsconfig неприменим) — старые фейлы завершение вечно не
 * блокируют.
 */
export function recordTypecheckOutcome(
  deps: ExecutionPluginDeps,
  call: ToolCall,
  result: ToolResult,
  toolText: string,
): void {
  if (call.name !== "write_file" && call.name !== "edit_file") return;
  const broken = extractBrokenFiles(toolText);
  if (broken.length > 0) {
    for (const b of broken) deps.state.typecheckFailures.set(b.file, b.error);
  } else if (result.success) {
    // Чистим только записи только что писанного/правленного файла (и
    // проектную безадресную запись, которую чистая правка вероятно
    // закрыла). Сплошной `.clear()` стирал несвязанный успешной правкой
    // чужой фейл, обходя done-gate.
    const edited = normalizeBrokenPath(String(call.arguments?.path ?? ""));
    for (const key of [...deps.state.typecheckFailures.keys()]) {
      if (
        key === "" ||
        !edited ||
        key === edited ||
        key.endsWith(edited) ||
        edited.endsWith(key)
      ) {
        deps.state.typecheckFailures.delete(key);
      }
    }
  }
}

/**
 * Авто-детект delete-намерения из действий модели: при вызове delete_file
 * находим совпадающий шаг плана и ставим kind="delete". Языконезависимо —
 * по СДЕЛАННОМУ моделью, не по сказанному.
 */
export function autoMarkDeletedStep(
  deps: ExecutionPluginDeps,
  call: ToolCall,
  result: ToolResult,
): void {
  if (call.name !== "delete_file" || !result.success || !deps.trackerRef.current) return;
  const deletedPath = String(call.arguments?.path ?? "");
  if (!deletedPath) return;
  const plan = deps.trackerRef.current.getPlan();
  const tokens = extractFileLikeTokens(stripUrls(deletedPath));
  for (const step of plan.steps) {
    if (step.status !== "pending" && step.status !== "in_progress") continue;
    const stepTokens = extractFileLikeTokens(stripUrls(step.description));
    const overlap = tokens.some((tok) =>
      stepTokens.some((st) => tok.endsWith(st) || st.endsWith(tok)),
    );
    if (overlap) {
      switchStepToDelete(plan, step, (p) => deps.store.saveActive(p));
      break;
    }
  }
}
