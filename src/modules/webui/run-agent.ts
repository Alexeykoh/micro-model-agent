// Одноходовой раннер агента для `mma web`: матчинг id тул-событий, флаг прерывания, usage.
// Вынесен из `module.ts` (правило #1: ≤300 строк/файл).
import type { Agent } from "../../core/agent";
import type { ToolEvent } from "../../core/types";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { SessionManager } from "../../modules/session/manager";
import type { ExecutionModule } from "../../modules/execution/module";
import { broadcast, type WebUiState } from "./state";
import { captureUsage, planEventFor } from "./host-state";
import { cancelPendingQuestions } from "./prompt-io";
import type { Forwarder } from "./forward";

/** Входы раннера: агент, состояние, форвардер, сессия/план для сайдбара. */
export interface RunAgentDeps {
  agent: Agent;
  state: WebUiState;
  forwarder: Forwarder;
  sessionManager?: Pick<SessionManager, "getActiveMeta">;
  execModule?: Pick<ExecutionModule, "getActivePlan">;
  /** Фолбэк лимита для usage сайдбара, когда ход лимит не сообщил. */
  contextWindow?: number;
}

/** Раннер одного хода: запуск и прерывание. */
export interface RunAgent {
  /** Гоняет один ход; владеет всеми его SSE-событиями для стартовой сессии. */
  run: (text: string) => Promise<unknown>;
  /** Помечает прерванным, разблокирует висящие вопросы, стопает агента. */
  interrupt: () => void;
}

/** Строит раннер: матчинг id тул-событий, флаг прерывания, захват usage. */
export function makeRunAgent(deps: RunAgentDeps): RunAgent {
  const { agent, state, forwarder } = deps;

  // `ToolEvent` ориентирован на рендерер и id не несёт. Синтезируем по одному
  // на `start` и матчим на `end` (LIFO по имени тула), чтобы браузер спарил
  // карточки tool_start/tool_end.
  const pendingIds = new Map<string, string[]>();
  let toolSeq = 0;
  const startId = (tool: string): string => {
    const id = `t${++toolSeq}`;
    const stack = pendingIds.get(tool) ?? [];
    stack.push(id);
    pendingIds.set(tool, stack);
    return id;
  };
  const endId = (tool: string): string => pendingIds.get(tool)?.pop() ?? `t-stray-${++toolSeq}`;
  const callFor = (ev: ToolEvent, id: string): ToolCall => ({
    id,
    name: ev.tool,
    arguments: ev.args,
  });
  const resultFor = (ev: ToolEvent): ToolResult => ({
    success: !ev.error,
    output: ev.output ?? "",
  });

  // У `AgentResult` нет поля `interrupted`, а `agent.shutdown()` может вернуть
  // `success: true` — трекаем прерывание локально. REPL рвёт через
  // `agent.shutdown()` (repl.ts `interruptRun`); повторяем.
  let interrupted = false;
  let toolCalls = 0;

  const run = async (text: string): Promise<unknown> => {
    interrupted = false;
    toolCalls = 0;
    state.agentRunning = true;
    // Все события хода — за стартовавшей сессией, чтобы SSE лёг в правильную
    // вкладку, даже если пользователь переключил табы.
    state.activeSessionId = deps.sessionManager?.getActiveMeta()?.id;
    try {
      const result = await agent.run(
        text,
        (chunk) => forwarder.onText(chunk),
        (meta, kind) => forwarder.onMeta(meta, kind),
        (ev) => {
          if (ev.type === "start") {
            forwarder.onToolStart(callFor(ev, startId(ev.tool)));
          } else {
            toolCalls++;
            forwarder.onToolEnd(callFor(ev, endId(ev.tool)), resultFor(ev), ev.duration ?? 0);
            // Закончивший `plan`/`todo`-тул освежает план-карточку ленты; сайдбар
            // живёт своей проекцией `/api/state`.
            const plan = planEventFor(ev.tool, deps.execModule);
            if (plan) forwarder.onPlan(plan);
          }
        },
        (phase) => forwarder.onPhase(phase),
        (reasoning) => forwarder.onReasoning(reasoning),
      );
      // Usage забираем ДО `onTurnEnd`, чтобы бродкаст `state` сразу после хода
      // уже нёс свежие метрики сайдбара (клиент и так поллит `/api/state`,
      // так что это оптимизация, а не единственный путь).
      state.usage = captureUsage(result, deps.contextWindow);
      forwarder.onTurnEnd({
        success: result.success,
        durationMs: result.durationMs,
        toolCalls,
        interrupted: interrupted || undefined,
      });
      broadcast({ type: "state", ts: Date.now(), busy: state.busy, usage: state.usage }, state);
      return result;
    } catch (err) {
      forwarder.onTurnEnd({ success: false, interrupted: interrupted || undefined });
      throw err;
    }
  };

  const interrupt = (): void => {
    interrupted = true;
    // Разблокируем тулы, ждущие ответа браузера, до размотки хода.
    cancelPendingQuestions(state);
    agent.shutdown();
  };

  return { run, interrupt };
}
