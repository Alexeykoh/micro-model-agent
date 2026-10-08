// Одноходовой раннер агента для `mma web`: матчинг id тул-событий, флаг прерывания, usage.
// Вынесен из `module.ts` (правило #1: ≤300 строк/файл).
import type { Agent } from "../../../core/agent";
import type { AgentResult, ToolEvent } from "../../../core/types";
import type { ToolCall, ToolResult } from "../../../tools/types";
import type { ExecutionModule } from "../../execution/module";
import { broadcast, type UsageSnapshot, type SessionStore, type RuntimeState, type SseTransport } from "../state";
import { pushState } from "./session-status";
import { captureUsage, liveContextUsage, planEventFor, type LiveContextSource } from "../host-state";
import { saveSessionUsage } from "./session-usage";
import type { Forwarder } from "./forward";

/**
 * Интервал live-бродкаста контекстных метрик во время хода. Достаточно часто,
 * чтобы бар «дышал» вместе с агентом, но не спамить SSE (клиент рисует только
 * при реальном изменении — сигнатура в `renderUsage`).
 */
const LIVE_USAGE_INTERVAL_MS = 800;

/** Входы раннера: агент, состояние, форвардер, сессия/план для сайдбара. */
export interface RunAgentDeps {
  agent: Agent;
  state: SessionStore & RuntimeState & SseTransport;
  forwarder: Forwarder;
  /** Сессия-владелец хода: штампуется в события и в per-session usage. */
  ownerSessionId: string;
  /**
   * Живая ссылка владельца текущего хода для дренажа его слота на `turn_end`.
   * Раннер ставит её на старте хода; форвардер читает в `onTurnEnd`.
   */
  ownerRef?: { current: string | null };
  execModule?: Pick<ExecutionModule, "getActivePlan">;
  /** Фолбэк лимита для usage сайдбара, когда ход лимит не сообщил. */
  contextWindow?: number;
  /** Живой контекст владельца: сайдбар обновляет заполнение по ходу, а не в конце. */
  contextManager?: LiveContextSource;
}

/** Раннер одного хода. */
export interface RunAgent {
  /** Гоняет один ход; владеет всеми его SSE-событиями для стартовой сессии. */
  run: (text: string) => Promise<unknown>;
}

/**
 * Сохраняет метрики завершённого хода: в per-session карту под владельцем
 * (сайдбар показывает метрики своей сессии, а не глобальный last-turn)
 * и в legacy-глобал для совместимости. Возвращает сохранённый снимок.
 */
function recordTurnUsage(
  state: SessionStore & RuntimeState & SseTransport,
  result: AgentResult,
  contextWindow: number | undefined,
  owner: string,
): UsageSnapshot {
  const usage = captureUsage(result, contextWindow);
  state.usage = usage;
  state.sessionUsage[owner] = usage;
  const dir = state.sessionManager?.getSessionDirectory?.(owner);
  if (dir) saveSessionUsage(dir, usage);
  return usage;
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
    ...(ev.imageRefs?.length ? { imageRefs: ev.imageRefs } : {}),
    ...(ev.images?.length ? { images: ev.images } : {}),
  });

  // `AgentResult` не несёт поля `interrupted`, а ход-раннер останавливают
  // через `agent.shutdown` напрямую (actions-api). Отдельный флаг не нужен.
  let toolCalls = 0;

  // Real-time метрики сайдбара: пока ход идёт, раз в ~800мс читаем живой
  // снапшот контекста владельца и шлём `usage`-событие (клиент мержит его в
  // свою вкладку без лишнего `/api/state`-рефетча). Возвращает стоп-функцию.
  const startLiveUsage = (owner: string): (() => void) => {
    const cm = deps.contextManager;
    if (!cm) return () => {};
    const tick = (): void => {
      try {
        const usage = liveContextUsage(state.sessionUsage[owner] ?? state.usage, cm);
        state.usage = usage;
        state.sessionUsage[owner] = usage;
        broadcast(
          { type: "usage", ts: Date.now(), sessionId: owner, usage, usageSessionId: owner },
          state,
        );
      } catch {
        /* fail-open: живой снимок не должен ронять ход */
      }
    };
    const timer = setInterval(tick, LIVE_USAGE_INTERVAL_MS);
    // Не держим процесс живым только ради таймера (Bun/Node).
    (timer as { unref?: () => void }).unref?.();
    tick(); // первый снимок сразу — сайдбар не ждёт 800мс
    return () => clearInterval(timer);
  };

  const run = async (text: string): Promise<unknown> => {
    toolCalls = 0;
    state.agentRunning = true;
    // Все события хода — за стартовавшей сессией, чтобы SSE лёг в правильную
    // вкладку, даже если пользователь переключил табы.
    const owner = deps.ownerSessionId;
    if (deps.ownerRef) deps.ownerRef.current = owner;
    state.activeSessionId = owner;
    const stopLiveUsage = startLiveUsage(owner);
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
      // Usage забираем ДО `pushState`, чтобы снапшот сразу после хода
      // нёс свежие метрики сайдбара.
      recordTurnUsage(state, result, deps.contextWindow, owner);
      forwarder.onTurnEnd({
        success: result.success,
        interrupted: result.interrupted || undefined,
        durationMs: result.durationMs,
        toolCalls,
      });
      pushState(state, owner);
      return result;
    } catch (err) {
      const interrupted = err instanceof Error && err.name === "AbortError";
      forwarder.onTurnEnd({ success: false, interrupted: interrupted || undefined });
      throw err;
    } finally {
      stopLiveUsage();
    }
  };

  return { run };
}
