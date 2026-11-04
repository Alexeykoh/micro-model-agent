// Execution-плагин: хуки цикла (stuck, план, typecheck, автопродвижение, веб-поиск ошибок).
// Оболочка-композиция: состояние (plugin-state), план/typecheck (plugin-plan),
// ход (plugin-think) и тулы (plugin-tool) вынесены по правилу 6.
import type { AgentPlugin } from "../types";
import type { ToolCall } from "../../tools/types";
import type { ExecutionPluginDeps } from "./plugin-state";
import { runBeforeThink } from "./plugin-think";
import { runAfterTool, runBeforeTool, runToolCall } from "./plugin-tool";

export { parseBrokenFile, extractBrokenFiles, type BrokenFile } from "./broken-files";
export { STUCK_RECOVERY_COOLDOWN, STUCK_WARN_REPEAT_EVERY } from "./plugin-state";
export type { ExecutionPluginState, ExecutionPluginDeps } from "./plugin-state";
export { stepTypecheckGate } from "./plugin-plan";

/**
 * Хуки execution-плагина, вынесенные дословно из ExecutionModule.getPlugin().
 * Всё разделяемое мутабельное состояние (pendingMessages, forbiddenBashFailures,
 * state, tracker) принадлежит модулю и мутируется по ссылке через `deps`.
 */
export function createExecutionPlugin(deps: ExecutionPluginDeps): AgentPlugin {
  return {
    name: "execution",
    description: "plan tracking, stuck-turn recovery and turn audit",
    onBeforeThink: (ctx: any) => runBeforeThink(deps, ctx),
    onBeforeTool: (_ctx: any, call: ToolCall) => runBeforeTool(deps, call),
    onToolCall: (ctx: any) => runToolCall(deps, ctx),
    onAfterTool: (ctx: any, call: any, result: any) => runAfterTool(deps, ctx, call, result),
    // Граница хода: завершённый авто-advance'ом план архивируется здесь, а не
    // посреди работы (модель не видит «нет активного плана» в своём же ходу).
    // Флаг мутаций сбрасывается здесь же: бюджет финального аудита — на ход.
    onTurnEnd: () => {
      deps.archiveCompletedPlan();
      deps.state.mutatedThisTurn = false;
    },
  };
}
